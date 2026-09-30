// Gateway 模型目录：动态拉取 + 解析，失败保留上一份成功目录。
// 响应结构（公开协议参考实现）：{"chat": [{key, display_name, enable, is_vl, is_default}]}
// 兜底目录：2026-09-29 真实账号拉取的目录快照（动态拉取失败时使用）。
import { isRecord } from "./normalize.ts";

// 目录条目：enabled/isDefault 在兜底表中可省略（fallbackCatalog 统一补 enabled）。
export interface GatewayModel {
  key: string;
  displayName: string;
  vision: boolean;
  enabled?: boolean;
  isDefault?: boolean;
}

const FALLBACK_CATALOG: GatewayModel[] = [
  { key: "auto", displayName: "Auto", vision: true, isDefault: true },
  { key: "qmodel_38max", displayName: "Qwen3.8-Max", vision: true },
  { key: "qfmodel", displayName: "Qwen3.8-Flash", vision: true },
  { key: "qmodel_latest", displayName: "Qwen3.7-Max", vision: true },
  { key: "qmodel", displayName: "Qwen3.7-Plus", vision: true },
  { key: "q37fmodel", displayName: "Qwen3.7-Flash", vision: true },
  { key: "dmodel", displayName: "DeepSeek-V4-Pro", vision: true },
  { key: "dfmodel", displayName: "DeepSeek-Flash", vision: true },
  { key: "gmodel", displayName: "GLM-5.3", vision: true },
  { key: "gfmodel", displayName: "GLM-5.3-Flash", vision: true },
  { key: "gm51model", displayName: "GLM-5.2", vision: true },
  { key: "kmodel_latest", displayName: "Kimi-K3", vision: true },
  { key: "kmodel", displayName: "Kimi-K2.8-Preview", vision: true },
  { key: "mmodel", displayName: "MiniMax-M2.7", vision: false },
];

export function extractCatalog(raw: unknown): GatewayModel[] {
  const chat: unknown[] = isRecord(raw) && Array.isArray(raw.chat) ? raw.chat : [];
  const models: GatewayModel[] = [];
  for (const entry of chat) {
    if (!isRecord(entry)) continue;
    const { key, display_name } = entry;
    if (!key || !display_name) continue;
    models.push({
      key: String(key),
      displayName: String(display_name),
      vision: Boolean(entry.is_vl),
      enabled: entry.enable === undefined ? true : Boolean(entry.enable),
      isDefault: Boolean(entry.is_default),
    });
  }
  return models;
}

export function fallbackCatalog(): GatewayModel[] {
  return FALLBACK_CATALOG.map((model) => ({ ...model, enabled: true }));
}

// 目录缓存 + TTL；拉取失败时保留上一份并抛给调用方决定（provider 返回缓存）。
export class ModelCatalog {
  fetchModels: () => Promise<GatewayModel[]>;
  ttlMs: number;
  cache: GatewayModel[] | null;
  fetchedAt: number;
  inFlight: Promise<GatewayModel[]> | null;
  lastError?: unknown;

  constructor({
    fetchModels,
    ttlMs = 10 * 60 * 1000,
  }: {
    fetchModels?: () => Promise<GatewayModel[]>;
    ttlMs?: number;
  } = {}) {
    // 运行时未注入则首次 get() 才会失败（v0.1 不做兜底）。
    this.fetchModels = fetchModels!;
    this.ttlMs = ttlMs;
    this.cache = null;
    this.fetchedAt = 0;
    this.inFlight = null;
  }

  async get({ force = false } = {}): Promise<GatewayModel[]> {
    if (!force && this.cache && Date.now() - this.fetchedAt < this.ttlMs) return this.cache;
    if (!this.inFlight) {
      this.inFlight = this.fetchModels()
        .then((models) => {
          if (models.length) {
            this.cache = models;
            this.fetchedAt = Date.now();
          }
          return this.cache ?? fallbackCatalog();
        })
        .catch((error) => {
          // 保留上一份成功目录（可能为 null → 兜底表）。
          this.lastError = error;
          return this.cache ?? fallbackCatalog();
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.inFlight;
  }
}

export function resolveModelKey(
  catalog: GatewayModel[],
  requested: string,
): GatewayModel | null | undefined {
  if (!requested || requested === "default") {
    return (
      catalog.find((model) => model.isDefault && model.enabled) ??
      catalog.find((model) => model.enabled)
    );
  }
  const byKey = catalog.find((model) => model.enabled && model.key === requested);
  if (byKey) return byKey;
  const byName = catalog.find((model) => model.enabled && model.displayName === requested);
  if (byName) return byName;
  return null;
}
