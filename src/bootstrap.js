// 启动组装：--provider 参数 → Provider 实例 + 注册表 + 路由表。
// 默认 provider 是 gateway（任务要求）；显式路由之外的模型名直通默认
// provider 并由其模型解析器裁决（这是路由策略，不是故障 fallback）。
import { GatewayProvider } from "./providers/gateway/index.js";
import { CliProvider } from "./providers/cli/index.js";
import { CloudAgentsClient, SessionStore } from "./providers/cloudAgents/client.js";
import { CloudAgentsProvider } from "./providers/cloudAgents/index.js";
import { loadCliConfig } from "./providers/cli/config.js";
import { GATEWAY_REGIONS } from "./providers/gateway/auth.js";
import { createProviderRegistry } from "./routing/providerRegistry.js";
import { parseModelRoutes } from "./routing/modelRouter.js";
import { loadConfig } from "./config.js";

export const PROVIDER_IDS = ["gateway", "cli", "cloudAgents"];

export function resolveProviderId(argv = process.argv, env = process.env) {
  const normalize = (value) => (value === "cloud-agents" ? "cloudAgents" : value);
  for (const arg of argv) {
    const match = String(arg).match(/^--provider=(.+)$/);
    if (match) {
      const id = normalize(match[1].trim());
      if (!PROVIDER_IDS.includes(id)) {
        throw new Error(`unknown provider "${match[1]}"; valid: gateway, cli, cloud-agents`);
      }
      return id;
    }
  }
  const fromEnv = String(env.QODER_DEFAULT_PROVIDER || "").trim();
  if (fromEnv) {
    const id = normalize(fromEnv);
    if (!PROVIDER_IDS.includes(id)) {
      throw new Error(`unknown QODER_DEFAULT_PROVIDER "${fromEnv}"; valid: gateway, cli, cloud-agents`);
    }
    return id;
  }
  return "gateway";
}

export function createApp({ providerId, env = process.env, config = loadConfig(env) } = {}) {
  const registry = createProviderRegistry();

  if (providerId === "gateway") {
    registry.register(
      new GatewayProvider({
        pat: env.QODER_GATEWAY_PAT,
        region: GATEWAY_REGIONS[env.QODER_GATEWAY_REGION || "cn"] || GATEWAY_REGIONS.cn,
        requestTimeoutMs: config.requestTimeoutMs,
        modelCacheTtlMs: Number(env.QODER_GATEWAY_MODEL_CACHE_TTL_MS) || 600000,
        defaultModel: env.QODER_GATEWAY_DEFAULT_MODEL || "",
      }),
    );
  } else if (providerId === "cli") {
    registry.register(new CliProvider({ cliConfig: loadCliConfig(env) }));
  } else if (providerId === "cloudAgents") {
    const client = new CloudAgentsClient({
      baseUrl: config.qoderApiBaseUrl,
      accessToken: config.qoderAccessToken,
      requestTimeoutMs: config.requestTimeoutMs,
    });
    registry.register(
      new CloudAgentsProvider({
        client,
        sessionStore: new SessionStore({ ttlMs: config.sessionTtlMs }),
        modelMap: config.modelMap,
        archiveEphemeralSessions: config.archiveEphemeralSessions,
      }),
    );
  }

  const modelRoutes = parseModelRoutes({
    modelMap: providerId === "cloudAgents" ? config.modelMap : {},
    routesJson: config.modelRoutes,
  });

  return { config, registry, modelRoutes, defaultProviderId: providerId };
}
