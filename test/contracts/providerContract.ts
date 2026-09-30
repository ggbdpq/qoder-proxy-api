import assert from "node:assert/strict";
import { PROVIDER_EVENT_TYPES } from "../../src/core/events.ts";
import type { ProviderEvent } from "../../src/core/events.ts";
import { ProviderError } from "../../src/core/errors.ts";
import type { CanonicalRequest, ProviderContext } from "../../src/core/request.ts";
import type { ProviderCapabilities } from "../../src/core/capabilities.ts";

// 合同只要求 Provider 形状满足出站适配器契约；id 不限死三链路枚举，
// 让 ScriptedProvider 这类测试替身也能进合同。
export interface ContractProvider {
  id: string;
  capabilities: () => ProviderCapabilities | Promise<ProviderCapabilities>;
  listModels: () => Promise<{ id: string; label?: string }[]>;
  stream: (request: CanonicalRequest, context: ProviderContext) => AsyncIterable<ProviderEvent>;
  dispose?: () => Promise<void>;
}

export interface ContractStreamScenario {
  request: CanonicalRequest;
  context?: ProviderContext;
  expect?: (events: ProviderEvent[]) => void;
}

export interface ContractAbortScenario {
  request: CanonicalRequest;
  context?: ProviderContext;
}

export interface ContractUnsupportedScenario {
  request: CanonicalRequest;
  context?: ProviderContext;
}

export interface ContractScenarios {
  stream?: ContractStreamScenario;
  abort?: ContractAbortScenario;
  unsupported?: ContractUnsupportedScenario;
}

// 所有 Provider 共用的行为合同。每个 Provider 的测试用各自的上游 fixture
// 提供 scenarios（stream / abort / unsupported），本模块只检查不变量：
// 事件类型合法、流必然终止、abort 不悬挂、不支持的能力显式报错。
export async function runProviderContract({
  provider,
  scenarios = {},
}: {
  provider: ContractProvider;
  scenarios?: ContractScenarios;
}): Promise<void> {
  assert.equal(typeof provider.id, "string", "provider.id must be a string");
  assert.ok(provider.id.length > 0, "provider.id must be non-empty");

  const caps = await provider.capabilities();
  for (const key of [
    "streaming",
    "cancellation",
    "sessions",
    "tools",
    "thinking",
    "vision",
    "modelDiscovery",
    "usage",
    "resume",
  ]) {
    assert.ok(key in caps, `capabilities missing "${key}"`);
  }

  const models = await provider.listModels();
  assert.ok(Array.isArray(models), "listModels must return an array");

  if (scenarios.stream) {
    const { request, expect } = scenarios.stream;
    const events: ProviderEvent[] = [];
    for await (const event of provider.stream(
      request,
      scenarios.stream.context ?? defaultContext(),
    )) {
      events.push(event);
      assert.ok(
        PROVIDER_EVENT_TYPES.has(event.type),
        `unknown provider event type: ${JSON.stringify(event.type)}`,
      );
    }
    const last = events.at(-1);
    assert.ok(last, "stream produced no events");
    assert.ok(
      last.type === "message.end" || last.type === "error",
      `stream must end with message.end or error, got: ${last.type}`,
    );
    if (expect) expect(events);
  }

  if (scenarios.abort) {
    const controller = new AbortController();
    const context: ProviderContext = { requestId: "contract-abort", signal: controller.signal };
    const iterator = provider.stream(scenarios.abort.request, context)[Symbol.asyncIterator]();
    // 立即 abort 再收集：不要求先产出事件（批量型 Provider 的首个事件在
    // 上游结束后才出现）。合同只要求流在超时内终止；若产出 error 事件，
    // 其码必须是 PROVIDER_ABORTED。
    controller.abort();
    let step = await withTimeout(iterator.next(), 5000, "provider stream hung after abort");
    while (!step.done) {
      if (step.value.type === "error") {
        assert.equal(step.value.error.code, "PROVIDER_ABORTED");
      }
      step = await withTimeout(iterator.next(), 5000, "stream did not finish after abort");
    }
  }

  if (scenarios.unsupported) {
    const context = scenarios.unsupported.context ?? defaultContext();
    let streamError: unknown = null;
    try {
      for await (const event of provider.stream(scenarios.unsupported.request, context)) {
        if (event.type === "error") {
          streamError = event.error;
          break;
        }
      }
    } catch (error) {
      streamError = error;
    }
    assert.ok(streamError instanceof ProviderError, "unsupported capability must fail explicitly");
    assert.equal(streamError.code, "UNSUPPORTED_CAPABILITY");
  }
}

export function defaultContext(): ProviderContext {
  return { requestId: "contract", signal: new AbortController().signal };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      if (typeof timer.unref === "function") timer.unref();
    }),
  ]);
}

export function expectProviderError(code: string) {
  return (error: unknown): error is ProviderError =>
    error instanceof ProviderError && error.code === code;
}
