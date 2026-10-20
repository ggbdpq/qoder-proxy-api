// Admin API 与路由事件契约（02-接口契约 §2–§4、§7）。网关侧手写校验，不引用本包（ADR-0007）；
// 两边一致靠契约测试：网关产出的真实响应 / 事件必须能被这里的 schema parse。
import { z } from "zod";

export const MemberRef = z.object({ providerId: z.string(), model: z.string() });
export type MemberRef = z.infer<typeof MemberRef>;

export const keyOf = (m: MemberRef) => `${m.providerId}/${m.model}`;

const base = { requestId: z.string(), at: z.number(), seq: z.number().optional() };

export const RouteEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("request.start"),
    ...base,
    agent: z.string(),
    alias: z.string(),
    groupId: z.string().nullable(),
    protocol: z.string(),
  }),
  z.object({
    type: z.literal("route.decision"),
    ...base,
    strategy: z.enum(["ordered", "smart", "direct"]),
    candidates: z.array(
      MemberRef.extend({
        state: z.enum(["ready", "resting", "skipped"]),
        reason: z.string(),
        restUntil: z.number().optional(),
      }),
    ),
  }),
  z.object({
    type: z.literal("upstream.attempt"),
    ...base,
    member: MemberRef,
    attempt: z.number(),
  }),
  z.object({ type: z.literal("upstream.firstByte"), ...base, member: MemberRef, ms: z.number() }),
  z.object({
    type: z.literal("upstream.failed"),
    ...base,
    member: MemberRef,
    code: z.string(),
    status: z.number().optional(),
    restUntil: z.number().optional(),
    reroutable: z.boolean(),
  }),
  z.object({
    type: z.literal("reroute"),
    ...base,
    from: MemberRef,
    to: MemberRef,
    reason: z.string(),
  }),
  z.object({
    type: z.literal("request.end"),
    ...base,
    outcome: z.enum(["ok", "error", "cancelled"]),
    member: MemberRef.nullable(),
    ms: z.number(),
    reroutes: z.number(),
    errorCode: z.string().optional(),
    usage: z
      .object({ inputTokens: z.number().optional(), outputTokens: z.number().optional() })
      .optional(),
  }),
]);
export type RouteEvent = z.infer<typeof RouteEvent>;

export const RouteGroup = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "只能用小写字母、数字和 -，最长 40"),
  name: z.string().min(1, "起个名字"),
  strategy: z.enum(["ordered", "smart"]),
  enabled: z.boolean(),
  maxAttempts: z.number().int().min(1).max(5).default(3),
  members: z
    .array(MemberRef)
    .min(1, "至少一个成员")
    .refine((ms) => new Set(ms.map(keyOf)).size === ms.length, "成员不能重复"),
});
export type RouteGroup = z.infer<typeof RouteGroup>;

export const ProviderKind = z.enum([
  "qoder-gateway",
  "qoder-cli",
  "qoder-cloudAgents",
  "openai-compatible",
  "anthropic-compatible",
]);

export const Provider = z.object({
  id: z.string(),
  kind: ProviderKind,
  label: z.string(),
  baseUrl: z.string().optional(),
  keyHint: z.string().optional(), // Key 只写不读，只回末 4 位
  models: z.array(z.string()),
  capabilities: z.object({ tools: z.boolean(), vision: z.boolean(), thinking: z.boolean() }),
  firstByteTimeoutMs: z.number().optional(),
  enabled: z.boolean(),
  source: z.literal("env").optional(), // 来自环境变量的条目只读
});
export type Provider = z.infer<typeof Provider>;

export const AgentId = z.enum(["claude-code", "codex", "opencode"]);

export const AgentIntegration = z.object({
  id: AgentId,
  installed: z.boolean(),
  configPath: z.string(),
  connected: z.boolean(),
  model: z.string().nullable(), // 写入 Agent 配置的 model（直连或 group/<id>），未接入时为 null
  drift: z.boolean(), // 接入后用户手改过配置
});
export type AgentIntegration = z.infer<typeof AgentIntegration>;

export const Plan = z.object({
  id: z.string(),
  name: z.string().min(1),
  assignments: z.partialRecord(AgentId, z.string()),
});
export type Plan = z.infer<typeof Plan>;

// ponytail: 02 只写了 health[]，未定义元素形状；这里取控制台原型实际用到的字段（在歇的成员 + 原因）。
export const HealthEntry = MemberRef.extend({ restUntil: z.number(), reason: z.string() });
export type HealthEntry = z.infer<typeof HealthEntry>;

export const AdminState = z.object({
  version: z.number(),
  providers: z.array(Provider),
  groups: z.array(RouteGroup),
  health: z.array(HealthEntry),
  agents: z.array(AgentIntegration),
  plans: z.array(Plan),
  lastSeq: z.number(),
});
export type AdminState = z.infer<typeof AdminState>;

export const AdminErrorCode = z.enum([
  "BAD_JSON",
  "ADMIN_AUTH_REQUIRED",
  "ORIGIN_REJECTED",
  "NOT_FOUND",
  "VERSION_CONFLICT",
  "IN_USE",
  "ENV_MANAGED",
  "AGENT_CONFIG_DRIFT",
  "VALIDATION_FAILED",
  "INTERNAL",
]);

export const AdminError = z.object({
  error: z.object({ code: AdminErrorCode, message: z.string(), path: z.string().optional() }),
});
export type AdminError = z.infer<typeof AdminError>;

export const UsageRow = z.object({
  key: z.string(),
  requests: z.number(),
  errors: z.number(),
  reroutes: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  p50Ms: z.number(),
  p95Ms: z.number(),
});
export type UsageRow = z.infer<typeof UsageRow>;
