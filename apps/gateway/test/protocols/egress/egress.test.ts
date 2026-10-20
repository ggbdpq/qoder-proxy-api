// WP1 出口映射：thinking-tools.sse 经真实 GatewayProvider normalize → 三个出口（流式 + 非流式）。
// 期望值按 WP1 映射表手写；纯文本路径由 characterization golden 兜住逐字节不变。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { GatewayProvider } from "../../../src/providers/gateway/index.ts";
import { aggregateStream } from "../../../src/core/aggregate.ts";
import { readJsonBody } from "../../../src/server/http.ts";
import type { ProtocolHandlerArgs } from "../../../src/server/http.ts";
import { handleChatCompletions } from "../../../src/protocols/openai/chat.ts";
import { handleResponses } from "../../../src/protocols/openai/responses.ts";
import { handleAnthropicMessages } from "../../../src/protocols/anthropic/messages.ts";
import { createFakeGateway } from "../../helpers/fakeGateway.ts";

type Handler = (args: ProtocolHandlerArgs) => Promise<void>;
const MODEL = "Qwen3.7-Max";

async function call(handler: Handler, body: Record<string, unknown>) {
  const fake = createFakeGateway({ sseFixture: "thinking-tools.sse" });
  fake.listen(0, "127.0.0.1");
  await once(fake, "listening");
  const { port: fakePort } = fake.address() as AddressInfo;
  const provider = new GatewayProvider({
    pat: "qoder_pat_fake",
    fetchImpl: (url, init) => {
      const target = new URL(url as string | URL);
      return fetch(`http://127.0.0.1:${fakePort}${target.pathname}${target.search}`, init);
    },
    requestTimeoutMs: 5000,
  });
  const ctx = () => ({ requestId: "r1", signal: new AbortController().signal });
  const server = http.createServer(async (req, res) => {
    await handler({
      req,
      res,
      body: await readJsonBody(req),
      model: MODEL,
      run: {
        stream: (request) => provider.stream(request, ctx()),
        aggregate: (request) => aggregateStream(provider.stream(request, ctx())),
      },
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return await res.text();
  } finally {
    server.close();
    fake.close();
  }
}

function sse(text: string) {
  return text
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      return data === "[DONE]" ? "[DONE]" : JSON.parse(data);
    });
}

const chatBody = { messages: [{ role: "user", content: "weather?" }] };
const responsesBody = { input: "weather?" };
const anthropicBody = { max_tokens: 100, messages: [{ role: "user", content: "weather?" }] };
const toolCall = { id: "call_1", name: "get_weather", arguments: '{"city":"Hanoi"}' };

test("egress chat stream: reasoning_content、分片 tool_calls、finish_reason tool_calls", async () => {
  const chunks = sse(await call(handleChatCompletions, { ...chatBody, stream: true }));
  assert.equal(chunks.at(-1), "[DONE]");
  assert.deepEqual(
    chunks
      .slice(0, -1)
      .map((c) => ({ delta: c.choices[0].delta, finish: c.choices[0].finish_reason })),
    [
      { delta: { role: "assistant" }, finish: null },
      { delta: { reasoning_content: "let me think" }, finish: null },
      { delta: { content: "answer" }, finish: null },
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: "" },
            },
          ],
        },
        finish: null,
      },
      { delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] }, finish: null },
      {
        delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Hanoi"}' } }] },
        finish: null,
      },
      { delta: {}, finish: "tool_calls" },
    ],
  );
});

test("egress chat non-stream: message 带 reasoning_content 与 tool_calls", async () => {
  const body = JSON.parse(await call(handleChatCompletions, chatBody));
  assert.deepEqual(body.choices[0], {
    index: 0,
    message: {
      role: "assistant",
      content: "answer",
      reasoning_content: "let me think",
      tool_calls: [
        {
          id: toolCall.id,
          type: "function",
          function: { name: toolCall.name, arguments: toolCall.arguments },
        },
      ],
    },
    finish_reason: "tool_calls",
  });
});

test("egress responses stream: reasoning item、message、function_call item 依次开合", async () => {
  const events = sse(await call(handleResponses, { ...responsesBody, stream: true }));
  const rs = events[1].item.id;
  const msg = events.find((e) => e.type === "response.output_text.delta").item_id;
  const fc = { id: "fc_call_1", type: "function_call", call_id: "call_1", name: "get_weather" };
  assert.deepEqual(
    events.slice(1, -2).map(({ response_id: _, ...e }) => e),
    [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: rs, type: "reasoning", summary: [] },
      },
      {
        type: "response.reasoning_summary_text.delta",
        item_id: rs,
        output_index: 0,
        summary_index: 0,
        delta: "let me think",
      },
      {
        type: "response.reasoning_summary_text.done",
        item_id: rs,
        output_index: 0,
        summary_index: 0,
        text: "let me think",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: rs,
          type: "reasoning",
          summary: [{ type: "summary_text", text: "let me think" }],
        },
      },
      {
        type: "response.output_text.delta",
        item_id: msg,
        output_index: 1,
        content_index: 0,
        delta: "answer",
      },
      { type: "response.output_text.done", item_id: msg, output_index: 1, content_index: 0 },
      {
        type: "response.output_item.added",
        output_index: 2,
        item: { ...fc, arguments: "", status: "in_progress" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: fc.id,
        output_index: 2,
        delta: '{"ci',
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: fc.id,
        output_index: 2,
        delta: 'ty":"Hanoi"}',
      },
      {
        type: "response.function_call_arguments.done",
        item_id: fc.id,
        output_index: 2,
        arguments: toolCall.arguments,
      },
      {
        type: "response.output_item.done",
        output_index: 2,
        item: { ...fc, arguments: toolCall.arguments, status: "completed" },
      },
    ],
  );
  assert.equal(events.at(-2).type, "response.completed");
  assert.equal(events.at(-2).response.status, "completed");
  assert.equal(events.at(-1), "[DONE]");
});

test("egress responses non-stream: output 含 reasoning、message、function_call", async () => {
  const body = JSON.parse(await call(handleResponses, responsesBody));
  assert.equal(body.status, "completed");
  assert.equal(body.output_text, "answer");
  assert.deepEqual(
    body.output.map(({ id: _, ...item }: { id: string }) => item),
    [
      { type: "reasoning", summary: [{ type: "summary_text", text: "let me think" }] },
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "answer", annotations: [] }],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "get_weather",
        arguments: toolCall.arguments,
        status: "completed",
      },
    ],
  );
});

test("egress anthropic stream: thinking / text / tool_use 三个块与 stop_reason tool_use", async () => {
  const events = sse(await call(handleAnthropicMessages, { ...anthropicBody, stream: true }));
  assert.equal(events[0].type, "message_start");
  assert.deepEqual(events.slice(1), [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "let me think" },
    },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
    { type: "content_block_stop", index: 1 },
    {
      type: "content_block_start",
      index: 2,
      content_block: { type: "tool_use", id: "call_1", name: "get_weather", input: {} },
    },
    {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: '{"ci' },
    },
    {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: 'ty":"Hanoi"}' },
    },
    { type: "content_block_stop", index: 2 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 0 },
    },
    { type: "message_stop" },
  ]);
});

test("egress anthropic non-stream: thinking、text、tool_use 块，input 为解析后的对象", async () => {
  const body = JSON.parse(await call(handleAnthropicMessages, anthropicBody));
  assert.equal(body.stop_reason, "tool_use");
  assert.deepEqual(body.content, [
    { type: "thinking", thinking: "let me think", signature: "" },
    { type: "text", text: "answer" },
    { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Hanoi" } },
  ]);
});
