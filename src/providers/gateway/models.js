// Gateway 模型目录：动态拉取 + 解析，失败保留上一份成功目录。
// 响应结构（公开协议参考实现）：{"chat": [{key, display_name, enable, is_vl, is_default}]}
// 兜底目录：2026-09-29 真实账号拉取的目录快照（动态拉取失败时使用）。
const FALLBACK_CATALOG = [
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

export function extractCatalog(raw) {
  const chat = Array.isArray(raw?.chat) ? raw.chat : [];
  const models = chat
    .filter((item) => item && item.key && item.display_name)
    .map((item) => ({
      key: String(item.key),
      displayName: String(item.display_name),
      vision: Boolean(item.is_vl),
      enabled: item.enable === undefined ? true : Boolean(item.enable),
      isDefault: Boolean(item.is_default),
    }));
  return models;
}

export function fallbackCatalog() {
  return FALLBACK_CATALOG.map((model) => ({ ...model, enabled: true }));
}

// 目录缓存 + TTL；拉取失败时保留上一份并抛给调用方决定（provider 返回缓存）。
export class ModelCatalog {
  constructor({ fetchModels, ttlMs = 10 * 60 * 1000 } = {}) {
    this.fetchModels = fetchModels;
    this.ttlMs = ttlMs;
    this.cache = null;
    this.fetchedAt = 0;
    this.inFlight = null;
  }

  async get({ force = false } = {}) {
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

export function resolveModelKey(catalog, requested) {
  if (!requested || requested === "default") {
    return catalog.find((model) => model.isDefault && model.enabled) ?? catalog.find((model) => model.enabled);
  }
  const byKey = catalog.find((model) => model.enabled && model.key === requested);
  if (byKey) return byKey;
  const byName = catalog.find((model) => model.enabled && model.displayName === requested);
  if (byName) return byName;
  return null;
}
