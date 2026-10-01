# qoder-proxy-api

[![CI](https://github.com/ggbdpq/qoder-proxy-api/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/ggbdpq/qoder-proxy-api/actions/workflows/ci.yml) ![Node](https://img.shields.io/badge/node-%E2%89%A524.21-339933?logo=node.js&logoColor=white) ![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

`qoder-proxy-api` 是一个本地多 Provider 协议兼容层：下游暴露 OpenAI / Anthropic 风格接口，上游支持三条互相隔离的 Qoder 链路。

```
OpenAI Chat / Responses / Anthropic Messages
            │  协议适配器（只消费 Canonical Event）
            ▼
   Canonical Request / Event  ←—— Provider Contract
            │
            ▼
     Provider Registry + 显式模型路由
      /           |            \
  Gateway      CLI        Cloud Agents
（默认）   （qodercli 子进程）  （官方 PAT + Cloud API）
```

> **定位声明**：本项目为个人**学习研究**用途。Gateway / CLI 链路涉及客户端私有协议，
> 行为随官方客户端升级可能失效；与 Qoder 官方无任何关联。请遵守 Qoder 服务条款，
> 自行保管令牌。不实现账号池、额度共享或限流绕过。

## Quick Demo（无凭证，30 秒）

```bash
pnpm install && pnpm demo
```

三条 Provider 链路的上游替换为本地 fake（复用 `test/fixtures` 的真实 SSE 抓包），
server、协议序列化与模型路由走的都是生产代码路径；运行后自动向三个下游端点
各发一路流式请求并原样打印 wire。不需要 Qoder 账号，不需要任何 API Key。

## 三条 Provider 链路

|          | `gateway`（默认）                       | `cli`                        | `cloudAgents`                   |
| -------- | --------------------------------------- | ---------------------------- | ------------------------------- |
| 上游     | Qoder Client Gateway 私有协议           | 本地 `qodercli` 子进程       | Cloud Agents 官方 API           |
| 认证     | `QODER_GATEWAY_PAT` → jobToken → Bearer | 复用 `qodercli login` 登录态 | `QODER_ACCESS_TOKEN`（PAT/SAT） |
| 流式     | SSE（原生）                             | stream-json（JSONL）         | SSE                             |
| Tools    | OpenAI 风格原生通道（未真机验证）       | 显式不支持                   | 显式不支持                      |
| Thinking | `reasoning_content`（未真机验证）       | reasoning part               | 显式不支持                      |
| 模型     | 动态目录 + 兜底表                       | CLI model level              | `QODER_MODEL_MAP` 别名          |
| 成熟度   | **实验性**（逆向协议，随时漂移）        | 依赖本机 CLI 版本            | 已验证（v0.1 起）               |

各能力的验证分级（verified / fixture verified / experimental / unverified）与证据口径见 [docs/06-测试与验证矩阵](docs/06-测试与验证矩阵.md)。

三条链路的账号体系、额度来源、模型语义完全隔离：**没有 Provider 自动 fallback**，失败直接返回清晰错误。

## 启动方式

```powershell
npm start                    # gateway（默认；需要 QODER_GATEWAY_PAT）
npm run start:cli            # qodercli 子进程
npm run start:cloud-agents   # Cloud Agents（v0.1 已验证路径）

# 等价 CLI：
node src/index.ts --provider=gateway
node src/index.ts --provider=cli
node src/index.ts --provider=cloud-agents   # 兼容 cloudAgents 写法
```

默认监听 `http://127.0.0.1:8320`（只绑定 loopback，可用 `HOST`/`PORT` 覆盖）。

## 下游接口（三条链路共用）

- `GET /v1/models`：统一 Model Registry 聚合各 Provider 的模型。
- `POST /v1/chat/completions`：OpenAI Chat，支持 `stream: true`。
- `POST /v1/responses`：OpenAI Responses，支持 `stream: true`。
- `POST /v1/messages`：Anthropic Messages，供 CC Switch / Claude Code 使用。
- `GET /health`：脱敏配置预览（不出 secret）。

鉴权：配置了 `PROXY_API_KEY` 时，下游请求必须带 `Authorization: Bearer <key>`。
`PROXY_API_KEY` 与 Qoder 凭证永久分离，互不复用。

## Gateway 链路配置

```powershell
$env:QODER_GATEWAY_PAT = "qoder_pat_xxx"   # 必填，缺失时启动即 fail fast
$env:QODER_GATEWAY_REGION = "cn"           # 目前仅 cn 端点
# $env:QODER_GATEWAY_MODEL_CACHE_TTL_MS = "600000"
npm start
```

模型名可直接用动态目录里的 display name（如 `Qwen3.7-Max`、`Qwen3.7-Plus`），
缺省 `default` 走目录里的 `is_default` 项。

**实验性声明**：Gateway 协议来自公开协议参考实现的独立移植，
本机仅完成协议形状级验证（假上游 + 差分 golden），未经真实账号端到端验证。
tools / thinking / vision 的能力声明以参考实现为准，协议漂移时首先怀疑这三项。

## CLI 链路配置

```powershell
# 前置：qodercli 已安装并 qodercli login
$env:QODER_CLI_BIN = "qodercli"            # 或指向真实 node 入口
# $env:QODER_CLI_NODE = "node"             # QODER_CLI_BIN 是 .js/.mjs 时指定解释器
# $env:QODER_CLI_MODEL = "ultimate"
# $env:QODER_CLI_TIMEOUT_MS = "600000"
npm run start:cli
```

- 每次请求一个独立子进程（`qodercli -p <prompt> -q -f stream-json`），不经 shell。
- 多轮上下文由请求 messages 显式重放为 prompt。
- 客户端断开或超时会终止子进程（SIGTERM → SIGKILL 升级）。
- Windows 下 npm `.cmd` shim 无法无 shell 启动（Node 安全策略），代理**有意不降级到 shell**：
  把 `QODER_CLI_BIN` 指向包内真实 `cli.js` 入口并用 `QODER_CLI_NODE` 指定 node。

## Cloud Agents 链路配置

```powershell
$env:QODER_ACCESS_TOKEN = "qoder_pat_or_sat"
$env:QODER_AGENT_ID = "agent_xxx"
$env:QODER_ENVIRONMENT_ID = "env_xxx"
$env:PROXY_API_KEY = "local-dev-key"
npm run start:cloud-agents
```

或一次性初始化（自动创建 Environment / Agent 并写入 `.env`）：

其他两条链路没有可自动创建的资源（gateway 的 PAT 要在 qoder.cn/account/integrations 手动创建；cli 直接用 `qodercli login` 登录态），可用 `npm run doctor` 一次性体检三条链路的配置状态：

```powershell
$env:QODER_ACCESS_TOKEN = "pt_xxx"
npm run setup:cloudAgents
Remove-Item Env:QODER_ACCESS_TOKEN
npm run start:cloud-agents
```

多模型（`QODER_MODEL_MAP`，JSON）：

```powershell
$env:QODER_MODEL_MAP='{
  "qoder-cc": {"agentId":"agent_xxx","environmentId":"env_xxx","agentVersion":1},
  "qoder-coding": {"agentId":"agent_yyy","environmentId":"env_yyy"}
}'
```

会话语义：`x-qoder-session-id` 头（或 `metadata.session_id` / `conversation_id`）复用上游
Session（TTL 内）；无 key 的请求用完即归档（`QODER_ARCHIVE_EPHEMERAL=false` 关闭）。

## 显式模型路由

`QODER_MODEL_ROUTES`（JSON）把客户端可见别名显式指到某条链路：

```powershell
$env:QODER_MODEL_ROUTES='{
  "qoder-cc":    {"provider": "cloudAgents", "model": "qoder-cc"},
  "qoder-cli-u": {"provider": "cli",         "model": "ultimate"},
  "qoder-qwen":  {"provider": "gateway",     "model": "Qwen3.7-Max"}
}'
```

规则：显式路由优先；未命中的模型名直通**默认 provider**（由其模型解析器裁决，
未知即 400 `unknown model`）。这是路由策略而非故障切换——任何上游失败都会原样报错。

## 测试

```bash
pnpm test
```

89 个用例，全部离线：characterization（v0.1 行为冻结）、provider 合同套件、
协议 golden、故障注入（上游 500/401、malformed SSE、流中错误、abort、超时、
非零退出）、Gateway codec 与 Python 参考实现的差分 golden。
真实凭证的 live 测试未内置；接真实网关前请先抓包核对 fixtures。

## 目录结构

```
src/
├── index.ts / bootstrap.ts      启动与 Provider 组装（TypeScript，Node 24 原生 type stripping）
├── core/                        Canonical Request/Event、Provider Contract、聚合、能力协商、错误码
├── protocols/openai/            Chat / Responses / 请求转换 / 流式 wire
├── protocols/anthropic/         Messages / 请求转换 / 流式 wire
├── routing/                     Provider Registry、显式模型路由
├── server/                      HTTP 路由、SSE 写出、错误映射
├── providers/gateway/           auth（jobToken/Bearer/刷新）、codec、models、client、normalize
├── providers/cli/               process（spawn/abort/timeout）、streamParser、config
└── providers/cloudAgents/       client、normalize、config、session store
```

依赖方向硬约束：`protocols` 不依赖 `providers`；`providers` 不依赖 `protocols`；
`routing` 只认识 core contract；Provider 私有协议细节不离开各自目录。
runtime dependencies 为零（仅 Node 24 标准库）。
架构、协议适配、路由语义与能力验证分级的完整文档见 docs/00-07（v0.2.2 校准）。
提交与分支约定见 docs/07。

## License

[MIT](LICENSE) © 2026 ggbdpq
