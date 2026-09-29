// Canonical Event：三条 Provider 链路的统一内部事件语言。
// Provider normalize 层负责把各自的私有 SSE/JSONL 事件蒸馏成这里的事件；
// OpenAI / Anthropic 序列化层只消费这里的事件。

/**
 * @typedef {object} MessageStartEvent
 * @property {"message.start"} type
 * @property {string} [id]
 *
 * @typedef {object} TextDeltaEvent
 * @property {"text.delta"} type
 * @property {string} text
 *
 * @typedef {object} ThinkingDeltaEvent
 * @property {"thinking.delta"} type
 * @property {string} text
 *
 * @typedef {object} ToolStartEvent
 * @property {"tool.start"} type
 * @property {number} index
 * @property {string} id
 * @property {string} name
 *
 * @typedef {object} ToolArgumentsDeltaEvent
 * @property {"tool.arguments.delta"} type
 * @property {number} index
 * @property {string} json
 *
 * @typedef {object} ToolEndEvent
 * @property {"tool.end"} type
 * @property {number} index
 *
 * @typedef {object} UsageEvent
 * @property {"usage"} type
 * @property {number} [inputTokens]
 * @property {number} [outputTokens]
 *
 * @typedef {object} MessageEndEvent
 * @property {"message.end"} type
 * @property {"stop" | "tool_use" | "length" | "cancelled"} stopReason
 *
 * @typedef {object} ErrorEvent
 * @property {"error"} type
 * @property {import("./errors.js").ProviderError} error
 *
 * @typedef {MessageStartEvent | TextDeltaEvent | ThinkingDeltaEvent | ToolStartEvent
 *   | ToolArgumentsDeltaEvent | ToolEndEvent | UsageEvent | MessageEndEvent | ErrorEvent} ProviderEvent
 */

export const PROVIDER_EVENT_TYPES = new Set([
  "message.start",
  "text.delta",
  "thinking.delta",
  "tool.start",
  "tool.arguments.delta",
  "tool.end",
  "usage",
  "message.end",
  "error",
]);

export const STOP_REASONS = new Set(["stop", "tool_use", "length", "cancelled"]);
