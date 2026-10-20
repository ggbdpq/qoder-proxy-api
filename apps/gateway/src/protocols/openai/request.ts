// OpenAI Chat / Responses 下游请求 → CanonicalRequest。纯文本折叠成字符串（v0.1 形状）；
// 工具、图片、reasoning 保留为 part，不在入口降级。
import { HttpError } from "../../server/http.ts";
import type { IncomingBody } from "../../server/http.ts";
import type {
  CanonicalContentPart,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalTool,
  ImagePart,
  ToolCallPart,
} from "../../core/request.ts";
import { textOf } from "../../core/request.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function withExtras<T extends CanonicalContentPart>(part: T, rec: Record<string, unknown>): T {
  if (rec.cache_control === undefined) return part;
  return { ...part, providerExtras: { cache_control: rec.cache_control } };
}

export function chatToCanonical(body: IncomingBody, model: string): CanonicalRequest {
  const system: string[] = [];
  const messages: CanonicalMessage[] = [];
  for (const message of body.messages ?? []) {
    if (!message || typeof message !== "object") continue;
    const mapped = mapChatMessage(message);
    if (!mapped) continue;
    if (mapped.role === "system") {
      if (typeof mapped.content === "string" && mapped.content) system.push(mapped.content);
      continue;
    }
    messages.push(mapped);
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

function mapChatMessage(message: Record<string, unknown>): CanonicalMessage | undefined {
  const role = String(message.role || "user").toLowerCase();
  const calls = toolCallsOf(message.tool_calls);
  const parts = openAiParts(message.content);
  if (role === "system" || role === "developer") {
    const text = textOf({ content: collapse(parts) ?? "" });
    return text ? { role: "system", content: text } : undefined;
  }
  if (role === "tool") {
    const id = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
    const text = textOf({ content: parts });
    if (!id && !text) return undefined;
    return {
      role: "tool",
      toolCallId: id || undefined,
      content: [{ type: "tool_result", toolCallId: id, content: text }],
    };
  }
  const content = messageContent(parts, calls);
  if (content === undefined) return undefined;
  const canonical: CanonicalMessage = {
    role: role === "assistant" ? "assistant" : "user",
    content,
  };
  if (calls.length) canonical.toolCalls = calls.map(callFields);
  return canonical;
}

function messageContent(
  parts: CanonicalContentPart[],
  calls: ToolCallPart[],
): CanonicalMessage["content"] | undefined {
  const visible = collapse(parts);
  if (!calls.length) return visible;
  const head =
    typeof visible === "string"
      ? visible
        ? [{ type: "text" as const, text: visible }]
        : []
      : (visible ?? []);
  return [...head, ...calls];
}

// 只有文本、没有 providerExtras 时折叠成字符串，让现有 provider 的纯文本路径保持原样。
function collapse(parts: CanonicalContentPart[]): CanonicalMessage["content"] | undefined {
  if (!parts.length) return undefined;
  if (parts.every((part) => part.type === "text" && !part.providerExtras)) {
    return parts.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  }
  return parts;
}

function toolCallsOf(value: unknown): ToolCallPart[] {
  if (!Array.isArray(value)) return [];
  const calls: ToolCallPart[] = [];
  for (const call of value) {
    const rec = asRecord(call);
    const fn = asRecord(rec?.function);
    if (!rec || !fn?.name) continue;
    calls.push({
      type: "tool_call",
      id: String(rec.id ?? ""),
      name: String(fn.name),
      arguments:
        typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
    });
  }
  return calls;
}

const callFields = (call: ToolCallPart) => ({
  id: call.id,
  name: call.name,
  arguments: call.arguments,
});

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
  if ((body as { previous_response_id?: unknown }).previous_response_id) {
    throw new HttpError(
      400,
      "previous_response_id is not supported; send the full input each turn",
    );
  }
  const system: string[] = [];
  const messages: CanonicalMessage[] = [];
  const input = body.input;
  if (typeof input === "string") {
    if (input.trim()) messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        if (item.trim()) messages.push({ role: "user", content: item });
        continue;
      }
      const mapped = mapResponseItem(asRecord(item));
      if (!mapped) continue;
      if (mapped.role === "system") {
        if (typeof mapped.content === "string" && mapped.content) system.push(mapped.content);
        continue;
      }
      messages.push(mapped);
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

function mapResponseItem(rec: Record<string, unknown> | null): CanonicalMessage | undefined {
  if (!rec) return undefined;
  if (rec.type === "function_call") {
    const call: ToolCallPart = {
      type: "tool_call",
      id: String(rec.call_id ?? ""),
      name: String(rec.name ?? ""),
      arguments:
        typeof rec.arguments === "string" ? rec.arguments : JSON.stringify(rec.arguments ?? {}),
    };
    return { role: "assistant", content: [call], toolCalls: [callFields(call)] };
  }
  if (rec.type === "function_call_output") {
    const id = String(rec.call_id ?? "");
    const output = typeof rec.output === "string" ? rec.output : JSON.stringify(rec.output ?? "");
    return {
      role: "tool",
      toolCallId: id,
      content: [{ type: "tool_result", toolCallId: id, content: output }],
    };
  }
  if (rec.type === "reasoning") {
    const text = (Array.isArray(rec.summary) ? rec.summary : [])
      .map((item) => asRecord(item)?.text)
      .filter((item): item is string => typeof item === "string")
      .join("");
    return { role: "assistant", content: [{ type: "thinking", text }] };
  }
  if (!rec.role && !rec.content && rec.type !== "message") return undefined;
  const role = String(rec.role || "user").toLowerCase();
  const parts = openAiParts(rec.content ?? rec.text);
  if (role === "system" || role === "developer" || role === "instructions") {
    const text = textOf({ content: collapse(parts) ?? "" });
    return text ? { role: "system", content: text } : undefined;
  }
  const content = collapse(parts);
  if (content === undefined) return undefined;
  return { role: role === "assistant" ? "assistant" : "user", content };
}

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

function openAiParts(content: unknown): CanonicalContentPart[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (Array.isArray(content)) {
    const parts: CanonicalContentPart[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        if (item) parts.push({ type: "text", text: item });
        continue;
      }
      const rec = asRecord(item);
      if (!rec) continue;
      if (rec.type === "image_url" || rec.type === "input_image") {
        const url =
          rec.type === "image_url" ? asRecord(rec.image_url)?.url : (rec.image_url ?? rec.file_id);
        const part: ImagePart = { type: "image" };
        if (typeof url === "string") part.url = url;
        parts.push(withExtras(part, rec));
        continue;
      }
      const text =
        typeof rec.text === "string"
          ? rec.text
          : typeof rec.content === "string"
            ? rec.content
            : "";
      if (text) parts.push(withExtras({ type: "text", text }, rec));
    }
    return parts;
  }
  const rec = asRecord(content);
  if (typeof rec?.text === "string" && rec.text)
    return [withExtras({ type: "text", text: rec.text }, rec)];
  if (typeof rec?.content === "string" && rec.content) {
    return [withExtras({ type: "text", text: rec.content }, rec)];
  }
  return [];
}

export function assertHasText(request: CanonicalRequest, message: string): void {
  const system = request.system;
  const systemText = typeof system === "string" ? system : textOf({ content: system ?? "" });
  const hasMessage = (request.messages ?? []).some((item) => {
    if (item.toolCalls?.length || item.toolCallId) return true;
    if (typeof item.content === "string") return item.content.trim().length > 0;
    return item.content.length > 0;
  });
  if (!systemText.trim() && !hasMessage) throw new HttpError(400, message);
}
