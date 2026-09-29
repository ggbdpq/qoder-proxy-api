// OpenAI 流式 wire 事件构造器（Chat chunk 与 Responses 事件）。
import { unixNow } from "../../server/sse.js";

export function chatChunk(id, model, delta, finishReason = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: unixNow(),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function responseCreated(id, model) {
  return {
    type: "response.created",
    response: { id, object: "response", status: "in_progress", model },
  };
}

export function outputTextDelta(id, delta) {
  return {
    type: "response.output_text.delta",
    response_id: id,
    item_id: `msg_${id}`,
    output_index: 0,
    content_index: 0,
    delta,
  };
}

export function outputTextDone(id) {
  return {
    type: "response.output_text.done",
    response_id: id,
    item_id: `msg_${id}`,
    output_index: 0,
    content_index: 0,
  };
}

export function responseCompleted(id, model, usage) {
  const response = { id, object: "response", status: "completed", model };
  if (usage) {
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    response.usage = { input_tokens: input, output_tokens: output, total_tokens: input + output };
  }
  return { type: "response.completed", response };
}

export function responseFailed(id, model, error) {
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
