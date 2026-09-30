// OpenAI Chat / Responses 下游请求 → CanonicalRequest。
// v0.1 行为保留：image 部件降级为占位文本，无法扁平化的内容丢弃。
import { HttpError } from "../../server/http.ts";
import type { IncomingBody } from "../../server/http.ts";
import type { CanonicalMessage, CanonicalRequest, CanonicalTool } from "../../core/request.ts";

// 动态 wire 载荷的统一窄化入口：对象 → Record，其余 → null。
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function chatToCanonical(body: IncomingBody, model: string): CanonicalRequest {
  const system: string[] = [];
  const messages: CanonicalMessage[] = [];
  for (const message of body.messages ?? []) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "user").toLowerCase();
    const text = flattenContent(message.content);
    if (!text) continue;
    if (role === "system" || role === "developer") {
      system.push(text);
      continue;
    }
    messages.push({
      role: role === "assistant" ? "assistant" : role === "tool" ? "tool" : "user",
      content: text,
    });
  }
  return {
    model,
    system: system.length ? system.join("\n") : undefined,
    messages,
    tools: mapOpenAiTools(body.tools),
    maxTokens: (body.max_tokens as number | undefined) ?? undefined,
    temperature: (body.temperature as number | undefined) ?? undefined,
    metadata: { title: body.metadata?.title || body.title },
  };
}

// OpenAI function tools → CanonicalTool；非 function 类型原样丢弃（无消费方）。
function mapOpenAiTools(tools: unknown): CanonicalTool[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const mapped: CanonicalTool[] = [];
  for (const tool of tools) {
    const rec = asRecord(tool);
    const fn = asRecord(rec?.function);
    if (rec?.type !== "function" || !fn?.name) continue;
    mapped.push({
      name: fn.name as string,
      description: (fn.description as string | undefined) || undefined,
      inputSchema: (fn.parameters ?? {}) as Record<string, unknown>,
    });
  }
  return mapped.length ? mapped : undefined;
}

export function responsesToCanonical(body: IncomingBody, model: string): CanonicalRequest {
  const system: string[] = [];
  const messages: CanonicalMessage[] = [];
  const input = body.input;
  if (typeof input === "string") {
    if (input.trim()) messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      const rec = asRecord(item);
      if (typeof item === "string") {
        if (item.trim()) messages.push({ role: "user", content: item });
        continue;
      }
      if (!rec?.role && !rec?.content) continue;
      const role = String(rec.role || "user").toLowerCase();
      const text = flattenOpenAiItemContent(rec.content || rec.text || rec);
      if (!text) continue;
      if (role === "system" || role === "developer" || role === "instructions") {
        system.push(text);
        continue;
      }
      messages.push({ role: role === "assistant" ? "assistant" : "user", content: text });
    }
  }
  if (body.instructions) system.unshift(String(body.instructions));
  const tools = mapResponsesTools(body.tools);
  return {
    model,
    system: system.length ? system.join("\n") : undefined,
    messages,
    tools: tools?.length ? tools : undefined,
    maxTokens: (body.max_output_tokens as number | undefined) ?? undefined,
    temperature: (body.temperature as number | undefined) ?? undefined,
    metadata: { title: body.metadata?.title || body.title },
  };
}

// Responses 的 function tools 顶层平铺（name/parameters），与 chat 的嵌套结构不同。
function mapResponsesTools(tools: unknown): CanonicalTool[] {
  if (!Array.isArray(tools)) return [];
  const mapped: CanonicalTool[] = [];
  for (const tool of tools) {
    const rec = asRecord(tool);
    if (!rec?.name || rec.type !== "function") continue;
    mapped.push({
      name: rec.name as string,
      description: (rec.description as string | undefined) || undefined,
      inputSchema: (rec.parameters ?? {}) as Record<string, unknown>,
    });
  }
  return mapped;
}

// v0.1 的 contentToText 语义：text/content 字段优先，image 部件转占位文本。
function flattenContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const rec = asRecord(part);
        if (!rec) return "";
        if (typeof rec.text === "string") return rec.text;
        if (typeof rec.content === "string") return rec.content;
        if (rec.type === "image_url") {
          const url = asRecord(rec.image_url)?.url;
          return `[image: ${url || "attached"}]`;
        }
        if (rec.type === "input_image")
          return `[image: ${rec.image_url || rec.file_id || "attached"}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  const rec = asRecord(content);
  if (typeof rec?.text === "string") return rec.text;
  if (typeof rec?.content === "string") return rec.content;
  return "";
}

function flattenOpenAiItemContent(content: unknown): string {
  return flattenContent(content);
}

export function assertHasText(request: CanonicalRequest, message: string): void {
  const hasSystem = Boolean(request.system && String(request.system).trim());
  const hasMessage = (request.messages ?? []).some((m) => String(m.content).trim());
  if (!hasSystem && !hasMessage) {
    throw new HttpError(400, message);
  }
}
