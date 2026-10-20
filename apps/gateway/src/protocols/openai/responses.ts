// OpenAI Responses 端点适配器：Canonical Event → wire。
import type { ServerResponse } from "node:http";
import { wireId, writeJson } from "../../server/http.ts";
import type { ProtocolHandlerArgs } from "../../server/http.ts";
import { beginSse, writeSseData, writeSseDone } from "../../server/sse.ts";
import { assertHasText, responsesToCanonical } from "./request.ts";
import {
  outputTextDelta,
  outputTextDone,
  responseCompleted,
  responseCreated,
  responseFailed,
  responseStatus,
} from "./stream.ts";
import type { AggregateResult } from "../../core/aggregate.ts";
import type { UsageEvent } from "../../core/events.ts";

const functionCallItem = (call: { id: string; name: string }) => ({
  id: `fc_${call.id}`,
  type: "function_call",
  call_id: call.id,
  name: call.name,
});

export function buildResponsesCompletion(id: string, model: string, result: AggregateResult) {
  const { text, thinking, toolCalls, usage } = result;
  const outputId = `msg_${id.replace(/[^a-zA-Z0-9_]/g, "")}`;
  const output: unknown[] = [];
  if (thinking) {
    output.push({
      id: `rs_${id}`,
      type: "reasoning",
      summary: [{ type: "summary_text", text: thinking }],
    });
  }
  if (text || !toolCalls.length) {
    output.push({
      id: outputId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: text || "", annotations: [] }],
    });
  }
  for (const call of toolCalls) {
    output.push({ ...functionCallItem(call), arguments: call.arguments, status: "completed" });
  }
  const input = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    ...responseStatus(result.stopReason),
    model,
    output,
    output_text: text || "",
    usage: {
      input_tokens: input,
      output_tokens: outputTokens,
      total_tokens: input + outputTokens,
    },
  };
}

// 流式 output item：打开时写 added，delta 写增量，close 写 done。
interface OpenItem {
  key: string;
  delta(chunk: string): void;
  close(): void;
}

function messageItem(res: ServerResponse, id: string, index: number) {
  return {
    delta: (text: string) => writeSseData(res, outputTextDelta(id, text, index)),
    close: () => writeSseData(res, outputTextDone(id, index)),
  };
}

function reasoningItem(res: ServerResponse, id: string, index: number) {
  const item = { id: `rs_${id}_${index}`, type: "reasoning" };
  const ref = { response_id: id, item_id: item.id, output_index: index, summary_index: 0 };
  let text = "";
  writeSseData(res, {
    type: "response.output_item.added",
    response_id: id,
    output_index: index,
    item: { ...item, summary: [] },
  });
  return {
    delta(chunk: string) {
      text += chunk;
      writeSseData(res, { type: "response.reasoning_summary_text.delta", ...ref, delta: chunk });
    },
    close() {
      writeSseData(res, { type: "response.reasoning_summary_text.done", ...ref, text });
      writeSseData(res, {
        type: "response.output_item.done",
        response_id: id,
        output_index: index,
        item: { ...item, summary: [{ type: "summary_text", text }] },
      });
    },
  };
}

function functionCallStreamItem(
  res: ServerResponse,
  id: string,
  index: number,
  call: { id: string; name: string },
) {
  const item = functionCallItem(call);
  const ref = { response_id: id, item_id: item.id, output_index: index };
  let args = "";
  writeSseData(res, {
    type: "response.output_item.added",
    response_id: id,
    output_index: index,
    item: { ...item, arguments: "", status: "in_progress" },
  });
  return {
    delta(chunk: string) {
      args += chunk;
      writeSseData(res, { type: "response.function_call_arguments.delta", ...ref, delta: chunk });
    },
    close() {
      writeSseData(res, { type: "response.function_call_arguments.done", ...ref, arguments: args });
      writeSseData(res, {
        type: "response.output_item.done",
        response_id: id,
        output_index: index,
        item: { ...item, arguments: args, status: "completed" },
      });
    },
  };
}

export async function handleResponses({
  res,
  body,
  model,
  run,
}: ProtocolHandlerArgs): Promise<void> {
  const request = responsesToCanonical(body, model);
  assertHasText(request, "input must contain text");

  const id = wireId("resp");
  if (body.stream) {
    beginSse(res);
    writeSseData(res, responseCreated(id, model));
    let usage: UsageEvent | undefined;
    let stopReason: string | undefined;
    // 同一时刻只有一个打开的 item，换类型时先收尾上一个；output_index 按出现顺序编号。
    // ponytail: 假设上游工具调用按顺序到达（不交错）；交错的并行工具调用需按 index 分别维护。
    // 初值用断言：current 只在闭包 switchTo 里赋值，直接写 `= null` 会被控制流收窄成 never。
    let current = null as OpenItem | null;
    let nextIndex = 0;
    const switchTo = (key: string, open: (index: number) => Omit<OpenItem, "key">) => {
      if (current?.key !== key) {
        current?.close();
        current = { key, ...open(nextIndex++) };
      }
      return current;
    };

    for await (const event of run.stream(request)) {
      switch (event.type) {
        case "text.delta":
          switchTo("message", (i) => messageItem(res, id, i)).delta(event.text);
          break;
        case "thinking.delta":
          switchTo("reasoning", (i) => reasoningItem(res, id, i)).delta(event.text);
          break;
        case "tool.start":
          switchTo(`tool:${event.index}`, (i) => functionCallStreamItem(res, id, i, event));
          break;
        case "tool.arguments.delta":
          if (current?.key === `tool:${event.index}`) current.delta(event.json);
          break;
        case "tool.end":
          if (current?.key === `tool:${event.index}`) {
            current.close();
            current = null;
          }
          break;
        case "message.end":
          stopReason = event.stopReason;
          break;
        case "usage":
          usage = event;
          break;
        case "error":
          writeSseData(res, responseFailed(id, model, event.error));
          res.end();
          return;
      }
    }
    // 没有任何 output item 时保持 v0.1 的空 output_text.done 收尾。
    if (nextIndex === 0) writeSseData(res, outputTextDone(id));
    current?.close();
    writeSseData(res, responseCompleted(id, model, usage, stopReason));
    writeSseDone(res);
    res.end();
    return;
  }

  writeJson(res, 200, buildResponsesCompletion(id, model, await run.aggregate(request)));
}
