// 启动组装：--provider 参数 → Provider 实例 + 注册表 + 路由表。
// 默认 provider 是 gateway（任务要求）；显式路由之外的模型名直通默认
// provider 并由其模型解析器裁决（这是路由策略，不是故障 fallback）。
import { GatewayProvider } from "./providers/gateway/index.ts";
import { CliProvider } from "./providers/cli/index.ts";
import { CloudAgentsClient, SessionStore } from "./providers/cloudAgents/client.ts";
import { CloudAgentsProvider } from "./providers/cloudAgents/index.ts";
import { loadCliConfig } from "./providers/cli/config.ts";
import { GATEWAY_REGIONS } from "./providers/gateway/auth.ts";
import { createProviderRegistry } from "./routing/providerRegistry.ts";
import { parseModelRoutes } from "./routing/modelRouter.ts";
import { loadConfig } from "./config.ts";
import type { AppConfig } from "./config.ts";
import type { QoderProvider } from "./core/provider.ts";
import type { ProviderRegistry } from "./routing/providerRegistry.ts";
import type { ModelRoutes } from "./routing/modelRouter.ts";

export const PROVIDER_IDS = ["gateway", "cli", "cloudAgents"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export function resolveProviderId(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): ProviderId {
  const normalize = (value: string): string => (value === "cloud-agents" ? "cloudAgents" : value);
  for (const arg of argv) {
    const match = String(arg).match(/^--provider=(.+)$/);
    if (match) {
      const id = normalize(match[1].trim());
      if (!(PROVIDER_IDS as readonly string[]).includes(id)) {
        throw new Error(`unknown provider "${match[1]}"; valid: gateway, cli, cloud-agents`);
      }
      return id as ProviderId;
    }
  }
  const fromEnv = String(env.QODER_DEFAULT_PROVIDER || "").trim();
  if (fromEnv) {
    const id = normalize(fromEnv);
    if (!(PROVIDER_IDS as readonly string[]).includes(id)) {
      throw new Error(
        `unknown QODER_DEFAULT_PROVIDER "${fromEnv}"; valid: gateway, cli, cloud-agents`,
      );
    }
    return id as ProviderId;
  }
  return "gateway";
}

export interface CreateAppOptions {
  providerId?: ProviderId;
  env?: NodeJS.ProcessEnv;
  config?: AppConfig;
}

export interface CreateAppResult {
  config: AppConfig;
  registry: ProviderRegistry;
  modelRoutes: ModelRoutes;
  defaultProviderId: ProviderId | undefined;
}

export function createApp({
  providerId,
  env = process.env,
  config = loadConfig(env),
}: CreateAppOptions = {}): CreateAppResult {
  const registry = createProviderRegistry();

  // Provider 类的 id 字段被声明为拓宽的 string；运行时即注册 id 本身，
  // 在组装点按 QoderProvider 契约收窄（纯编译期，无行为变化）。
  if (providerId === "gateway") {
    const regionKey = (env.QODER_GATEWAY_REGION || "cn") as keyof typeof GATEWAY_REGIONS;
    registry.register(
      new GatewayProvider({
        pat: env.QODER_GATEWAY_PAT,
        region: GATEWAY_REGIONS[regionKey] || GATEWAY_REGIONS.cn,
        requestTimeoutMs: config.requestTimeoutMs,
        modelCacheTtlMs: Number(env.QODER_GATEWAY_MODEL_CACHE_TTL_MS) || 600000,
        defaultModel: env.QODER_GATEWAY_DEFAULT_MODEL || "",
      }) as unknown as QoderProvider,
    );
  } else if (providerId === "cli") {
    registry.register(
      new CliProvider({ cliConfig: loadCliConfig(env) }) as unknown as QoderProvider,
    );
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
      }) as unknown as QoderProvider,
    );
  }

  const modelRoutes = parseModelRoutes({
    modelMap: providerId === "cloudAgents" ? config.modelMap : {},
    routesJson: config.modelRoutes,
  });

  return { config, registry, modelRoutes, defaultProviderId: providerId };
}
