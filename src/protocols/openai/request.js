// OpenAI Chat / Responses 下游请求 → CanonicalRequest。
// v0.1 行为保留：image 部件降级为占位文本，无法扁平化的内容丢弃。
import { HttpError } from "../../server/http.js";

export function chatToCanonical(body, model) {
  const system = [];
  const messages = [];
  for (const message of body.messages ?? []) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "user").toLowerCase();
    const text = flattenContent(message.content);
    if (!text) continue;
    if (role === "system" || role === "developer") {
      system.push(text);
      continue;
    }
    messages.push({ role: role === "assistant" ? "assistant" : role === "tool" ? "tool" : "user", content: text });
  }
  return {
    model,
    system: system.length ? system.join("\n") : undefined,
    messages,
    tools: mapOpenAiTools(body.tools),
    maxTokens: body.max_tokens ?? undefined,
    temperature: body.temperature ?? undefined,
    metadata: { title: body.metadata?.title || body.title },
  };
}

// OpenAI function tools → CanonicalTool；非 function 类型原样丢弃（无消费方）。
function mapOpenAiTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const mapped = tools
    .filter((tool) => tool?.type === "function" && tool.function?.name)
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description || undefined,
      inputSchema: tool.function.parameters ?? {},
    }));
  return mapped.length ? mapped : undefined;
}

export function responsesToCanonical(body, model) {
  const system = [];
  const messages = [];
  const input = body.input;
  if (typeof input === "string") {
    if (input.trim()) messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        if (item.trim()) messages.push({ role: "user", content: item });
        continue;
      }
      if (!item?.role && !item?.content) continue;
      const role = String(item.role || "user").toLowerCase();
      const text = flattenOpenAiItemContent(item.content || item.text || item);
      if (!text) continue;
      if (role === "system" || role === "developer" || role === "instructions") {
        system.push(text);
        continue;
      }
      messages.push({ role: role === "assistant" ? "assistant" : "user", content: text });
    }
  }
  if (body.instructions) system.unshift(String(body.instructions));
  const tools = Array.isArray(body.tools)
    ? body.tools
        .filter((tool) => tool?.type === "function" && tool.name)
        .map((tool) => ({
          name: tool.name,
          description: tool.description || undefined,
          inputSchema: tool.parameters ?? {},
        }))
    : undefined;
  return {
    model,
    system: system.length ? system.join("\n") : undefined,
    messages,
    tools: tools?.length ? tools : undefined,
    maxTokens: body.max_output_tokens ?? undefined,
    temperature: body.temperature ?? undefined,
    metadata: { title: body.metadata?.title || body.title },
  };
}

// v0.1 的 contentToText 语义：text/content 字段优先，image 部件转占位文本。
function flattenContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
        if (part.type === "image_url") return `[image: ${part.image_url?.url || "attached"}]`;
        if (part.type === "input_image")
          return `[image: ${part.image_url || part.file_id || "attached"}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
  }
  return "";
}

function flattenOpenAiItemContent(content) {
  return flattenContent(content);
}

export function assertHasText(request, message) {
  const hasSystem = Boolean(request.system && String(request.system).trim());
  const hasMessage = (request.messages ?? []).some((m) => String(m.content).trim());
  if (!hasSystem && !hasMessage) {
    throw new HttpError(400, message);
  }
}
