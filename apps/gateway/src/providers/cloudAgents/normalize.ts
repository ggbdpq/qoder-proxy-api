// Qoder Cloud SSE 事件 → Canonical Event 的归一化层。
// extractTextDelta / isQoder* / extractQoderError 自 v0.1 原样迁入，禁止顺手改行为。
import type { CanonicalRequest } from "../../core/request.ts";

// 宽松 JSON 记录：动态取值的统一读取形状（值保持 unknown，消费处自行窄化）。
export type JsonRecord = { [key: string]: unknown };

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

// Cloud SSE 事件信封：sse.ts 解析出的原始字段 + 已解码 json（二者可能只存在其一）。
interface QoderSseEvent {
  id?: string;
  event?: string;
  data?: unknown;
  json?: unknown;
}

// extractTextDelta 的跨事件去重状态（v0.1 原形状）。
interface TextDeltaState {
  lastFullText?: string;
  fullTextsSeen?: Set<string>;
}

const DIRECT_DELTA_PATHS: string[][] = [
  ["delta", "text"],
  ["delta", "content"],
  ["delta", "output_text"],
  ["event", "delta", "text"],
  ["event", "delta", "content"],
  ["message", "delta", "text"],
  ["message", "delta", "content"],
  ["text_delta"],
  ["partial_text"],
  ["content_delta", "text"],
  ["output_text_delta"],
];

const FULL_TEXT_PATHS: string[][] = [
  ["text"],
  ["content", "text"],
  ["message", "text"],
  ["message", "content", "text"],
  ["event", "text"],
  ["event", "content", "text"],
];

export function extractTextDelta(sseEvent: QoderSseEvent, state: TextDeltaState = {}): string {
  const eventName = String(sseEvent?.event || "").toLowerCase();
  const data = sseEvent?.json ?? sseEvent?.data;
  if (data == null || data === "[DONE]") return "";

  if (typeof data === "string") {
    if (looksLikeStatus(eventName) || looksLikeControl(data)) return "";
    return eventName.includes("delta") || eventName.includes("message") ? data : "";
  }

  // data 为已解码 JSON（对象/数组）；按宽松记录读取，保持 v0.1 动态取值语义。
  const payload = data as JsonRecord;

  for (const path of DIRECT_DELTA_PATHS) {
    const value = getPath(payload, path);
    if (typeof value === "string" && value) return value;
  }

  const contentDelta = extractFromContentArray(
    getPath(payload, ["delta", "content"]) ||
      getPath(payload, ["event", "delta", "content"]) ||
      getPath(payload, ["message", "delta", "content"]),
  );
  if (contentDelta) return contentDelta;

  if (eventName.includes("delta")) {
    const anyDelta = findStringByKey(payload, ["text", "content", "output_text", "delta"]);
    if (anyDelta) return anyDelta;
  }

  if (
    eventName.includes("agent.message") ||
    eventName.includes("assistant.message") ||
    payload.type === "agent.message"
  ) {
    const full = extractFullText(payload);
    if (!full) return "";
    if (state.lastFullText && full.startsWith(state.lastFullText)) {
      const delta = full.slice(state.lastFullText.length);
      state.lastFullText = full;
      return delta;
    }
    if (state.fullTextsSeen?.has(full)) return "";
    state.fullTextsSeen ||= new Set<string>();
    state.fullTextsSeen.add(full);
    state.lastFullText = full;
    return full;
  }

  return "";
}

export function isQoderIdleEvent(sseEvent: QoderSseEvent): boolean {
  const eventName = String(sseEvent?.event || "").toLowerCase();
  const type = String(getPath(sseEvent?.json, ["type"]) || "").toLowerCase();
  const status = String(getPath(sseEvent?.json, ["status"]) || "").toLowerCase();
  return eventName === "session.status_idle" || type === "session.status_idle" || status === "idle";
}

export function isQoderRunningEvent(sseEvent: QoderSseEvent): boolean {
  const eventName = String(sseEvent?.event || "").toLowerCase();
  const type = String(getPath(sseEvent?.json, ["type"]) || "").toLowerCase();
  const status = String(getPath(sseEvent?.json, ["status"]) || "").toLowerCase();
  return (
    eventName === "session.status_running" ||
    type === "session.status_running" ||
    status === "running" ||
    status === "rescheduling"
  );
}

export function extractQoderError(sseEvent: QoderSseEvent): string | null {
  const eventName = String(sseEvent?.event || "").toLowerCase();
  const data = sseEvent?.json ?? sseEvent?.data;
  if (
    !eventName.includes("error") &&
    String(getPath(data, ["type"]) || "").toLowerCase() !== "session.error"
  )
    return null;
  if (typeof data === "string") return data;
  // v0.1 原语义：取首个真值（data?.error?.message || data?.message || JSON.stringify(data)），
  // 实践为 string；空值按 falsy 处理，不改变调用方的真值判断。
  const payload = data as JsonRecord | undefined;
  return (getPath(payload, ["error", "message"]) ||
    getPath(payload, ["message"]) ||
    JSON.stringify(payload)) as string;
}

// CanonicalRequest → Cloud prompt 文本。保持 v0.1 "Role: text" 扁平化语义。
export function canonicalToPrompt(request: CanonicalRequest): string {
  const parts = [];
  const systemText = flattenContent(request.system);
  if (systemText) parts.push(`System: ${systemText}`);
  for (const message of request.messages ?? []) {
    if (!message || typeof message !== "object") continue;
    const text = flattenContent(message.content);
    if (!text) continue;
    parts.push(`${normalizeRole(message.role)}: ${text}`);
  }
  return parts.join("\n\n");
}

function flattenContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: unknown[] = content;
    return parts
      .map((part) => {
        if (typeof part === "string") return part;
        if (!isRecord(part)) return "";
        if (typeof part.text === "string") return part.text;
        if (part.type === "image") return "[image: attached]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function normalizeRole(role: unknown): string {
  const raw = String(role || "user").toLowerCase();
  if (raw === "developer") return "Developer";
  if (raw === "system") return "System";
  if (raw === "assistant") return "Assistant";
  if (raw === "tool") return "Tool";
  return "User";
}

function extractFullText(data: unknown): string {
  for (const path of FULL_TEXT_PATHS) {
    const value = getPath(data, path);
    if (typeof value === "string" && value) return value;
  }
  return (
    extractFromContentArray(
      getPath(data, ["content"]) ||
        getPath(data, ["message", "content"]) ||
        getPath(data, ["event", "content"]),
    ) || ""
  );
}

function extractFromContentArray(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const parts: unknown[] = value;
  return parts
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isRecord(part)) return "";
      return part.text || part.output_text || part.content || "";
    })
    .filter(Boolean)
    .join("");
}

// 宽松逐级取值：任一层不是对象即返回 undefined（与连续可选链语义一致）。
function getPath(obj: unknown, path: readonly string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function findStringByKey(value: unknown, keys: string[]): string {
  if (!isRecord(value)) return "";
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate) return candidate;
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      const found = findStringByKey(child, keys);
      if (found) return found;
    }
  }
  return "";
}

function looksLikeStatus(value: string): boolean {
  return value.includes("status") || value.includes("heartbeat");
}

function looksLikeControl(value: string): boolean {
  return ["idle", "running", "rescheduling", "terminated"].includes(String(value).toLowerCase());
}
