// 协议层单测：下游请求 → CanonicalRequest 的转换规则。
import test from "node:test";
import assert from "node:assert/strict";
import { chatToCanonical, responsesToCanonical } from "../../src/protocols/openai/request.ts";
import { anthropicToCanonical } from "../../src/protocols/anthropic/request.ts";

test("openai chat: system/developer 进 system 字段，roles 归一", () => {
  const request = chatToCanonical(
    {
      messages: [
        { role: "system", content: "be brief" },
        { role: "developer", content: "no profanity" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: [{ type: "text", text: "again" }] },
        { role: "user", content: "" },
      ],
      max_tokens: 128,
    },
    "cc",
  );
  assert.equal(request.system, "be brief\nno profanity");
  assert.deepEqual(
    request.messages.map((m) => [m.role, m.content]),
    [
      ["user", "hi"],
      ["assistant", "hello"],
      ["user", "again"],
    ],
  );
  assert.equal(request.maxTokens, 128);
  assert.equal(request.model, "cc");
});

test("openai chat: image_url 降级为占位文本（v0.1 语义）", () => {
  const request = chatToCanonical(
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "https://x.test/a.png" } },
          ],
        },
      ],
    },
    "cc",
  );
  assert.equal(request.messages[0].content, "look\n[image: https://x.test/a.png]");
});

test("openai responses: 字符串与数组 input、instructions 进 system", () => {
  const fromString = responsesToCanonical({ input: "hi", instructions: "be nice" }, "cc");
  assert.equal(fromString.system, "be nice");
  assert.deepEqual(fromString.messages, [{ role: "user", content: "hi" }]);

  const fromArray = responsesToCanonical(
    {
      input: [
        "plain",
        { role: "assistant", content: "hey" },
        { role: "user", content: [{ type: "input_text", text: "structured" }] },
      ],
    },
    "cc",
  );
  assert.deepEqual(
    fromArray.messages.map((m) => [m.role, m.content]),
    [
      ["user", "plain"],
      ["assistant", "hey"],
      ["user", "structured"],
    ],
  );
});

test("anthropic: system 字符串与 text 块进 canonical，非 text 块丢弃（v0.1 语义）", () => {
  const request = anthropicToCanonical(
    {
      system: "be terse",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "image", source: { type: "base64", data: "xxx" } },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "hi there" }] },
      ],
      max_tokens: 64,
    },
    "cc",
  );
  assert.equal(request.system, "be terse");
  assert.deepEqual(
    request.messages.map((m) => [m.role, m.content]),
    [
      ["user", "hello"],
      ["assistant", "hi there"],
    ],
  );
  assert.equal(request.maxTokens, 64);
});
