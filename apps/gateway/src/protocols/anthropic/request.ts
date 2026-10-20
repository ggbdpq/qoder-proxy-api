// Anthropic Messages 下游请求 → CanonicalRequest。text / image / tool_use / tool_result / thinking 逐块保留。
import type {
  CanonicalContentPart,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalTool,
  ImagePart,
  ThinkingPart,
  ToolCallPart,
  ToolResultPart,
} from "../../core/request.ts";
import type { IncomingBody } from "../../server/http.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function withExtras<T extends CanonicalContentPart>(part: T, rec: Record<string, unknown>): T {
  if (rec.cache_control === undefined) return part;
  return { ...part, providerExtras: { cache_control: rec.cache_control } };
}

export function anthropicToCanonical(body: IncomingBody, model: string): CanonicalRequest {
  const system = collapse(anthropicParts(body.system));
  const messages: CanonicalMessage[] = [];
  for (const message of body.messages ?? []) {
    if (!message || typeof message !== "object") continue;
    const role =
      String(message.role || "user").toLowerCase() === "assistant" ? "assistant" : "user";
    const parts = anthropicParts(message.content);
    const content = collapse(parts);
    if (content === undefined) continue;
    const canonical: CanonicalMessage = { role, content };
    const calls = parts.filter((part): part is ToolCallPart => part.type === "tool_call");
    if (calls.length)
      canonical.toolCalls = calls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      }));
    messages.push(canonical);
  }
  let tools: CanonicalTool[] | undefined;
  if (Array.isArray(body.tools)) {
    const mapped: CanonicalTool[] = [];
    for (const tool of body.tools) {
      const rec = asRecord(tool);
      if (!rec?.name) continue;
      mapped.push({
        name: rec.name as string,
        description: (rec.description as string | undefined) || undefined,
        inputSchema: (rec.input_schema ?? {}) as Record<string, unknown>,
      });
    }
    tools = mapped.length ? mapped : undefined;
  }
  return {
    model,
    system,
    messages,
    tools,
    maxTokens: (body.max_tokens as number | undefined) ?? undefined,
    temperature: (body.temperature as number | undefined) ?? undefined,
    metadata: { title: body.metadata?.title || body.title },
  };
}

function collapse(parts: CanonicalContentPart[]): CanonicalMessage["content"] | undefined {
  if (!parts.length) return undefined;
  if (parts.every((part) => part.type === "text" && !part.providerExtras)) {
    return parts.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  }
  return parts;
}

function anthropicParts(content: unknown): CanonicalContentPart[] {
  if (content == null) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: CanonicalContentPart[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      if (block) parts.push({ type: "text", text: block });
      continue;
    }
    const rec = asRecord(block);
    if (!rec) continue;
    if (rec.type === "text" && typeof rec.text === "string") {
      parts.push(withExtras({ type: "text", text: rec.text }, rec));
      continue;
    }
    if (rec.type === "image") {
      const source = asRecord(rec.source) ?? {};
      const part: ImagePart = { type: "image" };
      if (typeof source.media_type === "string") part.mediaType = source.media_type;
      if (typeof source.data === "string") part.data = source.data;
      if (typeof source.url === "string") part.url = source.url;
      parts.push(withExtras(part, rec));
      continue;
    }
    if (rec.type === "thinking") {
      const part: ThinkingPart = {
        type: "thinking",
        text: typeof rec.thinking === "string" ? rec.thinking : "",
      };
      if (typeof rec.signature === "string") part.signature = rec.signature;
      parts.push(withExtras(part, rec));
      continue;
    }
    if (rec.type === "tool_use") {
      const call: ToolCallPart = {
        type: "tool_call",
        id: String(rec.id ?? ""),
        name: String(rec.name ?? ""),
        arguments: typeof rec.input === "string" ? rec.input : JSON.stringify(rec.input ?? {}),
      };
      parts.push(withExtras(call, rec));
      continue;
    }
    if (rec.type === "tool_result") {
      // ponytail: content 为块数组时只保留 text 块；嵌套图片出现后再展开。
      const part: ToolResultPart = {
        type: "tool_result",
        toolCallId: String(rec.tool_use_id ?? ""),
        content: toolResultText(rec.content),
      };
      if (rec.is_error === true) part.isError = true;
      parts.push(withExtras(part, rec));
    }
  }
  return parts;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const rec = asRecord(block);
      return rec?.type === "text" && typeof rec.text === "string" ? rec.text : "";
    })
    .filter(Boolean)
    .join("\n");
}
