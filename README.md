# qoder-proxy-api

[![CI](https://github.com/ggbdpq/qoder-proxy-api/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/ggbdpq/qoder-proxy-api/actions/workflows/ci.yml) ![Node](https://img.shields.io/badge/node-%E2%89%A524.21-339933?logo=node.js&logoColor=white) ![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

本地多 Provider 协议网关：下游暴露 OpenAI Chat / Responses 与 Anthropic Messages 兼容 API（支持流式），上游适配三条互相隔离的 Qoder 链路。

> **定位声明**：个人学习研究用途。Gateway / CLI 链路涉及客户端私有协议，行为随官方客户端升级可能失效；与 Qoder 官方无任何关联。请遵守 Qoder 服务条款，自行保管令牌。不实现账号池、额度共享或限流绕过。

## What is qoder-proxy-api

它解决的问题：**把三个异构的 Qoder 上游统一成一套标准的 OpenAI / Anthropic 兼容 API**，让 Claude Code、CC Switch、OpenAI SDK 等客户端无需感知上游差异。

- 下游协议 ↔ 内部语言 ↔ 上游 Provider 三层解耦：协议适配器只消费 Canonical Event，Provider 适配器只产出 Canonical Event，两者互不感知（依赖方向由 CI 强制）。
- 显式模型路由是唯一路由策略：别名 → `{ provider, model }`，未命中直通默认 Provider；**没有自动 fallback**，任何上游失败原样报错。
- 全部离线可验证：89 个测试、fake 上游、无凭证 demo。

## Architecture

```text
OpenAI Chat / Responses / Anthropic Messages
            │  协议适配器（只消费 Canonical Event）
            ▼
   Canonical Request / Event  ←—— Provider Contract
            │
            ▼
     Provider Registry + 显式模型路由
      /           |              Gateway      CLI        Cloud Agents
（默认）   （qodercli 子进程）  （官方 PAT + Cloud API）
```

### Design Decisions

- **为什么需要 Canonical Contract，而不是做三个直接转换器？** 三个上游的事件形状、认证方式、错误语义完全不同；先归一到 Canonical Event，下游序列化器只需消费一种语言，新增 Provider 时也不碰协议层（adapter boundary 由 `scripts/architectureCheck.ts` 在 CI 强制）。
- **别人如何确认没有伪造兼容？** 协议形状由 characterization golden 与 provider 合同套件锁定，fixtures 是真实 SSE 抓包，`pnpm test` 离线可复现；每个能力声明的证据指针见 [docs/06-测试与验证矩阵](docs/06-测试与验证矩阵.md)。
- **未来增加第四 Provider 怎么做？** 实现 `QoderProvider` 合同（capabilities / listModels / stream），注册进 Registry，加一条显式路由——协议层与 server 层零改动。Provider 私有协议细节不离开各自目录。

## Quick Demo（无凭证，30 秒）

```bash
pnpm install && pnpm demo
```

三条链路的上游替换为本地 fake（复用 `test/fixtures` 的真实 SSE 抓包），server、协议序列化与模型路由走的都是生产代码路径；自动向三个下游端点各发一路流式请求并原样打印 wire。不需要 Qoder 账号，不需要任何 API Key。

## Compatibility Matrix

|          | `gateway`（默认）                       | `cli`                        | `cloudAgents`                   |
| -------- | --------------------------------------- | ---------------------------- | ------------------------------- |
| 上游     | Qoder Client Gateway 私有协议           | 本地 `qodercli` 子进程       | Cloud Agents 官方 API           |
| 认证     | `QODER_GATEWAY_PAT` → jobToken → Bearer | 复用 `qodercli login` 登录态 | `QODER_ACCESS_TOKEN`（PAT/SAT） |
| 流式     | SSE（原生）                             | stream-json（JSONL）         | SSE                             |
| Tools    | OpenAI 风格原生通道（未真机验证）       | 显式不支持                   | 显式不支持                      |
| Thinking | `reasoning_content`（未真机验证）       | reasoning part               | 显式不支持                      |
| 模型     | 动态目录 + 兜底表                       | CLI model level              | `QODER_MODEL_MAP` 别名          |
| 成熟度   | **实验性**（逆向协议，随时漂移）        | 依赖本机 CLI 版本            | 已验证（v0.1 起）               |

各能力的验证分级（verified / fixture verified / experimental / unverified）与逐格证据索引见 [docs/06-测试与验证矩阵](docs/06-测试与验证矩阵.md)。三条链路的账号体系、额度来源、模型语义完全隔离：**没有 Provider 自动 fallback**，失败直接返回清晰错误。

## 下游接口（三条链路共用）

- `GET /v1/models`：统一 Model Registry 聚合各 Provider 的模型。
- `POST /v1/chat/completions`：OpenAI Chat，支持 `stream: true`。
- `POST /v1/responses`：OpenAI Responses，支持 `stream: true`。
- `POST /v1/messages`：Anthropic Messages，供 CC Switch / Claude Code 使用。
- `GET /health`：脱敏配置预览（不出 secret）。

鉴权：配置了 `PROXY_API_KEY` 时，下游请求必须带 `Authorization: Bearer <key>`。`PROXY_API_KEY` 与 Qoder 凭证永久分离，互不复用。

## 运行与配置

```bash
npm start                    # gateway（默认；需要 QODER_GATEWAY_PAT）
npm run start:cli            # qodercli 子进程
npm run start:cloud-agents   # Cloud Agents
```

默认监听 `http://127.0.0.1:8320`（只绑定 loopback，`HOST`/`PORT` 可覆盖）。

- **gateway**：`QODER_GATEWAY_PAT` 必填（缺失 fail fast）；模型名用动态目录 display name，缺省走 `is_default` 项。**实验性**：协议形状级验证（假上游 + 差分 golden），未真实账号端到端验证；协议漂移时首先怀疑 tools / thinking。
- **cli**：前置 `qodercli login`；每次请求独立子进程，不经 shell；Windows npm shim 限制见 [docs/02-三-provider-链路](docs/02-三-provider-链路.md)。
- **cloudAgents**：`QODER_ACCESS_TOKEN` + `QODER_AGENT_ID` + `QODER_ENVIRONMENT_ID`；`npm run setup:cloudAgents` 可自动初始化；多模型用 `QODER_MODEL_MAP`。会话复用与归档语义见 docs/02。
- 环境变量全表与配置细节：[docs/02-三-provider-链路](docs/02-三-provider-链路.md)。

## 显式模型路由

```bash
QODER_MODEL_ROUTES='{
  "qoder-cc":    {"provider": "cloudAgents", "model": "qoder-cc"},
  "qoder-cli-u": {"provider": "cli",         "model": "ultimate"},
  "qoder-qwen":  {"provider": "gateway",     "model": "Qwen3.7-Max"}
}'
```

规则与语义（含 server 层应用点）：[docs/04-模型路由](docs/04-模型路由.md)。

## Testing

```bash
pnpm test
```

89 个用例，全部离线：characterization（v0.1 行为冻结）、provider 合同套件、协议 golden、差分校验（codec 对 Python 参考实现、cloudAgents 对 legacy runTurn）、故障注入（上游 500/401、malformed SSE、流中错误、abort、超时、空 body、非零退出）、路由集成与对抗审查闭环。真实凭证的 live smoke 入口在 `test/live/gatewayLive.ts`（输出全程脱敏，默认不运行）。

## Limitations

- Gateway 全链路 **experimental**：协议逆向而来，随时漂移；tools / thinking 未真机验证。
- 模型目录拉取失败静默兜底（可观测性缺口，已知）。
- malformed SSE 的 raw-text 泄漏为 v0.1 已知 wart（characterization 锁定）。
- 不实现：账号池、额度共享、限流绕过、多租户、数据库、Web 控制台。

完整分级与证据：[docs/06-测试与验证矩阵](docs/06-测试与验证矩阵.md)。

## Docs

架构、协议适配、路由语义、流与错误、验证矩阵、提交约定：[docs/00-架构总览](docs/00-架构总览与依赖方向.md) 起 8 篇（v0.2.2 校准）。版本变更史：[CHANGELOG](CHANGELOG.md)。提交与分支约定见 docs/07。

## License

[MIT](LICENSE) © 2026 ggbdpq
