// qodercli stream-json（JSONL）→ Canonical Event。
// 事件形状来自公开 CLI 参考实现与本机 fixtures；
// 不同 CLI 版本可能漂移（计划文档 U1），未识别行安全跳过。
// assistant.message.content: [{type:"reasoning",thinking}, {type:"text",text}, {type:"finish"}]
export function createStreamJsonParser() {
  return {
    // 每行调用一次；返回 Canonical Event 数组。
    parseLine(line) {
      const text = line.trim();
      if (!text) return [];
      let event;
      try {
        event = JSON.parse(text);
      } catch {
        return []; // 半行/噪声行：stdout 只信 JSONL
      }
      if (!event || typeof event !== "object") return [];

      if (event.type === "assistant" && Array.isArray(event.message?.content)) {
        const events = [];
        for (const part of event.message.content) {
          if (part?.type === "text" && typeof part.text === "string" && part.text) {
            events.push({ type: "text.delta", text: part.text });
          } else if (part?.type === "reasoning" && typeof part.thinking === "string" && part.thinking) {
            events.push({ type: "thinking.delta", text: part.thinking });
          }
        }
        return events;
      }

      if (event.type === "result" && event.done === true) {
        return [{ type: "message.end", stopReason: "stop" }];
      }

      // type: "system"（init）等非文本事件跳过。
      return [];
    },
  };
}

// CanonicalRequest → qodercli prompt：整段对话渲染为单条 prompt 文本
// （qodercli -p 是单轮入口，多轮上下文由显式重放承载）。
export function messagesToPrompt(request) {
  const parts = [];
  const system = flatten(request.system);
  if (system) parts.push(`System: ${system}`);
  for (const message of request.messages ?? []) {
    const text = flatten(message.content);
    if (!text) continue;
    parts.push(`${roleLabel(message.role)}: ${text}`);
  }
  return parts.join("\n\n");
}

function roleLabel(role) {
  if (role === "assistant") return "Assistant";
  if (role === "system") return "System";
  if (role === "tool") return "Tool";
  return "User";
}

function flatten(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.type === "text" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
