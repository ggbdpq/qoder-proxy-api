// Characterization：在结构重构前冻结 v0.1 Cloud Agents 路径的可观察行为。
// 这些测试描述的是“当前实现是什么”，不一定是“理想行为应该是什么”；
// 重构期间它们必须保持绿色，除非 commit 明确声明了行为偏差。
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/server/server.ts";
import { createFakeCloud } from "../helpers/fakeCloud.ts";

const ID_LIKE = /^(?:(?:msg_)?(?:chatcmpl|resp)_[a-z0-9]+|msg_[a-z0-9]{10,})$/;

// 把动态 id / 时间戳归一成 "*"，让 deepEqual 只对比稳定结构。
function normalize(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
  }
  if ((key === "created" || key === "created_at") && typeof value === "number") return "*";
  if (typeof value === "string" && ID_LIKE.test(value)) return "*";
  return value;
}

interface SseRecord {
  event: string | null;
  data: unknown;
}

function parseStreamEvents(text: string): SseRecord[] {
  const events: SseRecord[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event = null;
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    }
    const raw = dataLines.join("\n");
    events.push({ event, data: raw === "[DONE]" ? "[DONE]" : normalize(JSON.parse(raw)) });
  }
  return events;
}

interface StartStackOptions {
  fixture?: string;
  createSessionStatus?: number;
  config?: Record<string, unknown>;
}

async function startStack({
  fixture = "deltas.sse",
  createSessionStatus = 200,
  config,
}: StartStackOptions = {}) {
  const fake = createFakeCloud({ fixture, createSessionStatus });
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
    ...config,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return {
    fake,
    server,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      server.close();
      fake.close();
    },
  };
}

function post(origin: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer local-key",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("characterization: /v1/models returns alias list", async () => {
  const stack = await startStack();
  try {
    const res = await fetch(`${stack.origin}/v1/models`, {
      headers: { authorization: "Bearer local-key" },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, "list");
    assert.equal(body.data[0].id, "cc");
    assert.equal(body.data[0].object, "model");
    assert.equal(body.data[0].owned_by, "qoder-proxy-api");
    assert.equal(typeof body.data[0].created, "number");
  } finally {
    await stack.close();
  }
});

test("characterization: /health redacts cloud identifiers", async () => {
  const stack = await startStack();
  try {
    const res = await fetch(`${stack.origin}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.config.models.cc.agentId, "agent_...3456");
    assert.equal(body.config.models.cc.environmentId, "env_te...4321");
    assert.equal(body.config.qoderApiBaseUrl.includes("127.0.0.1"), true);
  } finally {
    await stack.close();
  }
});

test("characterization: chat completions non-stream golden", async () => {
  const stack = await startStack();
  try {
    const res = await post(stack.origin, "/v1/chat/completions", {
      model: "cc",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(normalize(await res.json()), {
      id: "*",
      object: "chat.completion",
      created: "*",
      model: "cc",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello, world" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } finally {
    await stack.close();
  }
});

test("characterization: chat completions stream golden", async () => {
  const stack = await startStack();
  try {
    const res = await post(stack.origin, "/v1/chat/completions", {
      model: "cc",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
    const events = parseStreamEvents(await res.text());
    const chunk = (delta: Record<string, unknown>, finish?: string) => ({
      id: "*",
      object: "chat.completion.chunk",
      created: "*",
      model: "cc",
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    });
    assert.deepEqual(events, [
      { event: null, data: chunk({ role: "assistant" }) },
      { event: null, data: chunk({ content: "Hello" }) },
      { event: null, data: chunk({ content: ", world" }) },
      { event: null, data: chunk({}, "stop") },
      { event: null, data: "[DONE]" },
    ]);
  } finally {
    await stack.close();
  }
});

test("characterization: responses non-stream golden", async () => {
  const stack = await startStack();
  try {
    const res = await post(stack.origin, "/v1/responses", {
      model: "cc",
      input: "hi",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(normalize(await res.json()), {
      id: "*",
      object: "response",
      created_at: "*",
      status: "completed",
      model: "cc",
      output: [
        {
          id: "*",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello, world", annotations: [] }],
        },
      ],
      output_text: "Hello, world",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    });
  } finally {
    await stack.close();
  }
});

test("characterization: responses stream golden", async () => {
  const stack = await startStack();
  try {
    const res = await post(stack.origin, "/v1/responses", {
      model: "cc",
      stream: true,
      input: "hi",
    });
    assert.equal(res.status, 200);
    const events = parseStreamEvents(await res.text());
    assert.deepEqual(events, [
      {
        event: null,
        data: {
          type: "response.created",
          response: { id: "*", object: "response", status: "in_progress", model: "cc" },
        },
      },
      {
        event: null,
        data: {
          type: "response.output_text.delta",
          response_id: "*",
          item_id: "*",
          output_index: 0,
          content_index: 0,
          delta: "Hello",
        },
      },
      {
        event: null,
        data: {
          type: "response.output_text.delta",
          response_id: "*",
          item_id: "*",
          output_index: 0,
          content_index: 0,
          delta: ", world",
        },
      },
      {
        event: null,
        data: {
          type: "response.output_text.done",
          response_id: "*",
          item_id: "*",
          output_index: 0,
          content_index: 0,
        },
      },
      {
        event: null,
        data: {
          type: "response.completed",
          response: { id: "*", object: "response", status: "completed", model: "cc" },
        },
      },
      { event: null, data: "[DONE]" },
    ]);
  } finally {
    await stack.close();
  }
});

test("characterization: anthropic messages non-stream golden", async () => {
  const stack = await startStack();
  try {
    const res = await post(stack.origin, "/v1/messages", {
      model: "cc",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(normalize(await res.json()), {
      id: "*",
      type: "message",
      role: "assistant",
      model: "cc",
      content: [{ type: "text", text: "Hello, world" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  } finally {
    await stack.close();
  }
});

test("characterization: anthropic messages stream golden", async () => {
  const stack = await startStack();
  try {
    const res = await post(stack.origin, "/v1/messages", {
      model: "cc",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.status, 200);
    const events = parseStreamEvents(await res.text());
    assert.deepEqual(events, [
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: "*",
            type: "message",
            role: "assistant",
            model: "cc",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
      },
      {
        event: "content_block_start",
        data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: ", world" },
        },
      },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      {
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 0 },
        },
      },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);
  } finally {
    await stack.close();
  }
});

test("characterization: full-text agent.message events aggregate without duplication", async () => {
  const stack = await startStack({ fixture: "fulltext.sse" });
  try {
    const res = await post(stack.origin, "/v1/chat/completions", {
      model: "cc",
      messages: [{ role: "user", content: "hi" }],
    });
    const body = await res.json();
    assert.equal(body.choices[0].message.content, "full text answer");
  } finally {
    await stack.close();
  }
});

test("characterization: upstream stream ending without idle returns accumulated text", async () => {
  const stack = await startStack({ fixture: "deltas-noidle.sse" });
  try {
    const res = await post(stack.origin, "/v1/chat/completions", {
      model: "cc",
      messages: [{ role: "user", content: "hi" }],
    });
    const body = await res.json();
    assert.equal(body.choices[0].message.content, "Hello");
  } finally {
    await stack.close();
  }
});

// 已知污点行为：delta 事件里非 JSON 的 data 会被原样当作文本增量输出。
// 锁定它是为了让未来修复变成显式决策，而不是重构时无意变更。
test("characterization: malformed SSE data leaks raw text into delta (known wart)", async () => {
  const stack = await startStack({ fixture: "malformed.sse" });
  try {
    const res = await post(stack.origin, "/v1/chat/completions", {
      model: "cc",
      messages: [{ role: "user", content: "hi" }],
    });
    const body = await res.json();
    assert.equal(body.choices[0].message.content, "not-json{{{");
  } finally {
    await stack.close();
  }
});

test("characterization: x-qoder-session-id reuses one upstream session across calls", async () => {
  const stack = await startStack();
  try {
    for (let i = 0; i < 2; i += 1) {
      const res = await post(
        stack.origin,
        "/v1/chat/completions",
        { model: "cc", messages: [{ role: "user", content: `m${i}` }] },
        { "x-qoder-session-id": "conv-1" },
      );
      assert.equal(res.status, 200);
    }
    assert.equal(stack.fake.state.sessions.length, 1);
    assert.equal(stack.fake.state.messages.length, 2);
    assert.equal(stack.fake.state.archived.length, 0);
  } finally {
    await stack.close();
  }
});

test("characterization: ephemeral session is archived, keyed session is not", async () => {
  const stack = await startStack();
  try {
    const res = await post(stack.origin, "/v1/chat/completions", {
      model: "cc",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.status, 200);
    assert.equal(stack.fake.state.archived.length, 1);

    const sessionCreate = stack.fake.state.sessions[0];
    const sessionBody = sessionCreate.body as {
      agent: unknown;
      environment_id: string;
      metadata: { via: string };
    };
    assert.deepEqual(sessionBody.agent, { id: "agent_test_123456", type: "agent" });
    assert.equal(sessionBody.environment_id, "env_test_654321");
    assert.equal(sessionBody.metadata.via, "qoder-proxy-api");
  } finally {
    await stack.close();
  }
});

test("characterization: upstream session failure maps to 500 server_error", async () => {
  const stack = await startStack({ createSessionStatus: 500 });
  try {
    const res = await post(stack.origin, "/v1/chat/completions", {
      model: "cc",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error.message, /Qoder HTTP 500/);
    assert.equal(body.error.type, "server_error");
  } finally {
    await stack.close();
  }
});

test("characterization: bad bearer token rejected with 401", async () => {
  const stack = await startStack();
  try {
    const res = await fetch(`${stack.origin}/v1/models`, {
      headers: { authorization: "Bearer wrong" },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.message, "invalid or missing bearer token");
  } finally {
    await stack.close();
  }
});

test("characterization: unknown model rejected with 400", async () => {
  const stack = await startStack();
  try {
    const res = await post(stack.origin, "/v1/chat/completions", {
      model: "nope",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.message, "unknown model: nope");
  } finally {
    await stack.close();
  }
});
