// GatewayProvider：Qoder Client Gateway 私有协议的出站适配器（实验性）。
// 上游细节全部吸收在本目录内；协议事实来自公开逆向参考实现，
// 未经真实账号验证（计划文档 U3/U4 风险），能力声明保守 + 注记。
import { randomUUID } from "node:crypto";
import { ERROR_CODES, ProviderError } from "../../core/errors.js";
import { assertCapability } from "../../core/capabilities.js";
import { GATEWAY_REGIONS, GatewayAuth, gatewayEndpoints } from "./auth.js";
import { GatewayClient } from "./client.js";
import { ModelCatalog, extractCatalog, resolveModelKey } from "./models.js";
import { newChatTemplate } from "./chatTemplate.js";
import { extractEnvelopeDelta, extractEnvelopeUsage, parseEnvelope } from "./normalize.js";

export class GatewayProvider {
  id = "gateway";

  constructor({
    pat,
    fetchImpl = globalThis.fetch,
    region = GATEWAY_REGIONS.cn,
    requestTimeoutMs = 600000,
    modelCacheTtlMs = 600000,
    defaultModel = "",
    auth,
    client,
  } = {}) {
    // 客户端未指定模型时的兜底（如 QODER_GATEWAY_DEFAULT_MODEL=Qwen3.8-Flash）；
    // 未配置则用目录里的 is_default 项。
    this.defaultModel = String(defaultModel || "").trim();
    this.auth = auth || new GatewayAuth({ pat, fetchImpl, region });
    this.endpoints = gatewayEndpoints(region);
    this.client =
      client ||
      new GatewayClient({
        auth: this.auth,
        endpoints: this.endpoints,
        fetchImpl,
        requestTimeoutMs,
      });
    this.catalog = new ModelCatalog({
      ttlMs: modelCacheTtlMs,
      fetchModels: async () => {
        const raw = await this.client.getJson(this.endpoints.modelList);
        return extractCatalog(raw);
      },
    });
  }

  capabilities() {
    // 2026-09-29 真实账号端到端验证：text/thinking/usage 已确认（reasoning_content
    // 增量 + 流末 usage 信封）；tools/vision 通道仍未消融验证，漂移时首先怀疑。
    return {
      streaming: true,
      cancellation: true,
      sessions: "none",
      tools: "native",
      thinking: "native",
      vision: "native",
      modelDiscovery: "dynamic",
      usage: "native",
      resume: "none",
    };
  }

  async listModels() {
    const catalog = await this.catalog.get();
    return catalog
      .filter((model) => model.enabled)
      .map((model) => ({
        id: model.displayName,
        label: model.displayName,
        upstreamKey: model.key,
        vision: model.vision,
      }));
  }

  async *stream(request, context) {
    assertCapability(this.capabilities(), request);
    let model;
    try {
      const catalog = await this.catalog.get();
      const requested =
        !request.model || request.model === "default" ? this.defaultModel || "default" : request.model;
      model = resolveModelKey(catalog, requested);
      if (!model) {
        throw new ProviderError(ERROR_CODES.MODEL_NOT_FOUND, `unknown gateway model: ${request.model}`);
      }
    } catch (error) {
      yield { type: "error", error: toProviderError(error, context.signal) };
      return;
    }

    const body = buildChatRequestBody(request, model);
    const openTools = new Set();

    try {
      for await (const line of this.client.streamEvents(this.endpoints.chatSse, body, { signal: context.signal })) {
        const parsed = parseEnvelope(line);
        if (!parsed) continue;
        if (parsed.authError) {
          yield { type: "error", error: parsed.authError };
          return;
        }
        if (parsed.error) {
          yield { type: "error", error: parsed.error };
          return;
        }
        const delta = extractEnvelopeDelta(parsed.body);
        if (delta.thinking) yield { type: "thinking.delta", text: delta.thinking };
        if (delta.text) yield { type: "text.delta", text: delta.text };
        for (const call of delta.toolCalls) {
          const index = typeof call.index === "number" ? call.index : 0;
          if (!openTools.has(index)) {
            openTools.add(index);
            yield {
              type: "tool.start",
              index,
              id: call.id || `call_${index}`,
              name: call.function?.name || "",
            };
          }
          if (typeof call.function?.arguments === "string" && call.function.arguments) {
            yield { type: "tool.arguments.delta", index, json: call.function.arguments };
          }
        }
        const usage = extractEnvelopeUsage(parsed.body);
        if (usage) {
          yield { type: "usage", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
        }
      }
      for (const index of [...openTools].sort((a, b) => a - b)) {
        yield { type: "tool.end", index };
      }
      yield { type: "message.end", stopReason: openTools.size ? "tool_use" : "stop" };
    } catch (error) {
      yield { type: "error", error: toProviderError(error, context.signal) };
    }
  }
}

// CanonicalRequest → gateway chat body。消息映射遵循参考实现的 wire 形状：
// user 用 contents parts，assistant/tool 用结构化 content。
export function buildChatRequestBody(request, model) {
  const body = newChatTemplate();
  const now = Date.now();
  body.request_id = randomUUID();
  body.request_set_id = randomUUID();
  body.chat_record_id = body.request_id;
  body.session_id = randomUUID();
  body.business.id = randomUUID();
  body.business.begin_at = now;

  body.model_config.key = model.key;
  body.model_config.is_reasoning = true;
  body.chat_context.extra.modelConfig.key = model.key;
  body.chat_context.extra.modelConfig.is_reasoning = true;
  body.aliyun_user_type = "personal_standard";

  const prompt = latestUserText(request);
  body.chat_context.text.text = prompt;
  body.chat_context.extra.originalContent.text = prompt;
  body.business.name = prompt.slice(0, 30);

  const images = collectImages(request.messages);
  if (images.length) {
    body.model_config.is_vl = true;
    body.chat_context.extra.modelConfig.is_vl = true;
  }
  body.messages = mapMessages(request);
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.inputSchema ?? {},
      },
    }));
    if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
  }
  return body;
}

function blankResponseMeta() {
  return {
    id: "",
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      completion_tokens_details: { reasoning_tokens: 0 },
      prompt_tokens_details: { cached_tokens: 0 },
    },
  };
}

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

function latestUserText(request) {
  for (let i = (request.messages ?? []).length - 1; i >= 0; i -= 1) {
    if (request.messages[i]?.role === "user") {
      const text = messageText(request.messages[i]).trim();
      if (text) return text;
    }
  }
  return "";
}

function collectImages(messages) {
  const urls = [];
  for (const message of messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const url = part?.source?.url || part?.source?.data;
      if (part?.type === "image" && typeof url === "string") urls.push(url);
    }
  }
  return urls;
}

function mapMessages(request) {
  const rebuilt = [];
  for (const message of request.messages ?? []) {
    const text = messageText(message);
    if (message.role === "user") {
      const parts = collectImages([message]).map((url) => ({
        type: "image_url",
        image_url: { url },
      }));
      if (text.trim()) parts.push({ type: "text", text });
      if (!parts.length) continue;
      rebuilt.push({ role: "user", content: "", contents: parts, response_meta: blankResponseMeta() });
      continue;
    }
    if (message.role === "tool") {
      const entry = {
        role: "tool",
        content: text,
        response_meta: blankResponseMeta(),
        reasoning_content_signature: "",
      };
      if (message.name) entry.name = message.name;
      if (message.toolCallId) entry.tool_call_id = message.toolCallId;
      rebuilt.push(entry);
      continue;
    }
    if (!text.trim() && !message.toolCalls?.length) continue;
    const entry = {
      role: message.role === "assistant" ? "assistant" : message.role,
      content: text,
      response_meta: blankResponseMeta(),
      reasoning_content_signature: "",
    };
    if (message.toolCalls?.length) {
      entry.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
    }
    rebuilt.push(entry);
  }
  return rebuilt;
}

function toProviderError(error, signal) {
  if (error instanceof ProviderError) return error;
  if (signal?.aborted || error?.name === "AbortError") {
    return new ProviderError(ERROR_CODES.PROVIDER_ABORTED, "request aborted before gateway finished");
  }
  return new ProviderError(ERROR_CODES.PROVIDER_UNAVAILABLE, error?.message || String(error), {
    cause: error,
  });
}
