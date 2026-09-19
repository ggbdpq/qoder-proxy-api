const DEFAULT_CLOUD_BASE_URL = 'https://api.qoder.com/api/v1/cloud';
const DEFAULT_MODEL_ID = 'qoder-agent-default';

export function normalizeCloudBaseUrl(value) {
  const raw = String(value || DEFAULT_CLOUD_BASE_URL).trim().replace(/\/+$/, '');
  if (raw.endsWith('/api/v1/cloud')) return raw;
  if (raw.endsWith('/api/v1')) return `${raw}/cloud`;
  return `${raw}/api/v1/cloud`;
}

export function parseBoolean(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

export function parsePositiveInt(value, defaultValue) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
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
      agentId: env.QODER_AGENT_ID || '',
      environmentId: env.QODER_ENVIRONMENT_ID || '',
      agentVersion: env.QODER_AGENT_VERSION ? Number(env.QODER_AGENT_VERSION) : undefined,
      title: env.QODER_SESSION_TITLE || 'Qoder Proxy API session',
    },
  });
}

export function normalizeModelMap(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('QODER_MODEL_MAP must be a JSON object keyed by client-visible model id');
  }

  const result = {};
  for (const [modelId, rawSpec] of Object.entries(input)) {
    const id = String(modelId).trim();
    if (!id) continue;
    const spec = rawSpec && typeof rawSpec === 'object' ? rawSpec : {};
    result[id] = {
      modelId: id,
      agentId: String(spec.agentId || spec.agent_id || '').trim(),
      environmentId: String(spec.environmentId || spec.environment_id || '').trim(),
      agentVersion: spec.agentVersion ?? spec.agent_version,
      title: String(spec.title || `Qoder proxy: ${id}`),
      metadata: spec.metadata && typeof spec.metadata === 'object' ? spec.metadata : {},
    };
  }

  if (Object.keys(result).length === 0) {
    throw new Error('QODER_MODEL_MAP resolved to zero models');
  }
  return result;
}

export function loadConfig(env = process.env) {
  const modelMap = parseModelMap(env);
  return {
    host: env.HOST || '127.0.0.1',
    port: parsePositiveInt(env.PORT || env.QODER_PROXY_PORT, 8320),
    proxyApiKey: env.PROXY_API_KEY || env.QODER_PROXY_API_KEY || '',
    qoderAccessToken: env.QODER_ACCESS_TOKEN || env.QODER_PERSONAL_ACCESS_TOKEN || '',
    qoderApiBaseUrl: normalizeCloudBaseUrl(env.QODER_API_BASE_URL),
    requestTimeoutMs: parsePositiveInt(env.QODER_REQUEST_TIMEOUT_MS, 10 * 60 * 1000),
    archiveEphemeralSessions: parseBoolean(env.QODER_ARCHIVE_EPHEMERAL, true),
    sessionTtlMs: parsePositiveInt(env.QODER_SESSION_TTL_MS, 2 * 60 * 60 * 1000),
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
  if (!value) return '';
  if (value.length <= 10) return '***';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}
