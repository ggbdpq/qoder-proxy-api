// Anthropic Messages 下游请求 → CanonicalRequest。
// v0.1 行为保留：非 text 内容块（image 等）静默丢弃。
import type { CanonicalMessage, CanonicalRequest, CanonicalTool } from "../../core/request.ts";
import type { IncomingBody } from "../../server/http.ts";

// 动态 wire 载荷的统一窄化入口：对象 → Record，其余 → null。
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function anthropicToCanonical(body: IncomingBody, model: string): CanonicalRequest {
  const system = flattenBlocks(body.system);
  const messages: CanonicalMessage[] = [];
  for (const message of body.messages ?? []) {
    if (!message || typeof message !== "object") continue;
    const role =
      String(message.role || "user").toLowerCase() === "assistant" ? "assistant" : "user";
    const text = flattenBlocks(message.content);
    if (!text) continue;
    messages.push({ role, content: text });
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
    system: system || undefined,
    messages,
    tools,
    maxTokens: (body.max_tokens as number | undefined) ?? undefined,
    temperature: (body.temperature as number | undefined) ?? undefined,
    metadata: { title: body.metadata?.title || body.title },
  };
}

function flattenBlocks(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        const rec = asRecord(block);
        if (!rec) return "";
        if (rec.type === "text" && typeof rec.text === "string") return rec.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
