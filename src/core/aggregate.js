// 非流式响应的唯一实现路径：消费 stream() 产出的事件并聚合。
// Provider 不需要同时维护 stream 与 non-stream 两套执行语义。

/**
 * @returns {Promise<{
 *   id: string,
 *   text: string,
 *   thinking: string,
 *   toolCalls: Array<{ id: string, name: string, arguments: string }>,
 *   usage: { inputTokens: number, outputTokens: number },
 *   stopReason: "stop" | "tool_use" | "length" | "cancelled",
 * }>}
 */
export async function aggregateStream(events) {
  const result = {
    id: "",
    text: "",
    thinking: "",
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: "stop",
  };
  const toolsByIndex = new Map();

  for await (const event of events) {
    switch (event.type) {
      case "message.start":
        if (event.id) result.id = event.id;
        break;
      case "text.delta":
        result.text += event.text;
        break;
      case "thinking.delta":
        result.thinking += event.text;
        break;
      case "tool.start":
        toolsByIndex.set(event.index, { id: event.id, name: event.name, arguments: "" });
        break;
      case "tool.arguments.delta": {
        const tool = toolsByIndex.get(event.index);
        if (tool) tool.arguments += event.json;
        break;
      }
      case "usage":
        result.usage = {
          inputTokens: event.inputTokens ?? result.usage.inputTokens,
          outputTokens: event.outputTokens ?? result.usage.outputTokens,
        };
        break;
      case "message.end":
        result.stopReason = event.stopReason;
        break;
      case "error":
        throw event.error;
      default:
        break;
    }
  }

  result.toolCalls = [...toolsByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, tool]) => tool);
  return result;
}
