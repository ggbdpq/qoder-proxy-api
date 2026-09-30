import test from "node:test";
import assert from "node:assert/strict";
import { assertCapability } from "../../src/core/capabilities.ts";
import type { ProviderCapabilities } from "../../src/core/capabilities.ts";
import type { CanonicalRequest } from "../../src/core/request.ts";
import { ProviderError } from "../../src/core/errors.ts";

const NO_SUPPORT: ProviderCapabilities = {
  streaming: true,
  cancellation: true,
  sessions: "none",
  tools: "none",
  thinking: "none",
  vision: "none",
  modelDiscovery: "static",
  usage: "none",
  resume: "none",
};

const textRequest: CanonicalRequest = { model: "m", messages: [{ role: "user", content: "hi" }] };

test("capability: plain text request passes on a text-only provider", () => {
  assert.doesNotThrow(() => assertCapability(NO_SUPPORT, textRequest));
});

test("capability: tools request rejected with UNSUPPORTED_CAPABILITY", () => {
  assert.throws(
    () =>
      assertCapability(NO_SUPPORT, {
        ...textRequest,
        tools: [{ name: "get_weather", inputSchema: {} }],
      }),
    (error) => error instanceof ProviderError && error.code === "UNSUPPORTED_CAPABILITY",
  );
});

test("capability: image content rejected when vision is none", () => {
  assert.throws(
    () =>
      assertCapability(NO_SUPPORT, {
        ...textRequest,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what" },
              { type: "image", source: {} },
            ],
          },
        ],
      }),
    (error) =>
      error instanceof ProviderError &&
      error.code === "UNSUPPORTED_CAPABILITY" &&
      /vision/.test(error.message),
  );
});

test("capability: reasoningEffort rejected when thinking is none", () => {
  assert.throws(
    () => assertCapability(NO_SUPPORT, { ...textRequest, reasoningEffort: "high" }),
    (error) =>
      error instanceof ProviderError &&
      error.code === "UNSUPPORTED_CAPABILITY" &&
      /thinking/.test(error.message),
  );
});

test("capability: supported capabilities pass through", () => {
  const caps: ProviderCapabilities = {
    ...NO_SUPPORT,
    tools: "emulated",
    thinking: "text",
    vision: "attachment",
  };
  assert.doesNotThrow(() =>
    assertCapability(caps, {
      ...textRequest,
      tools: [{ name: "t", inputSchema: {} }],
      reasoningEffort: "low",
      messages: [{ role: "user", content: [{ type: "image", source: {} }] }],
    }),
  );
});
