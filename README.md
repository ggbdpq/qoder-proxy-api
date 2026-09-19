# qoder-proxy-api

`qoder-proxy-api` 是一个本地兼容层：下游暴露 OpenAI/Anthropic 风格接口，上游调用 Qoder Cloud Agents。优先目标是 CC Switch，其次 Cockpit Tools，最后 CLIProxyAPI。

它不是 Qoder 桌面端登录态抓取器，也不复用 cookie；只走 Qoder 官方 PAT/SAT 对应的 Cloud Agents API。

> **定位声明**：本项目为个人**学习研究**用途——通过公开的 Cloud Agents API 理解协议兼容层
> （OpenAI Chat Completions / Responses / Anthropic Messages）的适配设计。与 Qoder 官方
> 无任何关联，接口行为随官方变更可能失效；请遵守 Qoder 服务条款，自行保管令牌。

## 当前能力

- `GET /v1/models`：返回本地模型别名。
- `POST /v1/chat/completions`：OpenAI Chat Completions 兼容，支持 `stream: true`。
- `POST /v1/responses`：OpenAI Responses 兼容，支持 `stream: true`。
- `POST /v1/messages`：Anthropic Messages 最小兼容，支持 `stream: true`，用于 CC Switch / Claude Code 风格客户端优先验证。
- `GET /health`：本地健康检查和脱敏配置预览。

## 环境变量

最小配置：

```powershell
$env:QODER_ACCESS_TOKEN="qoder_pat_or_sat"
$env:QODER_AGENT_ID="agent_xxx"
$env:QODER_ENVIRONMENT_ID="env_xxx"
$env:PROXY_API_KEY="local-dev-key"
node .\src\index.js
```

可选配置：

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` / `QODER_PROXY_PORT` | `8320` | 监听端口 |
| `QODER_API_BASE_URL` | `https://api.qoder.com/api/v1/cloud` | Qoder Cloud Agents API base |
| `QODER_MODEL_ID` / `QODER_DEFAULT_MODEL` | `qoder-agent-default` | 单模型模式下的本地模型名 |
| `QODER_AGENT_VERSION` | 空 | 固定 Agent 版本 |
| `QODER_MODEL_MAP` | 空 | JSON 对象，多模型映射 |
| `QODER_ARCHIVE_EPHEMERAL` | `true` | 无 session key 请求完成后归档 Qoder Session |
| `QODER_SESSION_TTL_MS` | `7200000` | `x-qoder-session-id` 复用缓存时长 |

多模型示例：

```powershell
$env:QODER_MODEL_MAP='{
  "qoder-cc": {"agentId":"agent_xxx","environmentId":"env_xxx","agentVersion":1},
  "qoder-coding": {"agentId":"agent_yyy","environmentId":"env_yyy"}
}'
```


## 本地部署

一次性初始化 Qoder 账号配置，会自动获取/创建默认 Environment 和 `qoder-proxy-agent`，并把结果写入被 git 忽略的 `.env`：

```powershell
$env:QODER_ACCESS_TOKEN="pt_xxx"
npm run setup:qoder
Remove-Item Env:QODER_ACCESS_TOKEN
npm start
```

启动后本地服务地址：`http://127.0.0.1:8320`。

## 学习指南：三个 Qoder 配置怎么来

这三个值都来自 Qoder Cloud Agents API，不来自 CC Switch，也不是 Claude Code 的配置项。

| 变量 | 来源 | 用途 |
|---|---|---|
| `QODER_ACCESS_TOKEN` | Qoder Console 创建的 PAT，或组织 Service Account 换出来的 SAT | 代理访问 Qoder 上游 API 的凭证 |
| `QODER_ENVIRONMENT_ID` | Cloud Agents Environment 的 `id`，形如 `env_xxx` | Qoder 会话运行在哪个云环境里 |
| `QODER_AGENT_ID` | Cloud Agents Agent 的 `id`，形如 `agent_xxx` | Qoder 会话使用哪个 Agent 定义、模型和工具集 |

### 我刚才实际做了什么

本仓库的 `npm run setup:qoder` 跑的是 `scripts/setup-qoder.mjs`，逻辑很短：

1. 读取 `QODER_ACCESS_TOKEN`。
2. `GET https://api.qoder.com/api/v1/cloud/environments`：有 Environment 就用名为 `default` 的，否则用第一个。
3. 如果没有 Environment，就 `POST /environments` 创建 `{ "name": "default" }`，得到 `QODER_ENVIRONMENT_ID`。
4. `GET https://api.qoder.com/api/v1/cloud/agents`：有名为 `qoder-proxy-agent` 的 Agent 就用它，否则用第一个。
5. 如果没有 Agent，就 `POST /agents` 创建一个 `model: "ultimate"`、带 Bash/Read/Write/Edit/Glob/Grep/WebFetch/WebSearch 工具的 Agent，得到 `QODER_AGENT_ID`。
6. 生成本地 `PROXY_API_KEY`，把四个值写进 `.env`。

`.env` 只给本地代理使用；CC Switch 只填 `.env` 里的 `PROXY_API_KEY`，不要填 Qoder PAT。

### 手动获取 `QODER_ENVIRONMENT_ID`

```powershell
$env:QODER_API_BASE_URL = "https://api.qoder.com"
$headers = @{ Authorization = "Bearer $env:QODER_ACCESS_TOKEN" }
$jsonHeaders = @{
  Authorization = "Bearer $env:QODER_ACCESS_TOKEN"
  "Content-Type" = "application/json"
}

$envList = Invoke-RestMethod "$env:QODER_API_BASE_URL/api/v1/cloud/environments" -Headers $headers
$envList.data | Select-Object id, name
```

如果列表为空，创建一个默认环境：

```powershell
$body = @{ name = "default" } | ConvertTo-Json
$createdEnv = Invoke-RestMethod "$env:QODER_API_BASE_URL/api/v1/cloud/environments" `
  -Method Post `
  -Headers $jsonHeaders `
  -Body $body

$env:QODER_ENVIRONMENT_ID = $createdEnv.id
$env:QODER_ENVIRONMENT_ID
```

### 手动获取 `QODER_AGENT_ID`

```powershell
$agentList = Invoke-RestMethod "$env:QODER_API_BASE_URL/api/v1/cloud/agents" -Headers $headers
$agentList.data | Select-Object id, name, model
```

如果列表为空，创建一个给代理用的 Agent：

```powershell
$agentBody = @{
  name = "qoder-proxy-agent"
  model = "ultimate"
  system = "You are an efficient programming assistant skilled at writing code and troubleshooting issues."
  tools = @(
    @{
      type = "agent_toolset_20260401"
      enabled_tools = @("Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch")
    }
  )
} | ConvertTo-Json -Depth 10

$createdAgent = Invoke-RestMethod "$env:QODER_API_BASE_URL/api/v1/cloud/agents" `
  -Method Post `
  -Headers $jsonHeaders `
  -Body $agentBody

$env:QODER_AGENT_ID = $createdAgent.id
$env:QODER_AGENT_ID
```

### 写入本地 `.env`

```powershell
@"
QODER_ACCESS_TOKEN=$env:QODER_ACCESS_TOKEN
QODER_AGENT_ID=$env:QODER_AGENT_ID
QODER_ENVIRONMENT_ID=$env:QODER_ENVIRONMENT_ID
PROXY_API_KEY=local-dev-key
HOST=127.0.0.1
PORT=8320
QODER_MODEL_ID=qoder-agent-default
"@ | Set-Content -LiteralPath .env -Encoding UTF8
```

### 验证配置是否可用

```powershell
npm start

$headers = @{ Authorization = "Bearer local-dev-key"; "Content-Type" = "application/json" }
Invoke-RestMethod http://127.0.0.1:8320/health -Headers $headers
Invoke-RestMethod http://127.0.0.1:8320/v1/chat/completions `
  -Headers $headers `
  -Method Post `
  -Body '{"model":"qoder-agent-default","messages":[{"role":"user","content":"只回复 OK"}]}'
```
## CC Switch 配置优先路径

优先使用 Anthropic-compatible / Claude-compatible 自定义供应商：

- Base URL: `http://127.0.0.1:8320`
- API Key: `PROXY_API_KEY` 的值，例如 `local-dev-key`
- Model: `qoder-agent-default` 或 `QODER_MODEL_MAP` 中的别名
- Endpoint: `/v1/messages`

如果 CC Switch 只提供 OpenAI-compatible 自定义供应商：

- Base URL: `http://127.0.0.1:8320/v1`
- API Key: `PROXY_API_KEY` 的值
- Model: `qoder-agent-default`
- Endpoint: `/chat/completions` 或 `/responses`

## Cockpit Tools 配置路径

按 OpenAI-compatible provider 配置：

- Base URL: `http://127.0.0.1:8320/v1`
- API Key: `PROXY_API_KEY` 的值
- Model: `qoder-agent-default`

## CLIProxyAPI 接入样例

在 CLIProxyAPI 的 `openai-compatibility` 中把本代理作为上游：

```yaml
openai-compatibility:
  - name: qoder-proxy
    base-url: http://127.0.0.1:8320/v1
    api-key-entries:
      - api-key: local-dev-key
    models:
      - name: qoder-agent-default
        alias: qoder-agent-default
```

## 验证

```powershell
npm test

$headers = @{ Authorization = "Bearer local-dev-key"; "Content-Type" = "application/json" }
Invoke-RestMethod http://127.0.0.1:8320/v1/models -Headers $headers
Invoke-RestMethod http://127.0.0.1:8320/v1/chat/completions -Headers $headers -Method Post -Body '{"model":"qoder-agent-default","messages":[{"role":"user","content":"hello"}]}'
```

## 限制

- 当前是 Agent-to-API 兼容层，不是低延迟原生模型 API。
- 工具调用/function calling 暂未翻译；复杂 Claude Code 工具协议要在 CC Switch 真机请求中继续补齐。
- Qoder 真实 SSE 事件若新增字段，`src/openai.js` 的事件提取器需要按样本扩展。

## 扩展方向（学习研究路线）

按"体感收益 ÷ 成本"排序，逐项对应上面的「限制」：

1. **function calling 协议翻译**：把下游 tools/tool_calls 翻译成 Qoder Agent 的工具协议，
   打通 Claude Code 的完整工具回路——当前最大的功能缺口。
2. **SSE 事件提取器样本化**：每遇到一种新的 Qoder SSE 事件，往 `src/openai.js` 的
   提取器加一个用例并配 fixtures（`examples/` 已留目录），测试驱动扩展。
3. **彩色 diff 与流式 Usage**：`/v1/chat/completions` 流式尾部补 usage 事件；
   Responses 接口对齐官方字段。
4. **多模型路由打磨**：`QODER_MODEL_MAP` 多模型下按请求模型名路由不同 Agent，
   并支持 per-model 会话策略。
5. **部署形态**：Dockerfile + docker-compose（.env 挂载），验证 `HOST=0.0.0.0`
   场景下的安全边界。

欢迎按上面的路线提 issue / PR；学习研究用途，随意 fork 与魔改。

## License

[MIT](LICENSE) © 2026 ggbdpq



