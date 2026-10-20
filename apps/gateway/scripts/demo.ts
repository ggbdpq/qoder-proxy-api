#!/usr/bin/env node
// npm run demo —— 无凭证离线演示：三条 Provider 链路 × 三个下游协议。
// 上游替换为本地 fake（复用 test/ 的 fixtures SSE 抓包），server、协议序列化、
// 模型路由走的都是生产代码路径；唯一的不同是网络层被本地假服务器替代，
// 因此不需要 Qoder 账号、不需要 API Key，clone 后一条命令即可看到流式 wire。

import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createFakeGateway } from "../test/helpers/fakeGateway.ts";
import { createFakeCloud } from "../test/helpers/fakeCloud.ts";
import { createServer } from "../src/server/server.ts";
import { createProviderRegistry } from "../src/routing/providerRegistry.ts";
import { parseModelRoutes } from "../src/routing/modelRouter.ts";
import { GatewayProvider } from "../src/providers/gateway/index.ts";
import { CliProvider } from "../src/providers/cli/index.ts";
import { CloudAgentsClient, SessionStore } from "../src/providers/cloudAgents/client.ts";
import { CloudAgentsProvider } from "../src/providers/cloudAgents/index.ts";
import { normalizeCloudBaseUrl } from "../src/providers/cloudAgents/config.ts";
import { loadConfig } from "../src/config.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");

async function listenOnRandomPort(server: import("node:http").Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

// 把一条流式响应的原始 wire 打到终端（SSE 事件块原样，含 [DONE]）。
async function streamToConsole(
  label: string,
  request: { path: string; body: Record<string, unknown> },
  port: number,
): Promise<void> {
  const line = "─".repeat(72);
  console.log(`\n${line}`);
  console.log(`▶ ${label}`);
  console.log(`  POST http://127.0.0.1:${port}${request.path}`);
  console.log(`  ${JSON.stringify(request.body)}`);
  console.log(line);

  const response = await fetch(`http://127.0.0.1:${port}${request.path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer demo-key" },
    body: JSON.stringify(request.body),
  });
  console.log(`◀ HTTP ${response.status} ${response.headers.get("content-type") ?? ""}\n`);
  if (!response.body) throw new Error(`empty body: HTTP ${response.status}`);
  const decoder = new TextDecoder();
  for await (const chunk of response.body)
    process.stdout.write(decoder.decode(chunk, { stream: true }));
  console.log();
}

async function main(): Promise<void> {
  console.log("qoder-proxy-api 离线 demo：fake 上游已就位，生产 server 全链路处理。\n");

  // 1. 两个 HTTP 假上游（gateway 私有协议 / cloudAgents 官方 API）；cli 链路的
  //    fake 是可执行脚本（fakeCli.ts），由 CliProvider 以子进程方式拉起。
  const fakeGateway = createFakeGateway({ sseFixture: "text.sse" });
  const fakeCloud = createFakeCloud({ fixture: "deltas.sse" });
  const gatewayPort = await listenOnRandomPort(fakeGateway);
  const cloudPort = await listenOnRandomPort(fakeCloud);

  // 2. 三条链路的 Provider 与模型路由（显式路由是唯一路由方式）。
  const registry = createProviderRegistry();
  registry.register(
    new GatewayProvider({
      pat: "demo-pat",
      // fetchImpl 重写上游地址：逻辑与生产完全一致，只有网络目的地不同。
      fetchImpl: (url, init) => {
        const target = new URL(url as string | URL);
        return fetch(`http://127.0.0.1:${gatewayPort}${target.pathname}${target.search}`, init);
      },
      requestTimeoutMs: 10000,
    }) as never,
  );
  registry.register(
    new CliProvider({
      cliConfig: {
        nodePath: process.execPath,
        bin: path.join(repoRoot, "test", "helpers", "fakeCli.ts"),
        model: "",
        workspace: "",
        timeoutMs: 10000,
      },
    }) as never,
  );
  const cloudClient = new CloudAgentsClient({
    baseUrl: normalizeCloudBaseUrl(`http://127.0.0.1:${cloudPort}`),
    accessToken: "demo-access-token",
    requestTimeoutMs: 10000,
  });
  const cloudSessions = new SessionStore({ ttlMs: 600000 });
  registry.register(
    new CloudAgentsProvider({
      client: cloudClient,
      sessionStore: cloudSessions,
      modelMap: {
        demo: {
          modelId: "demo-model",
          agentId: "demo-agent",
          environmentId: "demo-env",
          title: "Demo Model",
        },
      },
      archiveEphemeralSessions: false,
    }) as never,
  );

  const modelRoutes = parseModelRoutes({
    routesJson: JSON.stringify({
      "demo-gateway": { provider: "gateway", model: "auto" },
      "demo-cli": { provider: "cli", model: "demo" },
      "demo-cloud": { provider: "cloudAgents", model: "demo" },
    }),
  });

  // 3. 生产 server：与 npm start 同一条代码路径。
  const server = createServer(loadConfig(), {
    providerRegistry: registry,
    modelRoutes,
    defaultProviderId: "gateway",
    qoderClient: cloudClient,
    sessionStore: cloudSessions,
  });
  const port = await listenOnRandomPort(server);

  // 4. 三个下游协议各发一路流式请求，wire 原样输出。
  await streamToConsole(
    "OpenAI Chat Completions → gateway 链路（私有协议：PAT→jobToken→签名 SSE）",
    {
      path: "/v1/chat/completions",
      body: {
        model: "demo-gateway",
        stream: true,
        messages: [{ role: "user", content: "用一句话介绍你自己" }],
      },
    },
    port,
  );
  await streamToConsole(
    "OpenAI Responses → cli 链路（本地 qodercli 子进程 stream-json）",
    {
      path: "/v1/responses",
      body: { model: "demo-cli", stream: true, input: "用一句话介绍你自己" },
    },
    port,
  );
  await streamToConsole(
    "Anthropic Messages → cloudAgents 链路（官方 API SSE）",
    {
      path: "/v1/messages",
      body: {
        model: "demo-cloud",
        stream: true,
        max_tokens: 64,
        messages: [{ role: "user", content: "用一句话介绍你自己" }],
      },
    },
    port,
  );

  // 5. 收尾：打印 fake 上游记录到的真实交互计数。
  console.log("─".repeat(72));
  console.log(
    `上游交互统计：gateway jobToken 交换 ${fakeGateway.state.jobTokenRequests} 次、` +
      `聊天 SSE ${fakeGateway.state.chatRequests.length} 次；` +
      `cloudAgents 建会话 ${fakeCloud.state.sessions.length} 次、` +
      `流式拉取 ${fakeCloud.state.streamRequests} 次。`,
  );
  console.log("demo 结束：三条链路全部走通，全程无凭证。\n");

  server.close();
  fakeGateway.close();
  fakeCloud.close();
}

main().catch((error) => {
  console.error("demo failed:", error);
  process.exitCode = 1;
});
