// Anthropic Messages 下游请求 → CanonicalRequest。
// v0.1 行为保留：非 text 内容块（image 等）静默丢弃。
export function anthropicToCanonical(body, model) {
  const system = flattenBlocks(body.system);
  const messages = [];
  for (const message of body.messages ?? []) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "user").toLowerCase() === "assistant" ? "assistant" : "user";
    const text = flattenBlocks(message.content);
    if (!text) continue;
    messages.push({ role, content: text });
  }
  const tools = Array.isArray(body.tools)
    ? body.tools
        .filter((tool) => tool?.name)
        .map((tool) => ({
          name: tool.name,
          description: tool.description || undefined,
          inputSchema: tool.input_schema ?? {},
        }))
    : undefined;
  return {
    model,
    system: system || undefined,
    messages,
    tools: tools?.length ? tools : undefined,
    maxTokens: body.max_tokens ?? undefined,
    temperature: body.temperature ?? undefined,
    metadata: { title: body.metadata?.title || body.title },
  };
}

function flattenBlocks(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (!block || typeof block !== "object") return "";
        if (block.type === "text" && typeof block.text === "string") return block.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
