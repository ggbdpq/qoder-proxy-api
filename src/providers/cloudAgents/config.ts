// Cloud Agents 专属配置解析，自 src/config.js 迁入（全局配置拆分在后续 commit 完成）。
import { isRecord } from "./normalize.ts";
import type { JsonRecord } from "./normalize.ts";

const DEFAULT_CLOUD_BASE_URL = "https://api.qoder.com/api/v1/cloud";
const DEFAULT_MODEL_ID = "qoder-agent-default";

// 模型表条目：normalizeModelMap 的产出形状（与 src/config.ts 的 ModelMapEntry 对齐）。
export interface CloudModelSpec {
  modelId: string;
  agentId: string;
  environmentId: string;
  // 来源 JSON 的透传值：消费处按需 Number()/比较，不做类型收窄（v0.1 原语义）。
  agentVersion?: unknown;
  title?: string;
  metadata?: Record<string, unknown>;
}

export function normalizeCloudBaseUrl(value: string | undefined): string {
  const raw = String(value || DEFAULT_CLOUD_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  if (raw.endsWith("/api/v1/cloud")) return raw;
  if (raw.endsWith("/api/v1")) return `${raw}/cloud`;
  return `${raw}/api/v1/cloud`;
}

export function parseModelMap(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, CloudModelSpec> {
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

export function normalizeModelMap(input: unknown): Record<string, CloudModelSpec> {
  if (!isRecord(input) || Array.isArray(input)) {
    throw new Error("QODER_MODEL_MAP must be a JSON object keyed by client-visible model id");
  }

  const result: Record<string, CloudModelSpec> = {};
  for (const [modelId, rawSpec] of Object.entries(input)) {
    const id = String(modelId).trim();
    if (!id) continue;
    const spec: JsonRecord = isRecord(rawSpec) ? rawSpec : {};
    result[id] = {
      modelId: id,
      agentId: String(spec.agentId || spec.agent_id || "").trim(),
      environmentId: String(spec.environmentId || spec.environment_id || "").trim(),
      agentVersion: spec.agentVersion ?? spec.agent_version,
      title: String(spec.title || `Qoder proxy: ${id}`),
      metadata: isRecord(spec.metadata) ? spec.metadata : {},
    };
  }

  if (Object.keys(result).length === 0) {
    throw new Error("QODER_MODEL_MAP resolved to zero models");
  }
  return result;
}
