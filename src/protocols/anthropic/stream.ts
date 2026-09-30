// Anthropic Messages 流式 wire 事件构造器。
import type { ProviderError } from "../../core/errors.ts";

export function messageStart(id: string, model: string) {
  return {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
}

export function contentBlockStart(index: number) {
  return { type: "content_block_start", index, content_block: { type: "text", text: "" } };
}

export function contentBlockTextDelta(index: number, text: string) {
  return { type: "content_block_delta", index, delta: { type: "text_delta", text } };
}

export function contentBlockStop(index: number) {
  return { type: "content_block_stop", index };
}

export function messageDelta(stopReason: string = "end_turn", outputTokens: number = 0) {
  return {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  };
}

export function messageStop() {
  return { type: "message_stop" };
}

export function streamError(error: ProviderError) {
  return { type: "error", error: { type: "api_error", message: error.message } };
}
