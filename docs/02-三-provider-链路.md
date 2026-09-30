# 02 · 三 Provider 链路：认证、流式、能力与边界

> 事实来源：`src/providers/{gateway,cli,cloudAgents}/`。每条链路一个目录，
> 私有协议细节不出目录（架构约束，CI 强制）。

## 总览

|          | gateway（默认）                          | cli                          | cloudAgents                     |
| -------- | ---------------------------------------- | ---------------------------- | ------------------------------- |
| 上游     | Qoder Client Gateway 私有协议            | 本地 `qodercli` 子进程       | Cloud Agents 官方 API           |
| 认证     | `QODER_GATEWAY_PAT` → jobToken → Bearer  | 复用 `qodercli login` 登录态 | `QODER_ACCESS_TOKEN`（PAT/SAT） |
| 流式     | SSE（envelope 包裹的 OpenAI 风格 delta） | stream-json（JSONL）         | SSE（running/idle 状态机）      |
| Tools    | OpenAI 风格原生通道（未真机验证）        | 显式不支持                   | 显式不支持                      |
| Thinking | `reasoning_content`（未真机验证）        | reasoning part               | 显式不支持                      |
| 模型     | 动态目录 + 兜底表                        | CLI model level              | `QODER_MODEL_MAP` 别名          |
| 成熟度   | **实验性**（逆向协议，随时漂移）         | 依赖本机 CLI 版本            | 已验证（v0.1 起）               |

三条链路的账号体系、额度来源、模型语义完全隔离：**没有 Provider 自动
fallback**，任何上游失败都原样报错。

## gateway（`providers/gateway/`）

**认证链**（`auth.ts`）：`PAT → POST /algo/api/v3/user/jobToken?Encode=1 →
{securityOauthToken, refreshToken, expireTime}`。状态机：cold exchange →
READY；近过期走 refresh（`needRefresh=true`）；refresh 被拒回退 cold exchange。
并发请求经 single-flight 共享同一次交换/续期。会话含 machineId/machineToken
（randomUUID 生成）用于签名。交换请求与数据请求同受 `requestTimeoutMs`
约束（超时 → `PROVIDER_TIMEOUT`）。

**请求签名与编码**（`codec.ts`）：请求体先 `encode()`（自定义编码，
`Encode=1`），HTTP 头携带 `date`（RFC1123）与其签名。codec 与公开协议
参考实现做了差分 golden 验证（encode 一致性、多字节 UTF-8、签名日期）。

**聊天流**（`client.ts` → `normalize.ts`）：POST SSE 端点，响应为
envelope（`data:{"body":"<json string>","statusCodeValue":200,"statusCode":"OK"}`），
`body` 解码后是 OpenAI 风格 `{choices:[{delta:{content, reasoning_content,
tool_calls}}]}`，归一为 text.delta / thinking.delta / tool.* 事件。上游
metrics 行（非 SSE 格式）安全跳过。

**模型目录**（`models.ts`）：`GET /algo/api/v2/model/list` 动态拉取
（TTL 缓存），端点失败时**静默回退兜底表**（`FALLBACK_CATALOG`，含 `auto`
默认项）——失败原因记录在 `lastError` 但不上抛（既有语义，已知可观测性缺口）。

**边界**：协议来自逆向与参考实现，**未做全能力真机验证**。Tools 与
`reasoning_content` 路径有 fixtures 与单测，但真机行为未验证（见 06 分级）。

## cli（`providers/cli/`）

**执行**（`process.ts`）：spawn `qodercli`（或 `QODER_CLI_BIN`），**不经
shell**，prompt 走 argv——无注入面；Windows npm shim（.cmd）无 shell 无法
启动 → fail fast 并提示用 `QODER_CLI_NODE` 指定解释器。abort → kill 子进程；
`QODER_CLI_TIMEOUT_MS` 超时 → kill + `PROVIDER_TIMEOUT`；非零退出 →
`PROVIDER_UNAVAILABLE`（附 stderr 尾部）。

**流解析**（`streamParser.ts`）：stream-json（JSONL）→ Canonical Event；
assistant parts 与 `result.done` 归一，未识别行安全跳过（CLI 版本可能漂移）。

**模型**：`QODER_CLI_MODEL`；账号与额度完全走 qodercli 自身登录态，
代理不复制凭证。

## cloudAgents（`providers/cloudAgents/`）

**客户端**（`client.ts`）：Bearer 认证，baseUrl 统一规范化到 `/api/v1/cloud`
（`normalizeCloudBaseUrl`）。会话生命周期：`POST /sessions`（校验 spec 的
agentId / environmentId）→ `POST /sessions/:id/events`（发 prompt）→
`GET /sessions/:id/events/stream`（拉流）→ 可选 `POST /sessions/:id/archive`。
请求超时 `requestTimeoutMs` → `PROVIDER_TIMEOUT`（对齐后的语义）。

**归一化**（`normalize.ts`）：自 v0.1 原样迁入，禁止顺手改行为。
running 事件门控、全文 `agent.message` 事件去重、idle 事件结束、
无 idle 也结束（防挂）。`session.error` → `PROVIDER_PROTOCOL_ERROR`。

**会话语义**（`index.ts`）：`conversationId`（或 `x-qoder-session-id` 头）
相同 → 复用同一上游会话；无会话键的请求用 ephemeral session，流结束后按
`archiveEphemeralSessions` 决定是否归档。模型必须命中 `QODER_MODEL_MAP`
（别名 → `{modelId, agentId, environmentId, agentVersion?}`），未命中 →
`MODEL_NOT_FOUND`。
