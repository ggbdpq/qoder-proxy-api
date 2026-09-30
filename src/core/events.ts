// Canonical Event：三条 Provider 链路的统一内部事件语言。
// Provider normalize 层负责把各自的私有 SSE/JSONL 事件蒸馏成这里的事件；
// OpenAI / Anthropic 序列化层只消费这里的事件。

import type { ProviderError } from "./errors.ts";

export interface MessageStartEvent {
  type: "message.start";
  id?: string;
}

export interface TextDeltaEvent {
  type: "text.delta";
  text: string;
}

export interface ThinkingDeltaEvent {
  type: "thinking.delta";
  text: string;
}

export interface ToolStartEvent {
  type: "tool.start";
  index: number;
  id: string;
  name: string;
}

export interface ToolArgumentsDeltaEvent {
  type: "tool.arguments.delta";
  index: number;
  json: string;
}

export interface ToolEndEvent {
  type: "tool.end";
  index: number;
}

export interface UsageEvent {
  type: "usage";
  inputTokens?: number;
  outputTokens?: number;
}

export interface MessageEndEvent {
  type: "message.end";
  stopReason: "stop" | "tool_use" | "length" | "cancelled";
}

export interface ErrorEvent {
  type: "error";
  error: ProviderError;
}

export type ProviderEvent =
  | MessageStartEvent
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ToolStartEvent
  | ToolArgumentsDeltaEvent
  | ToolEndEvent
  | UsageEvent
  | MessageEndEvent
  | ErrorEvent;

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
