# 01 · Canonical 模型与 Provider Contract

> 事实来源：`src/core/request.ts`、`src/core/events.ts`、`src/core/provider.ts`、
> `src/core/capabilities.ts`、`src/core/aggregate.ts`。类型以源码为准，本文不复制完整定义。

## Canonical Request（`core/request.ts`）

下游协议 → Provider 的统一请求语言。字段与来源协议的映射见
`03-协议适配-openai-anthropic.md`。

| 字段                                            | 类型                     | 说明                                                                                                                              |
| ----------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `model`                                         | string                   | 经路由解析后的目标模型（server 层应用，见 04）                                                                                    |
| `system`                                        | string \| Part[]（可选） | 系统提示，Anthropic 语义                                                                                                          |
| `messages`                                      | Message[]                | `role: system \| user \| assistant \| tool`；content 为 string 或 Part 数组；tool 消息带 `toolCallId`，assistant 可带 `toolCalls` |
| `tools`                                         | Tool[]（可选）           | `name` + 可选 `description` + `inputSchema`                                                                                       |
| `toolChoice`                                    | 可选                     | `"auto" \| "none" \| { name }`                                                                                                    |
| `maxTokens` / `temperature` / `reasoningEffort` | 可选标量                 | `reasoningEffort: low \| medium \| high \| max`                                                                                   |
| `metadata`                                      | Record（可选）           | 透传（如 Anthropic title）                                                                                                        |

Part 只有两种：`{ type: "text", text }` 与 `{ type: "image", source }`。
`createProviderContext()` 生成 `ProviderContext`（requestId / conversationId /
cwd / signal），运行上下文一律走 context，不污染消息正文。

## Provider Event（`core/events.ts`）

Provider 私有流事件归一化后的统一语言，9 种可辨识联合（按 `type` 判别）：

| type                   | 载荷                                                | 语义                                          |
| ---------------------- | --------------------------------------------------- | --------------------------------------------- |
| `message.start`        | id?                                                 | 消息开始                                      |
| `text.delta`           | text                                                | 正文增量                                      |
| `thinking.delta`       | text                                                | 思考增量                                      |
| `tool.start`           | index, id, name                                     | 工具调用开始                                  |
| `tool.arguments.delta` | index, json                                         | 工具参数增量（按 index 聚合）                 |
| `tool.end`             | index                                               | 工具调用结束                                  |
| `usage`                | inputTokens?, outputTokens?                         | 用量                                          |
| `message.end`          | stopReason: stop \| tool_use \| length \| cancelled | 结束与停止原因                                |
| `error`                | error: ProviderError                                | 流内错误（Provider 捕获上游异常后发出，不抛） |

## Provider Contract（`core/provider.ts`）

路由层唯一认识的出站接口，保持极小：

```ts
interface QoderProvider {
  id: "gateway" | "cli" | "cloudAgents";
  capabilities(): ProviderCapabilities | Promise<ProviderCapabilities>;
  listModels(): Promise<ProviderModel[]>; // { id, label? }
  stream(request, context): AsyncIterable<ProviderEvent>;
  dispose?(): Promise<void>;
}
```

`assertProvider()` 在注册期 fail fast：缺方法或缺能力键直接 TypeError，
不让坏 Provider 进入路由。

## 能力协商（`core/capabilities.ts`）

`ProviderCapabilities` 九键：streaming / cancellation / sessions(Support3) /
tools(Support3) / thinking(ThinkingSupport) / vision(VisionSupport) /
modelDiscovery / usage / resume。

`assertCapability(capabilities, request)` 是唯一的拒绝路径，**不做隐式降级**：

- 请求带 tools 且 `tools === "none"` → `UNSUPPORTED_CAPABILITY`
- 请求带 reasoningEffort 且 `thinking === "none"` → `UNSUPPORTED_CAPABILITY`
- 请求含 image part 且 `vision === "none"` → `UNSUPPORTED_CAPABILITY`

降级类转换（如 OpenAI `image_url` → 占位文本）发生在协议入站解析层并在
README 声明，协商层只看 Canonical 请求与显式能力。

## 聚合（`core/aggregate.ts`）

非流式的唯一实现：消费 `stream()` 事件流，聚合 text / thinking / toolCalls
（按 index 重装参数分片）/ usage / stopReason，产出 `AggregateResult`。
`error` 事件以抛出 `ProviderError` 的方式结束聚合。Provider 因此不需要
stream 与 non-stream 两套执行语义。
