// Cloud Agents 专属配置解析，自 src/config.js 迁入（全局配置拆分在后续 commit 完成）。
const DEFAULT_CLOUD_BASE_URL = "https://api.qoder.com/api/v1/cloud";
const DEFAULT_MODEL_ID = "qoder-agent-default";

export function normalizeCloudBaseUrl(value) {
  const raw = String(value || DEFAULT_CLOUD_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  if (raw.endsWith("/api/v1/cloud")) return raw;
  if (raw.endsWith("/api/v1")) return `${raw}/cloud`;
  return `${raw}/api/v1/cloud`;
}

export function parseModelMap(env = process.env) {
  const inline = env.QODER_MODEL_MAP || env.QODER_MODELS_JSON;
  if (inline && inline.trim()) {
    const parsed = JSON.parse(inline);
    return normalizeModelMap(parsed);
  }

  const modelId = env.QODER_MODEL_ID || env.QODER_DEFAULT_MODEL || DEFAULT_MODEL_ID;
  return normalizeModelMap({
    [modelId]: {
      agentId: env.QODER_AGENT_ID || "",
      environmentId: env.QODER_ENVIRONMENT_ID || "",
      agentVersion: env.QODER_AGENT_VERSION ? Number(env.QODER_AGENT_VERSION) : undefined,
      title: env.QODER_SESSION_TITLE || "Qoder Proxy API session",
    },
  });
}

export function normalizeModelMap(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("QODER_MODEL_MAP must be a JSON object keyed by client-visible model id");
  }

  const result = {};
  for (const [modelId, rawSpec] of Object.entries(input)) {
    const id = String(modelId).trim();
    if (!id) continue;
    const spec = rawSpec && typeof rawSpec === "object" ? rawSpec : {};
    result[id] = {
      modelId: id,
      agentId: String(spec.agentId || spec.agent_id || "").trim(),
      environmentId: String(spec.environmentId || spec.environment_id || "").trim(),
      agentVersion: spec.agentVersion ?? spec.agent_version,
      title: String(spec.title || `Qoder proxy: ${id}`),
      metadata: spec.metadata && typeof spec.metadata === "object" ? spec.metadata : {},
    };
  }

  if (Object.keys(result).length === 0) {
    throw new Error("QODER_MODEL_MAP resolved to zero models");
  }
  return result;
}
