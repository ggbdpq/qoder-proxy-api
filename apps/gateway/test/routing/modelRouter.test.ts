import test from "node:test";
import assert from "node:assert/strict";
import { createProviderRegistry } from "../../src/routing/providerRegistry.ts";
import { parseModelRoutes, resolveModel } from "../../src/routing/modelRouter.ts";
import { ProviderError } from "../../src/core/errors.ts";
import type { QoderProvider } from "../../src/core/provider.ts";

function fakeProvider(id: QoderProvider["id"]): QoderProvider {
  return {
    id,
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
      };
    },
    async listModels() {
      return [{ id: `${id}-model` }];
    },
    async *stream() {
      yield { type: "message.end", stopReason: "stop" };
    },
  };
}

test("registry: registers providers, rejects duplicates and unknown ids", () => {
  const registry = createProviderRegistry();
  registry.register(fakeProvider("cloudAgents"));
  assert.equal(registry.get("cloudAgents")!.id, "cloudAgents");
  assert.equal(registry.get("nope"), undefined);
  assert.deepEqual(registry.ids(), ["cloudAgents"]);

  assert.throws(() => registry.register(fakeProvider("cloudAgents")), /already registered/);
  // 负向用例：故意注册残缺 provider，类型洗白是有意的，运行时值不变。
  assert.throws(
    () => registry.register({ id: "broken" } as unknown as QoderProvider),
    /is missing/,
  );
});

test("model routes: QODER_MODEL_MAP aliases belong to cloudAgents (v0.1 compat)", () => {
  const routes = parseModelRoutes({
    modelMap: { cc: { modelId: "cc", agentId: "a", environmentId: "e" } },
  });
  assert.deepEqual(routes.get("cc"), { providerId: "cloudAgents", model: "cc" });
});

test("model routes: QODER_MODEL_ROUTES explicitly assigns providers", () => {
  const routes = parseModelRoutes({
    modelMap: { cc: { modelId: "cc", agentId: "a", environmentId: "e" } },
    routesJson: JSON.stringify({
      "gw-qwen": { provider: "gateway", model: "Qwen3.8-Max" },
      "cli-ult": { provider: "cli", model: "ultimate" },
    }),
  });
  assert.deepEqual(routes.get("gw-qwen"), { providerId: "gateway", model: "Qwen3.8-Max" });
  assert.deepEqual(routes.get("cli-ult"), { providerId: "cli", model: "ultimate" });
  // 显式路由覆盖同别名 map 条目。
  const overridden = parseModelRoutes({
    modelMap: { cc: { modelId: "cc", agentId: "a", environmentId: "e" } },
    routesJson: JSON.stringify({ cc: { provider: "cli", model: "auto" } }),
  });
  assert.deepEqual(overridden.get("cc"), { providerId: "cli", model: "auto" });
});

test("router: resolves alias to provider instance, unknown alias is MODEL_NOT_FOUND", async () => {
  const registry = createProviderRegistry();
  const provider = fakeProvider("cloudAgents");
  registry.register(provider);
  const routes = parseModelRoutes({
    modelMap: { cc: { modelId: "cc", agentId: "a", environmentId: "e" } },
  });

  const resolved = await resolveModel(registry, routes, "cc");
  assert.equal(resolved.provider, provider);
  assert.deepEqual(resolved.route, { providerId: "cloudAgents", model: "cc" });

  assert.rejects(
    () => resolveModel(registry, routes, "nope"),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "MODEL_NOT_FOUND");
      return true;
    },
  );
});

test("router: route pointing at unregistered provider fails explicitly", async () => {
  const registry = createProviderRegistry();
  const routes = parseModelRoutes({
    routesJson: JSON.stringify({ m: { provider: "gateway", model: "x" } }),
  });
  assert.rejects(
    () => resolveModel(registry, routes, "m"),
    (error) =>
      error instanceof ProviderError &&
      error.code === "MODEL_NOT_FOUND" &&
      /gateway/.test(error.message),
  );
});
