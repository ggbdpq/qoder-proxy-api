# 03 · 协议适配：OpenAI 与 Anthropic

> 事实来源：`src/protocols/openai/{chat,responses,request,stream}.ts`、
> `src/protocols/anthropic/{messages,request,stream}.ts`。
> wire 形状的最终裁判是 `test/characterization/cloudWire.test.ts` 的 golden 用例。

## 入站解析（下游请求 → CanonicalRequest）

| 端点                                          | 解析要点                                                                                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/chat/completions`（`openai/request.ts`） | `system`/`developer` 角色进 canonical `system` 字段，其余 role 归一；`image_url` 内容降级为占位文本（v0.1 语义）；tools 的 `function.parameters` → `inputSchema` |
| `/v1/responses`（`openai/request.ts`）        | `input` 接受字符串或数组（message 形状）；`instructions` 进 canonical `system`；`include_usage` 由流式层处理                                                     |
| `/v1/messages`（`anthropic/request.ts`）      | `system`（字符串或块）进 canonical `system`；content 块经 flattenBlocks 拼为文本（v0.1 语义，非 text 块丢弃）；`max_tokens`/`temperature`/`metadata.title` 直映  |

入站共享工具（`server/http.ts`）：`readJsonBody`（JSON body）、
`requireBearer`（下游鉴权，`QODER_PROXY_API_KEY`）、`asRecord` 窄化。
body 的动态字段一律 `unknown` + 窄化读取，不信任客户端形状。

## 出站流式 wire（Canonical Event → 下游 SSE）

三个协议序列化器各自消费同一条 `ProviderEvent` 流：

- **Chat**（`openai/stream.ts`）：`chat.completion.chunk` 序列；`usage`
  汇总进收尾 chunk（`choices: []`）；结束写 `data: [DONE]`。
- **Responses**（`openai/stream.ts`）：`response.created` →
  `response.output_text.delta`×N → `response.output_text.done` →
  `response.completed`（status: completed / failed）→ `[DONE]`。
- **Messages**（`anthropic/stream.ts`）：`message_start` →
  `content_block_start` → `content_block_delta`×N → `content_block_stop` →
  `message_delta`（stop_reason + output usage）→ `message_stop`。

usage 聚合的最小公共形状是 `UsageSummary`（`UsageSummary` 只认
Provider `usage` 事件给的 inputTokens/outputTokens）。

## 非流式

`/v1/chat/completions` 与 `/v1/messages` 在 `stream: false`（或缺省）时走
`core/aggregate.ts` 聚合后一次性 JSON 返回（非流式无独立执行路径）。
Responses 端点同理由 protocol 层决定流式与否。

## 错误的出站形状

Provider `error` 事件与抛出的 `ProviderError` 由 `server/server.ts` 的
`mapError` 统一映射（码 → HTTP 状态 + error type），OpenAI 系端点出
`writeOpenAIError` 形状，Messages 端点出 Anthropic 错误形状。
完整错误码表与映射见 `05-sse-错误-abort-usage.md`。

流已开始后再出错：连接截断（无法再给结构化错误），客户端看到不完整流——
这是既有语义，`headersSent` 守卫保证服务进程不崩。
