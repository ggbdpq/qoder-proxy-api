// 模型路由：客户端可见别名 → { providerId, model }。
// QODER_MODEL_MAP 兼容（别名归属 cloudAgents）；QODER_MODEL_ROUTES 显式指定并覆盖同别名。
// 显式路由是唯一路由方式：不做 Provider 自动 fallback。
import { ERROR_CODES, ProviderError } from "../core/errors.ts";
import type { QoderProvider } from "../core/provider.ts";
import type { ModelMap } from "../config.ts";
import type { ProviderRegistry } from "./providerRegistry.ts";

const CLOUD_AGENTS_ID = "cloudAgents";

export interface ModelRoute {
  providerId: string;
  model: string;
}

export type ModelRoutes = Map<string, ModelRoute>;

export interface ParseModelRoutesOptions {
  modelMap?: ModelMap;
  routesJson?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function parseModelRoutes({
  modelMap,
  routesJson,
}: ParseModelRoutesOptions = {}): ModelRoutes {
  const routes: ModelRoutes = new Map();
  for (const alias of Object.keys(modelMap ?? {})) {
    routes.set(alias, { providerId: CLOUD_AGENTS_ID, model: alias });
  }

  if (routesJson && String(routesJson).trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(routesJson);
    } catch (error) {
      throw new Error(
        `QODER_MODEL_ROUTES is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("QODER_MODEL_ROUTES must be a JSON object keyed by model alias");
    }
    for (const [alias, raw] of Object.entries(parsed)) {
      const providerId = String(asRecord(raw)?.provider || "").trim();
      const model = String(asRecord(raw)?.model || alias).trim();
      if (!providerId) {
        throw new Error(`QODER_MODEL_ROUTES["${alias}"] is missing "provider"`);
      }
      routes.set(String(alias).trim(), { providerId, model });
    }
  }
  return routes;
}

export interface ModelResolution {
  provider: QoderProvider;
  route: ModelRoute;
}

export async function resolveModel(
  registry: ProviderRegistry,
  routes: ModelRoutes,
  requestedModel: string,
  { defaultProviderId }: { defaultProviderId?: string } = {},
): Promise<ModelResolution> {
  const alias = String(requestedModel || "").trim();
  const route = routes.get(alias);
  if (route) {
    const provider = registry.get(route.providerId);
    if (!provider) {
      throw new ProviderError(
        ERROR_CODES.MODEL_NOT_FOUND,
        `model "${alias}" routes to provider "${route.providerId}", which is not registered`,
      );
    }
    return { provider, route };
  }
  // 未命中显式路由 → 直通默认 provider，由其模型解析裁决（路由策略，非故障 fallback）。
  const provider = registry.get(defaultProviderId);
  if (!provider) {
    throw new ProviderError(ERROR_CODES.MODEL_NOT_FOUND, `unknown model: ${alias}`);
  }
  return { provider, route: { providerId: defaultProviderId as string, model: alias } };
}
