// Anthropic Messages 端点适配器：Canonical Event → wire。
import { HttpError, wireId, writeJson } from "../../server/http.js";
import { beginSse, writeAnthropicSse } from "../../server/sse.js";
import { anthropicToCanonical } from "./request.js";
import {
  contentBlockStart,
  contentBlockStop,
  contentBlockTextDelta,
  messageDelta,
  messageStart,
  messageStop,
  streamError,
} from "./stream.js";

export function buildAnthropicMessage({ id, model, text, usage }) {
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: usage?.inputTokens ?? 0, output_tokens: usage?.outputTokens ?? 0 },
  };
}

export async function handleAnthropicMessages({ res, body, model, run }) {
  const request = anthropicToCanonical(body, model);
  const hasText =
    Boolean(request.system && String(request.system).trim()) ||
    request.messages.some((m) => String(m.content).trim());
  if (!hasText) throw new HttpError(400, "messages must contain text");

  const id = wireId("msg");
  if (body.stream) {
    beginSse(res);
    writeAnthropicSse(res, "message_start", messageStart(id, model));
    writeAnthropicSse(res, "content_block_start", contentBlockStart(0));
    let usage;
    for await (const event of run.stream(request)) {
      if (event.type === "text.delta") {
        writeAnthropicSse(res, "content_block_delta", contentBlockTextDelta(0, event.text));
      } else if (event.type === "usage") {
        usage = event;
      } else if (event.type === "error") {
        // 官方 Anthropic 流式语义：错误以 error 事件收尾，不再发 message_stop。
        writeAnthropicSse(res, "error", streamError(event.error));
        res.end();
        return;
      }
    }
    writeAnthropicSse(res, "content_block_stop", contentBlockStop(0));
    writeAnthropicSse(res, "message_delta", messageDelta("end_turn", usage?.outputTokens ?? 0));
    writeAnthropicSse(res, "message_stop", messageStop());
    res.end();
    return;
  }

  const result = await run.aggregate(request);
  writeJson(res, 200, buildAnthropicMessage({ id, model, text: result.text, usage: result.usage }));
}
