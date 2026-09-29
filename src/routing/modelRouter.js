// 模型路由：客户端可见别名 → { providerId, model }。
// QODER_MODEL_MAP 兼容（别名归属 cloudAgents）；QODER_MODEL_ROUTES 显式指定并覆盖同别名。
// 显式路由是唯一路由方式：不做 Provider 自动 fallback。
import { ERROR_CODES, ProviderError } from "../core/errors.js";

const CLOUD_AGENTS_ID = "cloudAgents";

// 返回 Map<alias, { providerId, model }>
export function parseModelRoutes({ modelMap, routesJson } = {}) {
  const routes = new Map();
  for (const alias of Object.keys(modelMap ?? {})) {
    routes.set(alias, { providerId: CLOUD_AGENTS_ID, model: alias });
  }

  if (routesJson && String(routesJson).trim()) {
    let parsed;
    try {
      parsed = JSON.parse(routesJson);
    } catch (error) {
      throw new Error(`QODER_MODEL_ROUTES is not valid JSON: ${error.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("QODER_MODEL_ROUTES must be a JSON object keyed by model alias");
    }
    for (const [alias, raw] of Object.entries(parsed)) {
      const providerId = String(raw?.provider || "").trim();
      const model = String(raw?.model || alias).trim();
      if (!providerId) {
        throw new Error(`QODER_MODEL_ROUTES["${alias}"] is missing "provider"`);
      }
      routes.set(String(alias).trim(), { providerId, model });
    }
  }
  return routes;
}

export async function resolveModel(registry, routes, requestedModel, { defaultProviderId } = {}) {
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
  return { provider, route: { providerId: defaultProviderId, model: alias } };
}
