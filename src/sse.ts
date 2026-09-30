// 上游 SSE 解析（Provider 方向进站；下游写出工具在 server/sse.ts）。

export interface SseEvent {
  id: string;
  event: string;
  data: string;
}

export interface ParsedSseChunk {
  events: SseEvent[];
  remainder: string;
}

export function parseSseChunk(buffer: string, chunkText: string): ParsedSseChunk {
  const text = buffer + chunkText;
  const normalized = text.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const remainder = parts.pop() ?? "";
  const events = parts.map(parseSseBlock).filter(Boolean);
  return { events, remainder };
}

export function parseSseBlock(block: string): SseEvent {
  const event = { id: "", event: "message", data: "" };
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const sep = line.indexOf(":");
    const field = sep === -1 ? line : line.slice(0, sep);
    const value = sep === -1 ? "" : line.slice(sep + 1).replace(/^ /, "");
    if (field === "id") event.id = value;
    else if (field === "event") event.event = value || "message";
    else if (field === "data") dataLines.push(value);
  }
  event.data = dataLines.join("\n");
  return event;
}

export function decodeSseData(data: unknown): unknown {
  if (data == null || data === "" || data === "[DONE]") return data;
  try {
    return JSON.parse(data as string);
  } catch {
    return data;
  }
}
