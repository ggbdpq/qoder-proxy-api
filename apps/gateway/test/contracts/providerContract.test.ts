import test from "node:test";
import assert from "node:assert/strict";
import { runProviderContract } from "./providerContract.ts";
import { ProviderError } from "../../src/core/errors.ts";
import { CAPABILITY_KEYS } from "../../src/core/capabilities.ts";
import type { ProviderCapabilities } from "../../src/core/capabilities.ts";
import type { CanonicalRequest, ProviderContext } from "../../src/core/request.ts";
import type { ProviderEvent } from "../../src/core/events.ts";

// 脚本化 Provider：合同套件的第一个消费者，同时证明套件可红可绿。
class ScriptedProvider {
  id = "scripted";

  async capabilities(): Promise<ProviderCapabilities> {
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
    };
  }

  async listModels() {
    return [{ id: "scripted-model" }];
  }

  async *stream(
    request: CanonicalRequest,
    context: ProviderContext,
  ): AsyncGenerator<ProviderEvent, void, unknown> {
    if (request.tools) {
      throw new ProviderError("UNSUPPORTED_CAPABILITY", "scripted provider has no tools");
    }
    yield { type: "message.start", id: "s1" };
    if (request.messages?.[0]?.content === "hang") {
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) return resolve();
        context.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      if (context.signal.aborted) {
        yield { type: "error", error: new ProviderError("PROVIDER_ABORTED", "aborted") };
        return;
      }
    }
    yield { type: "text.delta", text: "ok" };
    yield { type: "message.end", stopReason: "stop" };
  }
}

test("contract: scripted provider satisfies the provider contract", async () => {
  const provider = new ScriptedProvider();
  await runProviderContract({
    provider,
    scenarios: {
      stream: {
        request: { model: "scripted-model", messages: [{ role: "user", content: "hi" }] },
        expect(events) {
          assert.deepEqual(
            events.map((event) => event.type),
            ["message.start", "text.delta", "message.end"],
          );
        },
      },
      abort: { request: { model: "m", messages: [{ role: "user", content: "hang" }] } },
      unsupported: {
        request: {
          model: "m",
          messages: [{ role: "user", content: "hi" }],
          tools: [{ name: "t", inputSchema: {} }],
        },
      },
    },
  });
});

test("contract: suite rejects a provider emitting unknown event types", async () => {
  class BrokenProvider extends ScriptedProvider {
    async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
      // 负向用例：故意产出合同外的事件类型，类型洗白是有意的，运行时值不变。
      yield { type: "mystery.event" } as unknown as ProviderEvent;
    }
  }
  await assert.rejects(
    () =>
      runProviderContract({
        provider: new BrokenProvider(),
        scenarios: {
          stream: { request: { model: "m", messages: [{ role: "user", content: "hi" }] } },
        },
      }),
    /unknown provider event type/,
  );
});

test("contract: capability keys stay aligned between suite and defaults", () => {
  // 合同检查的能力键集合必须与 core 默认能力集合一致，防止两处漂移。
  assert.deepEqual([...CAPABILITY_KEYS].sort(), [
    "cancellation",
    "modelDiscovery",
    "resume",
    "sessions",
    "streaming",
    "thinking",
    "tools",
    "usage",
    "vision",
  ]);
});
