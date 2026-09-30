# 05 · SSE、错误、abort 与 usage

> 事实来源：`src/server/sse.ts`（下游写出）、`src/sse.ts`（上游解析）、
> `src/server/server.ts`（错误映射与取消）、`src/core/errors.ts`（错误码）、
> `src/core/aggregate.ts`（usage 聚合）。

## SSE 两个方向

- **下游写出**（`server/sse.ts`）：`beginSse`（200 + `text/event-stream` +
  禁缓冲头）、`writeSseData`（`data: <json>\n\n`）、`writeSseDone`
  （`data: [DONE]`）、`beginSseError` 不存在——错误走 `writeOpenAIError`
  或 Anthropic 错误形状（仅在头未发出时）。
- **上游解析**（`src/sse.ts`）：`parseSseChunk` 把字节流切成 `SseEvent`
  （id/event/data），`decodeSseData` 解 JSON；不完整行跨 chunk 缓冲。
  各 Provider 在此之上做私有 envelope / JSONL 的二次解析。

## 错误码（`core/errors.ts`）

`ProviderError` 携带机器可读 `code`（可选 `status`、`cause`、`details`），
协议层依赖这些码做下游错误映射。码集封闭（`errors.test.ts` 锁定）：

| code                      | 典型来源                                                         |
| ------------------------- | ---------------------------------------------------------------- |
| `PROVIDER_AUTH_ERROR`     | PAT 被拒、流中 401/403、认证态缺失                               |
| `PROVIDER_TIMEOUT`        | 上游请求超时（gateway 数据与认证交换、cli 进程超时、cloud 请求） |
| `PROVIDER_ABORTED`        | 客户端取消传播到上游                                             |
| `PROVIDER_UNAVAILABLE`    | 连接失败、非零退出、missing bin、上游 5xx                        |
| `PROVIDER_PROTOCOL_ERROR` | 上游协议形状被破坏（如 session.error、缺 session id）            |
| `PROVIDER_RATE_LIMITED`   | 上游限流                                                         |
| `MODEL_NOT_FOUND`         | 模型名解析失败（下游 400）                                       |
| `UNSUPPORTED_CAPABILITY`  | 能力协商拒绝                                                     |

下游映射（`server/server.ts` `mapError`）：`ProviderError.status` 优先，
其余按码段归一（MODEL_NOT_FOUND → 400，AUTH → 401/403 段，其余 5xx），
统一 `writeOpenAIError` / Anthropic 错误形状。流已开始后的错误只能截断
连接（`headersSent` 守卫，进程不崩）。

## abort 三层传播

1. **客户端断开**：`res.on("close")` → `controller.abort()`（server 层）。
2. **Provider 收到 signal**：gateway/cloud 经 `AbortSignal.any` 并入请求；
   cli 直接 kill 子进程。
3. **上游断流**：provider 产出 `PROVIDER_ABORTED` 或流自然终止；
   characterization 锁定「client disconnect aborts the upstream stream and
   server stays healthy」。

超时是独立的 abort 源：`requestTimeoutMs` 同时约束 gateway 数据请求与
| **认证交换**（v0.2.0 起）、cloud 全部请求、cli 进程生命周期，超时统一
`PROVIDER_TIMEOUT`（cloud 侧 v0.2.0 前误报 `PROVIDER_UNAVAILABLE`，
已由 `test/providers/upstreamTimeout.test.ts` 对齐）。

## usage

Provider 的 `usage` 事件（inputTokens / outputTokens）是唯一来源：
聚合进 `AggregateResult`（非流式 JSON），流式端收进各协议的收尾表达
（Chat 收尾 chunk、Responses `response.completed`、Messages
`message_delta`）。gateway 的上游 metrics 行不当作文本（realWire 测试锁定），
usage 数字来自上游真实返回；本服务不做任何估算与注水。
