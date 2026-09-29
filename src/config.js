// 全局运行配置。Cloud Agents 专属解析见 providers/cloudAgents/config.js。
import { normalizeCloudBaseUrl, parseModelMap } from "./providers/cloudAgents/config.js";

export { normalizeCloudBaseUrl, parseModelMap, normalizeModelMap } from "./providers/cloudAgents/config.js";

export function parseBoolean(value, defaultValue = false) {
  if (value == null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

export function parsePositiveInt(value, defaultValue) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function loadConfig(env = process.env) {
  const modelMap = parseModelMap(env);
  return {
    host: env.HOST || "127.0.0.1",
    port: parsePositiveInt(env.PORT || env.QODER_PROXY_PORT, 8320),
    proxyApiKey: env.PROXY_API_KEY || env.QODER_PROXY_API_KEY || "",
    qoderAccessToken: env.QODER_ACCESS_TOKEN || env.QODER_PERSONAL_ACCESS_TOKEN || "",
    qoderApiBaseUrl: normalizeCloudBaseUrl(env.QODER_API_BASE_URL),
    requestTimeoutMs: parsePositiveInt(env.QODER_REQUEST_TIMEOUT_MS, 10 * 60 * 1000),
    archiveEphemeralSessions: parseBoolean(env.QODER_ARCHIVE_EPHEMERAL, true),
    sessionTtlMs: parsePositiveInt(env.QODER_SESSION_TTL_MS, 2 * 60 * 60 * 1000),
    modelRoutes: env.QODER_MODEL_ROUTES || "",
    modelMap,
  };
}

export function publicConfig(config) {
  return {
    host: config.host,
    port: config.port,
    qoderApiBaseUrl: config.qoderApiBaseUrl,
    archiveEphemeralSessions: config.archiveEphemeralSessions,
    sessionTtlMs: config.sessionTtlMs,
    models: Object.fromEntries(
      Object.entries(config.modelMap).map(([id, spec]) => [
        id,
        {
          agentId: redactMiddle(spec.agentId),
          environmentId: redactMiddle(spec.environmentId),
          agentVersion: spec.agentVersion,
          title: spec.title,
        },
      ]),
    ),
  };
}

function redactMiddle(value) {
  if (!value) return "";
  if (value.length <= 10) return "***";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}
