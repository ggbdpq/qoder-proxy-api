// 上游请求超时的跨链路语义：两条 HTTP 链路对「上游在 requestTimeoutMs 内
// 无响应」都必须给出 PROVIDER_TIMEOUT，调用方才能区分超时与不可用。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { GatewayProvider } from "../../src/providers/gateway/index.ts";
import { CloudAgentsClient, SessionStore } from "../../src/providers/cloudAgents/client.ts";
import { CloudAgentsProvider } from "../../src/providers/cloudAgents/index.ts";
import { aggregateStream } from "../../src/core/aggregate.ts";
import { ProviderError } from "../../src/core/errors.ts";
import type { CanonicalRequest } from "../../src/core/request.ts";

// 收到请求后永不响应的假上游：触发客户端 requestTimeoutMs。
// close 时强拆全部连接——fetch abort 后 undici keep-alive 池仍持有 socket，
// 不销毁会让 node --test 进程挂住不退出。
function createSilentUpstream(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const sockets = new Set<import("node:net").Socket>();
    const server = http.createServer(() => {
      /* 故意不响应 */
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        close: () => {
          server.close();
          for (const socket of sockets) socket.destroy();
        },
      });
    });
  });
}

// gateway 用兜底目录里存在的 key：silent 上游时目录拉取失败会静默兜底（既有语义），
// 模型解析不该先于认证交换把超时掩盖成 MODEL_NOT_FOUND。
const gatewayRequest: CanonicalRequest = {
  model: "auto",
  messages: [{ role: "user", content: "hi" }],
};

const cloudRequest: CanonicalRequest = {
  model: "demo",
  messages: [{ role: "user", content: "hi" }],
};

test("gateway: silent upstream maps to PROVIDER_TIMEOUT", async () => {
  const upstream = await createSilentUpstream();
  try {
    const provider = new GatewayProvider({
      pat: "demo-pat",
      fetchImpl: (url, init) => {
        const target = new URL(url as string | URL);
        return fetch(`http://127.0.0.1:${upstream.port}${target.pathname}${target.search}`, init);
      },
      requestTimeoutMs: 50,
    });
    await assert.rejects(
      aggregateStream(
        provider.stream(gatewayRequest, { requestId: "r1", signal: new AbortController().signal }),
      ),
      (error: unknown) => error instanceof ProviderError && error.code === "PROVIDER_TIMEOUT",
    );
  } finally {
    upstream.close();
  }
});

test("cloudAgents: silent upstream maps to PROVIDER_TIMEOUT", async () => {
  const upstream = await createSilentUpstream();
  try {
    const client = new CloudAgentsClient({
      baseUrl: `http://127.0.0.1:${upstream.port}`,
      accessToken: "demo",
      requestTimeoutMs: 50,
    });
    const provider = new CloudAgentsProvider({
      client,
      sessionStore: new SessionStore({ ttlMs: 600000 }),
      modelMap: { demo: { modelId: "m", agentId: "a", environmentId: "e" } },
    });
    await assert.rejects(
      aggregateStream(
        provider.stream(cloudRequest, { requestId: "r1", signal: new AbortController().signal }),
      ),
      (error: unknown) => error instanceof ProviderError && error.code === "PROVIDER_TIMEOUT",
    );
  } finally {
    upstream.close();
  }
});
