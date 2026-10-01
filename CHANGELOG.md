# Changelog

格式参考 Keep a Changelog；版本序列规则见 `docs/07-提交与分支约定.md`
（Phase x 收口 → v0.2.x）。

## v0.2.4 — 2026-10-01

对抗式审查闭环（Adversarial Review Loop）。

- 认证回退失败统一错误通道：gateway refresh 被拒后的 cold-exchange
  回退再失败时不再抛裸错误，统一 PROVIDER_AUTH_ERROR
- 流响应空 body 显式化：gateway/cloud 事件流遇 200 空 body 时给出
  PROVIDER_PROTOCOL_ERROR（实测 undici 空流场景为干净结束，null 场景由
  显式检查兜底），测试锁定实测行为
- 删除 gateway 消息映射的死代码（name 透传，合同未声明的字段）
- docs/00 索引补 docs/07；测试数校准 89

## v0.2.2 — 2026-10-01

Phase 2 · 验证矩阵与项目约定。

- 架构文档 8 篇：总览与依赖方向、Canonical 模型与 Provider Contract、
  三 Provider 链路、协议适配、模型路由、SSE/错误/abort/usage、
  测试体系与验证矩阵、提交与分支约定
- 验证矩阵：能力 × 三链路分级（verified / fixture verified 抓包·参考差分·合成 /
  experimental / unverified），附逐格证据索引表
- docs/07：main/develop 分支模型、Conventional Commits 简化版（scope 必填）、
  发布流程；develop 分支纳入 CI 触发

## v0.2.1 — 2026-10-01

Phase 1 · 离线 Demo。

- `pnpm demo`：无凭证跑通三协议流式 wire（fake 上游 × 生产 server 全链路），
  输出 SSE 原文与上游交互统计
- 修复显式模型路由的目标 model 未应用到 CanonicalRequest（server 层
  集成测试锁定）；修复流中错误重复写响应头导致的进程崩溃

## v0.2.0 — 2026-10-01

Phase 0 · TypeScript 与质量门。

- 58 个 .js/.mjs 统一迁移为 .ts：Node 24 原生 type stripping，零构建，
  运行时依赖保持为零；tsc strict 0 错误
- 公开全部离线测试与 fixtures（86 用例）：provider 合同套件、三协议
  golden、差分校验、abort/timeout/错误映射
- CI 六步质量门：install → typecheck → lint → format:check →
  architecture check → test（Node 24 固定）
- 上游超时跨链路对齐：gateway 认证交换补 `requestTimeoutMs` 约束，
  cloud 超时统一 `PROVIDER_TIMEOUT`

## v0.1.0 — 2026-09-29

- 三链路协议网关：gateway（私有协议）/ cli（qodercli 子进程）/
  cloudAgents（官方 API），Canonical Request/Event、Provider Contract、
  显式模型路由，OpenAI Chat / Responses 与 Anthropic Messages 兼容

## v0.0.1 — 2026-09-19

- 初始化 Qoder Cloud Agents 兼容层与本地代理服务骨架
