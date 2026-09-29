// Anthropic Messages 流式 wire 事件构造器。
export function messageStart(id, model) {
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

export function contentBlockStart(index) {
  return { type: "content_block_start", index, content_block: { type: "text", text: "" } };
}

export function contentBlockTextDelta(index, text) {
  return { type: "content_block_delta", index, delta: { type: "text_delta", text } };
}

export function contentBlockStop(index) {
  return { type: "content_block_stop", index };
}

export function messageDelta(stopReason = "end_turn", outputTokens = 0) {
  return {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  };
}

export function messageStop() {
  return { type: "message_stop" };
}

export function streamError(error) {
  return { type: "error", error: { type: "api_error", message: error.message } };
}
