// WP2 入口保真：下游请求 → CanonicalRequest 不丢工具、图片、thinking 签名、cache_control。
import test from "node:test";
import assert from "node:assert/strict";
import { chatToCanonical, responsesToCanonical } from "../../../src/protocols/openai/request.ts";
import { anthropicToCanonical } from "../../../src/protocols/anthropic/request.ts";
import { HttpError } from "../../../src/server/http.ts";
import type { IncomingBody } from "../../../src/server/http.ts";
import { textOf } from "../../../src/core/request.ts";
import type {
  CanonicalContentPart,
  CanonicalMessage,
  CanonicalRequest,
} from "../../../src/core/request.ts";

const body = (value: Record<string, unknown>) => value as IncomingBody;

test("ingress: 空 content 的 assistant 工具调用轮被保留", () => {
  const request = chatToCanonical(
    body({
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Hanoi"}' },
            },
          ],
        },
      ],
    }),
    "m",
  );
  assert.equal(request.messages.length, 2);
  assert.deepEqual(request.messages[1], {
    role: "assistant",
    content: [
      { type: "tool_call", id: "call_1", name: "get_weather", arguments: '{"city":"Hanoi"}' },
    ],
    toolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"Hanoi"}' }],
  });
});

test("ingress: tool 消息保留 tool_call_id", () => {
  const request = chatToCanonical(
    body({
      messages: [{ role: "tool", tool_call_id: "call_1", content: "sunny" }],
    }),
    "m",
  );
  assert.deepEqual(request.messages[0], {
    role: "tool",
    toolCallId: "call_1",
    content: [{ type: "tool_result", toolCallId: "call_1", content: "sunny" }],
  });
});

test("ingress: image_url 是 image part，不是占位文本", () => {
  const request = chatToCanonical(
    body({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "https://x.test/a.png" } },
          ],
        },
      ],
    }),
    "m",
  );
  assert.deepEqual(request.messages[0].content, [
    { type: "text", text: "look" },
    { type: "image", url: "https://x.test/a.png" },
  ]);
});

test("ingress: anthropic 的 tool_use / tool_result / thinking 签名 / image 逐块保留", () => {
  const request = anthropicToCanonical(
    body({
      system: [{ type: "text", text: "be terse", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "xxx" } },
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "42",
              is_error: true,
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm", signature: "sig" },
            { type: "text", text: "ok" },
            { type: "tool_use", id: "toolu_1", name: "add", input: { n: 1 } },
          ],
        },
      ],
    }),
    "m",
  );
  assert.deepEqual(request.system, [
    { type: "text", text: "be terse", providerExtras: { cache_control: { type: "ephemeral" } } },
  ]);
  assert.deepEqual(request.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", mediaType: "image/png", data: "xxx" },
        { type: "tool_result", toolCallId: "toolu_1", content: "42", isError: true },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", text: "hmm", signature: "sig" },
        { type: "text", text: "ok" },
        { type: "tool_call", id: "toolu_1", name: "add", arguments: '{"n":1}' },
      ],
      toolCalls: [{ id: "toolu_1", name: "add", arguments: '{"n":1}' }],
    },
  ]);
});

test("ingress: responses 的 function_call / function_call_output / reasoning 逐项保留", () => {
  const request = responsesToCanonical(
    body({
      input: [
        { type: "message", role: "user", content: "weather?" },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "check" }],
        },
        { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "sunny" },
      ],
    }),
    "m",
  );
  assert.deepEqual(request.messages, [
    { role: "user", content: "weather?" },
    { role: "assistant", content: [{ type: "thinking", text: "check" }] },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "call_1", name: "get_weather", arguments: "{}" }],
      toolCalls: [{ id: "call_1", name: "get_weather", arguments: "{}" }],
    },
    {
      role: "tool",
      toolCallId: "call_1",
      content: [{ type: "tool_result", toolCallId: "call_1", content: "sunny" }],
    },
  ]);
});

test("ingress: textOf 对纯文本字符串原样返回，并只拼接 text part", () => {
  assert.equal(textOf({ content: "hi" }), "hi");
  assert.equal(
    textOf({
      content: [
        { type: "text", text: "a" },
        { type: "thinking", text: "secret" },
        { type: "tool_call", id: "1", name: "f", arguments: "{}" },
      ],
    }),
    "a",
  );
});

test("ingress: previous_response_id 返回 400", () => {
  assert.throws(
    () => responsesToCanonical(body({ input: "hi", previous_response_id: "resp_1" }), "m"),
    (error: unknown) =>
      error instanceof HttpError &&
      error.status === 400 &&
      /previous_response_id/.test(error.message),
  );
});

// 下游 → Canonical → 下游。纯文本折叠成字符串是既有约定，生成器只产生这种规范形。
test("ingress: 200 个随机消息序列往返无丢失", () => {
  const random = mulberry32(20260512);
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
  for (let i = 0; i < 200; i += 1) {
    const protocol = i % 3;
    if (protocol === 0) roundtripChat(i, random, pick);
    else if (protocol === 1) roundtripAnthropic(i, random, pick);
    else roundtripResponses(i, random, pick);
  }
});

function roundtripChat(index: number, random: () => number, pick: <T>(items: T[]) => T) {
  const messages: Array<Record<string, unknown>> = [];
  if (random() < 0.5) messages.push({ role: "system", content: token(random) });
  const count = 1 + Math.floor(random() * 4);
  for (let n = 0; n < count; n += 1) {
    const kind = pick(["user", "image", "tools", "tool"] as const);
    if (kind === "user") messages.push({ role: "user", content: token(random) });
    else if (kind === "image") {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: token(random) },
          { type: "image_url", image_url: { url: `https://x.test/${token(random)}.png` } },
        ],
      });
    } else if (kind === "tools") {
      messages.push({
        role: "assistant",
        content: random() < 0.5 ? null : token(random),
        tool_calls: [
          {
            id: `call_${token(random)}`,
            type: "function",
            function: { name: "fn", arguments: "{}" },
          },
        ],
      });
    } else {
      messages.push({
        role: "tool",
        tool_call_id: `call_${token(random)}`,
        content: token(random),
      });
    }
  }
  const request = chatToCanonical(body({ messages }), "m");
  assert.deepEqual(chatWire(request), messages, `chat #${index}`);
}

function roundtripAnthropic(index: number, random: () => number, pick: <T>(items: T[]) => T) {
  const blocks = (kind: string) => {
    if (kind === "text") return [{ type: "text", text: token(random) }];
    if (kind === "image") {
      return [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: token(random) },
        },
      ];
    }
    if (kind === "thinking") {
      return [{ type: "thinking", thinking: token(random), signature: token(random) }];
    }
    const id = `toolu_${token(random)}`;
    if (kind === "result") {
      return [{ type: "tool_result", tool_use_id: id, content: token(random), is_error: true }];
    }
    return [{ type: "tool_use", id, name: "fn", input: { k: token(random) } }];
  };
  const messages = [0, 1].map(() => ({
    role: pick(["user", "assistant"] as const),
    content: blocks(pick(["text", "image", "thinking", "tool", "result"] as const)),
  }));
  // 纯文本单块会折叠成字符串；生成器改用字符串，和折叠结果同一规范形。
  for (const message of messages) {
    const block = (message.content as Array<Record<string, unknown>>)[0];
    if (block.type === "text") message.content = block.text as never;
  }
  const request = anthropicToCanonical(body({ messages }), "m");
  assert.deepEqual(anthropicWire(request), messages, `anthropic #${index}`);
}

function roundtripResponses(index: number, random: () => number, pick: <T>(items: T[]) => T) {
  const kind = pick(["text", "reasoning", "call", "output"] as const);
  const id = `call_${token(random)}`;
  const input =
    kind === "text"
      ? [{ type: "message", role: "user", content: token(random) }]
      : kind === "reasoning"
        ? [{ type: "reasoning", summary: [{ type: "summary_text", text: token(random) }] }]
        : kind === "call"
          ? [{ type: "function_call", call_id: id, name: "fn", arguments: "{}" }]
          : [{ type: "function_call_output", call_id: id, output: token(random) }];
  const request = responsesToCanonical(body({ input }), "m");
  assert.deepEqual(responsesWire(request), input, `responses #${index}`);
}

function chatWire(request: CanonicalRequest): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  if (typeof request.system === "string" && request.system) {
    messages.push({ role: "system", content: request.system });
  }
  for (const message of request.messages) messages.push(chatMessageWire(message));
  return messages;
}

function chatMessageWire(message: CanonicalMessage): Record<string, unknown> {
  const parts = asParts(message);
  if (message.role === "tool") {
    const result = parts.find((part) => part.type === "tool_result");
    return {
      role: "tool",
      tool_call_id: result?.type === "tool_result" ? result.toolCallId : message.toolCallId,
      content: result?.type === "tool_result" ? result.content : "",
    };
  }
  const calls = parts.filter((part) => part.type === "tool_call");
  const rest = parts.filter((part) => part.type !== "tool_call");
  const wire: Record<string, unknown> = { role: message.role };
  if (calls.length) {
    wire.tool_calls = calls.map((part) =>
      part.type === "tool_call"
        ? {
            id: part.id,
            type: "function",
            function: { name: part.name, arguments: part.arguments },
          }
        : part,
    );
  }
  if (rest.length === 1 && rest[0].type === "text" && !rest[0].providerExtras)
    wire.content = rest[0].text;
  else if (!rest.length) wire.content = null;
  else {
    wire.content = rest.map((part) =>
      part.type === "image"
        ? { type: "image_url", image_url: { url: part.url } }
        : { type: "text", text: part.type === "text" ? part.text : "" },
    );
  }
  return wire;
}

function anthropicWire(request: CanonicalRequest): Array<Record<string, unknown>> {
  return request.messages.map((message) => {
    const parts = asParts(message);
    if (parts.length === 1 && parts[0].type === "text" && !parts[0].providerExtras) {
      return { role: message.role, content: parts[0].text };
    }
    return {
      role: message.role,
      content: parts.map((part) => {
        if (part.type === "text") return { type: "text", text: part.text };
        if (part.type === "image") {
          return {
            type: "image",
            source: { type: "base64", media_type: part.mediaType, data: part.data },
          };
        }
        if (part.type === "thinking") {
          return { type: "thinking", thinking: part.text, signature: part.signature };
        }
        if (part.type === "tool_call") {
          return {
            type: "tool_use",
            id: part.id,
            name: part.name,
            input: JSON.parse(part.arguments),
          };
        }
        return {
          type: "tool_result",
          tool_use_id: part.toolCallId,
          content: part.content,
          ...(part.isError ? { is_error: true } : {}),
        };
      }),
    };
  });
}

function responsesWire(request: CanonicalRequest): Array<Record<string, unknown>> {
  return request.messages.map((message) => {
    const parts = asParts(message);
    const [part] = parts;
    if (part?.type === "thinking") {
      return { type: "reasoning", summary: [{ type: "summary_text", text: part.text }] };
    }
    if (part?.type === "tool_call") {
      return {
        type: "function_call",
        call_id: part.id,
        name: part.name,
        arguments: part.arguments,
      };
    }
    if (part?.type === "tool_result") {
      return { type: "function_call_output", call_id: part.toolCallId, output: part.content };
    }
    return {
      type: "message",
      role: message.role,
      content: typeof message.content === "string" ? message.content : "",
    };
  });
}

function asParts(message: CanonicalMessage): CanonicalContentPart[] {
  return typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content;
}

function token(random: () => number): string {
  return random().toString(36).slice(2, 8);
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
