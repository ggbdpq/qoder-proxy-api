// Gateway SSE envelope → Canonical Event。
// envelope：data:{"body":"<json string>","statusCodeValue":200,"statusCode":"OK"}
// body 内为 OpenAI 风格 {choices:[{delta:{role,content,reasoning_content,tool_calls}}]}。
// 流内鉴权失败以 401/403 或 body.code=="105" 出现（HTTP 层仍是 200）。
import { ERROR_CODES, ProviderError } from "../../core/errors.ts";

// 宽松 JSON 记录：动态取值的统一读取形状（值保持 unknown，消费处自行窄化）。
export type JsonRecord = { [key: string]: unknown };

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

// envelope body 内 provider 实际消费的字段（OpenAI 风格 delta 载荷 + usage 信封）。
export interface GatewayEnvelopeBody {
  [key: string]: unknown;
  code?: unknown;
  message?: unknown;
  error?: { message?: unknown };
  usage?: unknown;
  choices?: unknown;
}

// SSE envelope 外层（data: 行的 JSON）。
interface EnvelopeWrapper {
  statusCodeValue?: number;
  body?: GatewayEnvelopeBody | string | null;
  [key: string]: unknown;
}

export interface ParsedEnvelope {
  authError?: ProviderError;
  error?: ProviderError;
  body?: GatewayEnvelopeBody;
}

// OpenAI 风格 delta 载荷中消费的字段；取值处仍有 typeof/Array.isArray 守卫。
interface GatewayDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: GatewayToolCallDelta[];
}

interface GatewayChoiceDelta {
  delta?: GatewayDelta;
}

export interface GatewayToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export function parseEnvelope(line: string): ParsedEnvelope | null {
  if (!line?.startsWith("data:")) return null;
  const raw = line.slice(5).trim();
  if (!raw) return null;
  let wrapper: EnvelopeWrapper;
  try {
    wrapper = JSON.parse(raw);
  } catch {
    return null; // 心跳/注释等非 JSON 行跳过
  }
  if (!wrapper || typeof wrapper !== "object") return null;

  const statusValue = wrapper.statusCodeValue;
  if (statusValue === 401 || statusValue === 403) {
    return {
      authError: new ProviderError(
        ERROR_CODES.PROVIDER_AUTH_ERROR,
        `gateway stream auth error: ${statusValue} ${extractBodyMessage(wrapper)}`,
      ),
    };
  }

  let body = wrapper.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!body || typeof body !== "object") return null;
  if (String(body.code) === "105") {
    return {
      authError: new ProviderError(
        ERROR_CODES.PROVIDER_AUTH_ERROR,
        `gateway stream auth error: login expired ${body.message ?? ""}`.trim(),
      ),
    };
  }
  if (body.error || (statusValue && statusValue >= 400)) {
    return {
      error: new ProviderError(
        ERROR_CODES.PROVIDER_PROTOCOL_ERROR,
        typeof body.error?.message === "string"
          ? body.error.message
          : JSON.stringify(body).slice(0, 300),
      ),
    };
  }
  return { body };
}

// 一条 envelope body 的 delta 提取。tool_calls 的 start/end 生命周期由
// provider 流循环维护（index 出现即 start，流结束统一 end）。
export function extractEnvelopeDelta(body: GatewayEnvelopeBody | undefined): {
  text: string;
  thinking: string;
  toolCalls: GatewayToolCallDelta[];
} {
  const choices: GatewayChoiceDelta[] = Array.isArray(body?.choices) ? body.choices : [];
  let text = "";
  let thinking = "";
  let toolCalls: GatewayToolCallDelta[] = [];
  for (const choice of choices) {
    const delta = choice?.delta;
    if (!delta || typeof delta !== "object") continue;
    if (typeof delta.content === "string" && delta.content) text += delta.content;
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      thinking += delta.reasoning_content;
    }
    if (Array.isArray(delta.tool_calls)) toolCalls.push(...delta.tool_calls);
  }
  return { text, thinking, toolCalls };
}

// usage 信封（流末尾 choices 为空、usage 有值）：真实样本为
// {prompt_tokens, completion_tokens, completion_tokens_details:{reasoning_tokens}, credits}
export function extractEnvelopeUsage(
  body: GatewayEnvelopeBody | undefined,
): { inputTokens: number; outputTokens: number } | null {
  const usage = body?.usage;
  if (!isRecord(usage)) return null;
  return {
    inputTokens: Number(usage.prompt_tokens) || 0,
    outputTokens: Number(usage.completion_tokens) || 0,
  };
}

function extractBodyMessage(wrapper: EnvelopeWrapper): string {
  let body = wrapper?.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return "";
    }
  }
  if (body && typeof body === "object") {
    return String(body.message ?? body.code ?? "");
  }
  return "";
}
