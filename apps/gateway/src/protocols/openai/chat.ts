// OpenAI Chat Completions 端点适配器：Canonical Event → wire。
import { wireId, writeJson } from "../../server/http.ts";
import type { ProtocolHandlerArgs } from "../../server/http.ts";
import { beginSse, writeSseData, writeSseDone } from "../../server/sse.ts";
import { assertHasText, chatToCanonical } from "./request.ts";
import { chatChunk } from "./stream.ts";
import type { ChatCompletionChunk, UsageSummary } from "./stream.ts";
import type { UsageEvent } from "../../core/events.ts";

// Provider usage（inputTokens/outputTokens）→ OpenAI usage；无数据保持 0。
function toOpenAiUsage(usage?: UsageSummary) {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

export function buildChatCompletion({
  id,
  model,
  text,
  finishReason = "stop",
  usage,
}: {
  id: string;
  model: string;
  text: string;
  finishReason?: string;
  usage?: UsageSummary;
}) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text || "" },
        finish_reason: finishReason,
      },
    ],
    usage: toOpenAiUsage(usage),
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
    for await (const event of run.stream(request)) {
      if (event.type === "text.delta") {
        writeSseData(res, chatChunk(id, model, { content: event.text }));
      } else if (event.type === "usage") {
        usage = event;
      } else if (event.type === "error") {
        // v0.1 在此会触发 headers-sent 崩溃并挂住连接；现按 OpenAI 惯例发 error 数据后干净收尾。
        writeSseData(res, {
          error: { message: event.error.message, type: "server_error", code: event.error.code },
        });
        writeSseDone(res);
        res.end();
        return;
      }
    }
    writeSseData(res, chatChunk(id, model, {}, "stop"));
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

  const result = await run.aggregate(request);
  writeJson(res, 200, buildChatCompletion({ id, model, text: result.text, usage: result.usage }));
}
