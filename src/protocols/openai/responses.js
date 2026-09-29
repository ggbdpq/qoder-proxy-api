// OpenAI Responses 端点适配器：Canonical Event → wire。
import { HttpError, wireId, writeJson } from "../../server/http.js";
import { beginSse, writeSseData, writeSseDone } from "../../server/sse.js";
import { assertHasText, responsesToCanonical } from "./request.js";
import {
  outputTextDelta,
  outputTextDone,
  responseCompleted,
  responseCreated,
  responseFailed,
} from "./stream.js";

export function buildResponsesCompletion({ id, model, text, status = "completed", usage }) {
  const outputId = `msg_${id.replace(/[^a-zA-Z0-9_]/g, "")}`;
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: [
      {
        id: outputId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: text || "", annotations: [] }],
      },
    ],
    output_text: text || "",
    usage: {
      input_tokens: input,
      output_tokens: output,
      total_tokens: input + output,
    },
  };
}

export async function handleResponses({ res, body, model, run }) {
  const request = responsesToCanonical(body, model);
  assertHasText(request, "input must contain text");

  const id = wireId("resp");
  if (body.stream) {
    beginSse(res);
    writeSseData(res, responseCreated(id, model));
    let usage;
    for await (const event of run.stream(request)) {
      if (event.type === "text.delta") {
        writeSseData(res, outputTextDelta(id, event.text));
      } else if (event.type === "usage") {
        usage = event;
      } else if (event.type === "error") {
        writeSseData(res, responseFailed(id, model, event.error));
        res.end();
        return;
      }
    }
    writeSseData(res, outputTextDone(id));
    writeSseData(res, responseCompleted(id, model, usage));
    writeSseDone(res);
    res.end();
    return;
  }

  const result = await run.aggregate(request);
  writeJson(res, 200, buildResponsesCompletion({ id, model, text: result.text, usage: result.usage }));
}
