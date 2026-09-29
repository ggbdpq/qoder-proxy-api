// Gateway SSE envelope → Canonical Event。
// envelope：data:{"body":"<json string>","statusCodeValue":200,"statusCode":"OK"}
// body 内为 OpenAI 风格 {choices:[{delta:{role,content,reasoning_content,tool_calls}}]}。
// 流内鉴权失败以 401/403 或 body.code=="105" 出现（HTTP 层仍是 200）。
import { ERROR_CODES, ProviderError } from "../../core/errors.js";

export function parseEnvelope(line) {
  if (!line?.startsWith("data:")) return null;
  const raw = line.slice(5).trim();
  if (!raw) return null;
  let wrapper;
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
export function extractEnvelopeDelta(body) {
  const choices = Array.isArray(body?.choices) ? body.choices : [];
  let text = "";
  let thinking = "";
  let toolCalls = [];
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
export function extractEnvelopeUsage(body) {
  const usage = body?.usage;
  if (!usage || typeof usage !== "object") return null;
  return {
    inputTokens: Number(usage.prompt_tokens) || 0,
    outputTokens: Number(usage.completion_tokens) || 0,
  };
}

function extractBodyMessage(wrapper) {
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
