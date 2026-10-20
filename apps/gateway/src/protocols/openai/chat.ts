// OpenAI Chat Completions 端点适配器：Canonical Event → wire。
import { wireId, writeJson } from "../../server/http.ts";
import type { ProtocolHandlerArgs } from "../../server/http.ts";
import { beginSse, writeSseData, writeSseDone } from "../../server/sse.ts";
import { assertHasText, chatToCanonical } from "./request.ts";
import { FINISH_REASON, chatChunk } from "./stream.ts";
import type { ChatCompletionChunk, UsageSummary } from "./stream.ts";
import type { AggregateResult } from "../../core/aggregate.ts";
import type { UsageEvent } from "../../core/events.ts";

// Provider usage（inputTokens/outputTokens）→ OpenAI usage；无数据保持 0。
function toOpenAiUsage(usage?: UsageSummary) {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

export function buildChatCompletion(id: string, model: string, result: AggregateResult) {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: result.text || (result.toolCalls.length ? null : ""),
  };
  if (result.thinking) message.reasoning_content = result.thinking;
  if (result.toolCalls.length) {
    message.tool_calls = result.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: FINISH_REASON[result.stopReason] }],
    usage: toOpenAiUsage(result.usage),
  };
}

export async function handleChatCompletions({
  res,
  body,
  model,
  run,
}: ProtocolHandlerArgs): Promise<void> {
  const request = chatToCanonical(body, model);
  assertHasText(request, "messages must contain at least one text message");

  const id = wireId("chatcmpl");
  if (body.stream) {
    beginSse(res);
    writeSseData(res, chatChunk(id, model, { role: "assistant" }));
    let usage: UsageEvent | undefined;
    let finishReason: string = FINISH_REASON.stop;
    // Canonical tool index → 下游 tool_calls[].index，按 tool.start 出现顺序编号。
    const toolIndex = new Map<number, number>();
    for await (const event of run.stream(request)) {
      switch (event.type) {
        case "text.delta":
          writeSseData(res, chatChunk(id, model, { content: event.text }));
          break;
        case "thinking.delta":
          writeSseData(res, chatChunk(id, model, { reasoning_content: event.text }));
          break;
        case "tool.start": {
          const index = toolIndex.size;
          toolIndex.set(event.index, index);
          const call = { name: event.name, arguments: "" };
          writeSseData(
            res,
            chatChunk(id, model, {
              tool_calls: [{ index, id: event.id, type: "function", function: call }],
            }),
          );
          break;
        }
        case "tool.arguments.delta": {
          const index = toolIndex.get(event.index) ?? event.index;
          writeSseData(
            res,
            chatChunk(id, model, { tool_calls: [{ index, function: { arguments: event.json } }] }),
          );
          break;
        }
        case "message.end":
          finishReason = FINISH_REASON[event.stopReason];
          break;
        case "usage":
          usage = event;
          break;
        case "error":
          // v0.1 在此会触发 headers-sent 崩溃并挂住连接；现按 OpenAI 惯例发 error 数据后干净收尾。
          writeSseData(res, {
            error: { message: event.error.message, type: "server_error", code: event.error.code },
          });
          writeSseDone(res);
          res.end();
          return;
      }
    }
    writeSseData(res, chatChunk(id, model, {}, finishReason));
    if (usage) {
      // OpenAI include_usage 约定：空 choices 的收尾 usage chunk。
      const final: ChatCompletionChunk = chatChunk(id, model, {}, "stop");
      final.choices = [];
      final.usage = toOpenAiUsage(usage);
      writeSseData(res, final);
    }
    writeSseDone(res);
    res.end();
    return;
  }

  writeJson(res, 200, buildChatCompletion(id, model, await run.aggregate(request)));
}
