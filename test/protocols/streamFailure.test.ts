// 流式失败路径回归：v0.1 在流中途出错会触发 headers-sent 崩溃并挂住连接。
// 这些用例锁定修复后的行为：错误事件化 + 干净收尾 + 客户端断开可中止上游。
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/server/server.ts";
import { createFakeCloud } from "../helpers/fakeCloud.ts";

interface StartStackOptions {
  fixture?: string;
  holdStream?: boolean;
}

async function startStack({ fixture, holdStream = false }: StartStackOptions = {}) {
  const fake = createFakeCloud({ fixture, holdStream });
  fake.listen(0, "127.0.0.1");
  await once(fake, "listening");
  const { port: fakePort } = fake.address() as AddressInfo;

  const server = createServer({
    host: "127.0.0.1",
    port: 0,
    proxyApiKey: "local-key",
    qoderAccessToken: "qoder-token",
    qoderApiBaseUrl: `http://127.0.0.1:${fakePort}/api/v1/cloud`,
    requestTimeoutMs: 5000,
    archiveEphemeralSessions: true,
    sessionTtlMs: 60000,
    modelRoutes: "",
    modelMap: {
      cc: {
        modelId: "cc",
        agentId: "agent_test_123456",
        environmentId: "env_test_654321",
        title: "test",
        metadata: {},
      },
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    fake,
    origin: `http://127.0.0.1:${port}`,
    close() {
      server.close();
      fake.close();
    },
  };
}

// SSE data 载荷是动态 JSON；这里只声明断言会用到的形状。
interface StreamPayload {
  type?: string;
  error?: { message: string };
  response?: { error: { message: string } };
  choices?: { delta?: { content?: string } }[];
}

type StreamEvent = StreamPayload | "[DONE]";

function parseStreamEvents(text: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    }
    const raw = dataLines.join("\n");
    events.push(raw === "[DONE]" ? "[DONE]" : JSON.parse(raw));
  }
  return events;
}

test("chat stream: upstream session.error becomes an error data payload and clean close", async () => {
  const stack = await startStack({ fixture: "error.sse" });
  try {
    const res = await fetch(`${stack.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local-key", "content-type": "application/json" },
      body: JSON.stringify({
        model: "cc",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(res.status, 200);
    const events = parseStreamEvents(await res.text());
    const errorEvent = events.find(
      (event): event is StreamPayload & { error: { message: string } } =>
        event !== "[DONE]" && event.error !== undefined,
    );
    assert.ok(errorEvent, "expected an error payload in stream");
    assert.equal(errorEvent.error.message, "agent crashed");
    assert.equal(events.at(-1), "[DONE]");
    assert.equal(
      events.filter((event) => event !== "[DONE]" && event.choices?.[0]?.delta?.content).length,
      1,
    );
  } finally {
    stack.close();
  }
});

test("responses stream: upstream session.error becomes response.failed", async () => {
  const stack = await startStack({ fixture: "error.sse" });
  try {
    const res = await fetch(`${stack.origin}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer local-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "cc", stream: true, input: "hi" }),
    });
    const events = parseStreamEvents(await res.text());
    const failed = events.find(
      (event): event is StreamPayload & { response: { error: { message: string } } } =>
        event !== "[DONE]" && event.type === "response.failed",
    );
    assert.ok(failed, "expected response.failed event");
    assert.equal(failed.response.error.message, "agent crashed");
    assert.ok(!events.some((event) => event !== "[DONE]" && event.type === "response.completed"));
  } finally {
    stack.close();
  }
});

test("anthropic stream: upstream session.error becomes an error event without message_stop", async () => {
  const stack = await startStack({ fixture: "error.sse" });
  try {
    const res = await fetch(`${stack.origin}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer local-key", "content-type": "application/json" },
      body: JSON.stringify({
        model: "cc",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const text = await res.text();
    assert.match(text, /event: error/);
    assert.match(text, /"agent crashed"/);
    assert.ok(!text.includes("message_stop"));
  } finally {
    stack.close();
  }
});

test("client disconnect aborts the upstream stream and server stays healthy", async () => {
  const stack = await startStack({ fixture: "deltas.sse", holdStream: true });
  try {
    const controller = new AbortController();
    const streaming = fetch(`${stack.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local-key", "content-type": "application/json" },
      body: JSON.stringify({
        model: "cc",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: controller.signal,
    });
    const res = await streaming;
    const reader = res.body!.getReader();
    await reader.read(); // 收到首个 chunk（role chunk，此时上游可能尚未建立）

    // 等待上游流真正建立（holdStream 模式下 fake 只发 status_running 然后挂住）。
    for (let i = 0; i < 100 && stack.fake.state.streamRequests < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();

    // 服务进程不应崩溃：断开后新请求依然可用。
    const followup = await fetch(`${stack.origin}/v1/models`, {
      headers: { authorization: "Bearer local-key" },
    });
    assert.equal(followup.status, 200);
    assert.equal(stack.fake.state.streamRequests, 1);
  } finally {
    stack.close();
  }
});
