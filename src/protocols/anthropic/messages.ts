// Anthropic Messages 端点适配器：Canonical Event → wire。
import { HttpError, wireId, writeJson } from "../../server/http.ts";
import type { ProtocolHandlerArgs } from "../../server/http.ts";
import { beginSse, writeAnthropicSse } from "../../server/sse.ts";
import { anthropicToCanonical } from "./request.ts";
import {
  contentBlockStart,
  contentBlockStop,
  contentBlockTextDelta,
  messageDelta,
  messageStart,
  messageStop,
  streamError,
} from "./stream.ts";
import type { UsageEvent } from "../../core/events.ts";

// Provider usage 的最小形状（AggregateUsage / UsageEvent 的公共部分）。
export interface AnthropicUsageSummary {
  inputTokens?: number;
  outputTokens?: number;
}

export function buildAnthropicMessage({
  id,
  model,
  text,
  usage,
}: {
  id: string;
  model: string;
  text: string;
  usage?: AnthropicUsageSummary;
}) {
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

export async function handleAnthropicMessages({
  res,
  body,
  model,
  run,
}: ProtocolHandlerArgs): Promise<void> {
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
    let usage: UsageEvent | undefined;
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
