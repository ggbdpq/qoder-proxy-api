// Anthropic Messages 端点适配器：Canonical Event → wire。
import { HttpError, wireId, writeJson } from "../../server/http.ts";
import type { ProtocolHandlerArgs } from "../../server/http.ts";
import { beginSse, writeAnthropicSse } from "../../server/sse.ts";
import { anthropicToCanonical } from "./request.ts";
import {
  STOP_REASON,
  TEXT_BLOCK,
  THINKING_BLOCK,
  contentBlockInputJsonDelta,
  contentBlockStart,
  contentBlockStop,
  contentBlockTextDelta,
  contentBlockThinkingDelta,
  messageDelta,
  messageStart,
  messageStop,
  streamError,
} from "./stream.ts";
import type { AggregateResult } from "../../core/aggregate.ts";
import type { UsageEvent } from "../../core/events.ts";

export function buildAnthropicMessage(id: string, model: string, result: AggregateResult) {
  const content: unknown[] = [];
  if (result.thinking) content.push({ ...THINKING_BLOCK, thinking: result.thinking });
  if (result.text || !result.toolCalls.length) content.push({ type: "text", text: result.text });
  for (const call of result.toolCalls) {
    // 参数不是合法 JSON 属于上游协议错误，交给 server 的错误映射，不静默吞掉。
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.arguments ? JSON.parse(call.arguments) : {},
    });
  }
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: STOP_REASON[result.stopReason],
    stop_sequence: null,
    usage: {
      input_tokens: result.usage.inputTokens ?? 0,
      output_tokens: result.usage.outputTokens ?? 0,
    },
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
    let usage: UsageEvent | undefined;
    let stopReason: string = STOP_REASON.stop;
    // 同一时刻只有一个打开的 content block，换类型时先 stop 上一个；index 按出现顺序编号。
    let index = -1;
    let current: string | null = null;
    const closeBlock = () => {
      if (current === null) return;
      writeAnthropicSse(res, "content_block_stop", contentBlockStop(index));
      current = null;
    };
    const openBlock = (key: string, block: object) => {
      if (current === key) return;
      closeBlock();
      current = key;
      writeAnthropicSse(res, "content_block_start", contentBlockStart(++index, block));
    };

    for await (const event of run.stream(request)) {
      switch (event.type) {
        case "text.delta":
          openBlock("text", TEXT_BLOCK);
          writeAnthropicSse(res, "content_block_delta", contentBlockTextDelta(index, event.text));
          break;
        case "thinking.delta":
          openBlock("thinking", THINKING_BLOCK);
          writeAnthropicSse(
            res,
            "content_block_delta",
            contentBlockThinkingDelta(index, event.text),
          );
          break;
        case "tool.start":
          openBlock(`tool:${event.index}`, {
            type: "tool_use",
            id: event.id,
            name: event.name,
            input: {},
          });
          break;
        case "tool.arguments.delta":
          if (current === `tool:${event.index}`) {
            writeAnthropicSse(
              res,
              "content_block_delta",
              contentBlockInputJsonDelta(index, event.json),
            );
          }
          break;
        case "tool.end":
          if (current === `tool:${event.index}`) closeBlock();
          break;
        case "message.end":
          stopReason = STOP_REASON[event.stopReason];
          break;
        case "usage":
          usage = event;
          break;
        case "error":
          // 官方 Anthropic 流式语义：错误以 error 事件收尾，不再发 message_stop。
          writeAnthropicSse(res, "error", streamError(event.error));
          res.end();
          return;
      }
    }
    // 没有任何内容块时保持 v0.1 的空 text 块。
    if (index === -1) openBlock("text", TEXT_BLOCK);
    closeBlock();
    writeAnthropicSse(res, "message_delta", messageDelta(stopReason, usage?.outputTokens ?? 0));
    writeAnthropicSse(res, "message_stop", messageStop());
    res.end();
    return;
  }

  writeJson(res, 200, buildAnthropicMessage(id, model, await run.aggregate(request)));
}
