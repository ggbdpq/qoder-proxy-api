// Adversarial Review Loop 闭环测试：审查发现的边界场景逐条锁定。
// 每个用例对应 docs/06 已知缺口或审查记录中的一条。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { GatewayProvider } from "../../src/providers/gateway/index.ts";
import { GatewayAuth } from "../../src/providers/gateway/auth.ts";
import { CloudAgentsClient, SessionStore } from "../../src/providers/cloudAgents/client.ts";
import { normalizeCloudBaseUrl } from "../../src/providers/cloudAgents/config.ts";
import { CloudAgentsProvider } from "../../src/providers/cloudAgents/index.ts";
import { aggregateStream } from "../../src/core/aggregate.ts";
import { ProviderError } from "../../src/core/errors.ts";
import type { CanonicalRequest } from "../../src/core/request.ts";

const request: CanonicalRequest = {
  model: "auto",
  messages: [{ role: "user", content: "hi" }],
};

// 认证与目录正常应答、仅聊天流端点返回 200 空 body 的假上游——
// 精确命中 stream 层的空 body 分支（auth 交换不受干扰）。
async function emptyChatBodyUpstream(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://fake").pathname;
      const json = (body: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (pathname.includes("model/list")) {
        json({ chat: [{ key: "auto", display_name: "Auto", enable: true, is_default: true }] });
        return;
      }
      if (pathname.includes("jobToken")) {
        json({
          name: "fake-user",
          id: "uid_1",
          userType: "personal_standard",
          securityOauthToken: "sot_1",
          refreshToken: "rt_1",
          expireTime: Date.now() + 60_000,
        });
        return;
      }
      res.writeHead(200); // 聊天流：200 空正文
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, close: () => server.close() });
    });
  });
}

test("gateway auth: failed refresh fallback surfaces as PROVIDER_AUTH_ERROR", async () => {
  // 先用正常上游换得会话；随后上游变为永久网络错误且会话已过期——
  // renew 的 refresh 与 cold-exchange 回退都会失败，错误必须走统一 AUTH 通道。
  let upstreamDown = false;
  const fake = http.createServer((_req, res) => {
    if (upstreamDown) {
      res.destroy();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        name: "fake-user",
        id: "uid_1",
        userType: "personal_standard",
        securityOauthToken: "sot_1",
        refreshToken: "rt_1",
        expireTime: Date.now() + 60_000,
      }),
    );
  });
  fake.listen(0, "127.0.0.1");
  await once(fake, "listening");
  const { port } = fake.address() as AddressInfo;

  const auth = new GatewayAuth({
    pat: "demo-pat",
    requestTimeoutMs: 5000,
    fetchImpl: (url, init) => {
      const target = new URL(url as string | URL);
      return fetch(`http://127.0.0.1:${port}${target.pathname}${target.search}`, init);
    },
  });

  const session = await auth.ensureSession();
  assert.ok(session.refreshToken, "precondition: session carries a refresh token");
  upstreamDown = true;
  auth.session!.expireTimeMs = Date.now() - 1; // 强制 needsRefresh

  await assert.rejects(auth.ensureSession(), (error: unknown) => {
    return error instanceof ProviderError && error.code === "PROVIDER_AUTH_ERROR";
  });
  fake.close();
});

test("gateway stream: 200 with an empty body ends cleanly (undici yields an empty stream)", async () => {
  const upstream = await emptyChatBodyUpstream();
  try {
    const provider = new GatewayProvider({
      pat: "demo-pat",
      fetchImpl: (url, init) => {
        const target = new URL(url as string | URL);
        return fetch(`http://127.0.0.1:${upstream.port}${target.pathname}${target.search}`, init);
      },
      requestTimeoutMs: 5000,
    });
    // 实测行为：undici 对无 body 的 200 给出空 ReadableStream（非 null），
    // 流应干净结束而不是抛 TypeError；真正的 null body（如 204）由
    // openStreamLines 的显式检查兜底为 PROVIDER_PROTOCOL_ERROR。
    await assert.doesNotReject(
      aggregateStream(
        provider.stream(request, { requestId: "r1", signal: new AbortController().signal }),
      ),
    );
  } finally {
    upstream.close();
  }
});

test("cloudAgents stream: 200 with an empty body ends cleanly", async () => {
  // 三路径分支：建会话与发消息正常应答，仅事件流端点返回 200 空 body——
  // 精确命中 streamEvents 的空 body 分支。
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://fake").pathname;
    if (pathname === "/api/v1/cloud/sessions" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "sess_1" }));
      return;
    }
    if (pathname.endsWith("/events") && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (pathname.endsWith("/events/stream")) {
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const client = new CloudAgentsClient({
      baseUrl: normalizeCloudBaseUrl(`http://127.0.0.1:${port}`),
      accessToken: "demo",
      requestTimeoutMs: 5000,
    });
    const provider = new CloudAgentsProvider({
      client,
      sessionStore: new SessionStore({ ttlMs: 600000 }),
      modelMap: { demo: { modelId: "m", agentId: "a", environmentId: "e" } },
    });
    await assert.doesNotReject(
      aggregateStream(
        provider.stream(
          { model: "demo", messages: [{ role: "user", content: "hi" }] } as CanonicalRequest,
          { requestId: "r1", signal: new AbortController().signal },
        ),
      ),
    );
  } finally {
    server.close();
  }
});
