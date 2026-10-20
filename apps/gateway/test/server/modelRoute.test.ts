// server 层模型路由集成测试：显式路由的 model 必须真正应用到 CanonicalRequest，
// 直通模型名原样传给默认 provider（README「显式路由是唯一路由方式」的服务端语义）。
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/server/server.ts";
import { createProviderRegistry } from "../../src/routing/providerRegistry.ts";
import { parseModelRoutes } from "../../src/routing/modelRouter.ts";
import { loadConfig } from "../../src/config.ts";
import type { CanonicalRequest, ProviderContext } from "../../src/core/request.ts";
import type { ProviderEvent } from "../../src/core/events.ts";

// 记录 stream() 收到的 model：路由是否真正生效的唯一裁判。
class RecordingProvider {
  id = "recording";
  seenModels: string[] = [];

  capabilities() {
    return {
      streaming: true,
      cancellation: true,
      sessions: "none",
      tools: "none",
      thinking: "none",
      vision: "none",
      modelDiscovery: "static",
      usage: "none",
      resume: "none",
    } as const;
  }

  async listModels() {
    return [{ id: "target-model" }];
  }

  async *stream(
    request: CanonicalRequest,
    _context: ProviderContext,
  ): AsyncIterable<ProviderEvent> {
    this.seenModels.push(request.model);
    yield { type: "text.delta", text: "ok" };
    yield { type: "message.end", stopReason: "stop" };
  }
}

async function startServer(routes: Record<string, { provider: string; model: string }>) {
  const provider = new RecordingProvider();
  const registry = createProviderRegistry();
  registry.register(provider as never);
  const server = createServer(loadConfig(), {
    providerRegistry: registry,
    modelRoutes: parseModelRoutes({ routesJson: JSON.stringify(routes) }),
    defaultProviderId: "recording",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    provider,
    port,
    close() {
      server.close();
    },
  };
}

test("server: explicit route rewrites the model before it reaches the provider", async () => {
  const { provider, port, close } = await startServer({
    "route-alias": { provider: "recording", model: "target-model" },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({
        model: "route-alias",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(provider.seenModels, ["target-model"]);
  } finally {
    close();
  }
});

test("server: passthrough model name reaches the default provider unchanged", async () => {
  const { provider, port, close } = await startServer({});
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({
        model: "passthrough-x",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(provider.seenModels, ["passthrough-x"]);
  } finally {
    close();
  }
});
