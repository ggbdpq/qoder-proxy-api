import test from "node:test";
import assert from "node:assert/strict";
import { aggregateStream } from "../../src/core/aggregate.ts";
import { ProviderError } from "../../src/core/errors.ts";
import type { ProviderEvent } from "../../src/core/events.ts";

async function* events(list: ProviderEvent[]) {
  yield* list;
}

test("aggregate: text deltas, thinking, usage and stopReason", async () => {
  const result = await aggregateStream(
    events([
      { type: "message.start", id: "m1" },
      { type: "thinking.delta", text: "hmm " },
      { type: "text.delta", text: "Hel" },
      { type: "text.delta", text: "lo" },
      { type: "usage", inputTokens: 3, outputTokens: 2 },
      { type: "message.end", stopReason: "stop" },
    ]),
  );
  assert.equal(result.id, "m1");
  assert.equal(result.text, "Hello");
  assert.equal(result.thinking, "hmm ");
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 2 });
  assert.equal(result.stopReason, "stop");
});

test("aggregate: tool arguments split across deltas reassemble by index", async () => {
  const result = await aggregateStream(
    events([
      { type: "tool.start", index: 0, id: "t1", name: "get_weather" },
      { type: "tool.arguments.delta", index: 0, json: '{"city":"Han' },
      { type: "tool.arguments.delta", index: 0, json: 'oi"}' },
      { type: "tool.end", index: 0 },
      { type: "message.end", stopReason: "tool_use" },
    ]),
  );
  assert.equal(result.stopReason, "tool_use");
  assert.deepEqual(result.toolCalls, [
    { id: "t1", name: "get_weather", arguments: '{"city":"Hanoi"}' },
  ]);
});

test("aggregate: error event surfaces as thrown ProviderError", async () => {
  await assert.rejects(
    () =>
      aggregateStream(
        events([{ type: "error", error: new ProviderError("PROVIDER_TIMEOUT", "timed out") }]),
      ),
    (error) => error instanceof ProviderError && error.code === "PROVIDER_TIMEOUT",
  );
});

test("aggregate: defaults when stream only carries text", async () => {
  const result = await aggregateStream(events([{ type: "text.delta", text: "x" }]));
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.toolCalls, []);
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 });
});
