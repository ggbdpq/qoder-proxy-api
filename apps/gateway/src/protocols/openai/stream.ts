// OpenAI 流式 wire 事件构造器（Chat chunk 与 Responses 事件）。
import { unixNow } from "../../server/sse.ts";
import type { ProviderError } from "../../core/errors.ts";

// 聚合 usage 与 Provider UsageEvent 的最小公共形状。
export interface UsageSummary {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ChatChunkDelta {
  role?: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function: { name?: string; arguments: string };
  }>;
}

// Canonical stopReason → OpenAI Chat finish_reason。
export const FINISH_REASON = {
  stop: "stop",
  tool_use: "tool_calls",
  length: "length",
  cancelled: "stop",
} as const;

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{ index: number; delta: ChatChunkDelta; finish_reason: string | null }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export function chatChunk(
  id: string,
  model: string,
  delta: ChatChunkDelta,
  finishReason: string | null = null,
): ChatCompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created: unixNow(),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function responseCreated(id: string, model: string) {
  return {
    type: "response.created",
    response: { id, object: "response", status: "in_progress", model },
  };
}

export function outputTextDelta(id: string, delta: string, outputIndex = 0) {
  return {
    type: "response.output_text.delta",
    response_id: id,
    item_id: `msg_${id}`,
    output_index: outputIndex,
    content_index: 0,
    delta,
  };
}

export function outputTextDone(id: string, outputIndex = 0) {
  return {
    type: "response.output_text.done",
    response_id: id,
    item_id: `msg_${id}`,
    output_index: outputIndex,
    content_index: 0,
  };
}

// stopReason length → incomplete，其余 completed。
export function responseStatus(stopReason?: string) {
  return stopReason === "length"
    ? { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }
    : { status: "completed" };
}

export function responseCompleted(
  id: string,
  model: string,
  usage?: UsageSummary,
  stopReason?: string,
) {
  const response: {
    id: string;
    object: string;
    status: string;
    model: string;
    usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  } = { id, object: "response", ...responseStatus(stopReason), model };
  if (usage) {
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    response.usage = { input_tokens: input, output_tokens: output, total_tokens: input + output };
  }
  return { type: "response.completed", response };
}

export function responseFailed(id: string, model: string, error: ProviderError) {
  return {
    type: "response.failed",
    response: {
      id,
      object: "response",
      status: "failed",
      model,
      error: { code: error.code, message: error.message },
    },
  };
}
