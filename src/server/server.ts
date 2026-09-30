// 进站路由与胶水层：只做协议分发、会话 key 提取、错误映射。
// 不出现任何 Qoder 上游协议细节；模型解析的默认别名规则保留 v0.1 语义。
import http from "node:http";
import type { IncomingMessage } from "node:http";
import { aggregateStream } from "../core/aggregate.ts";
import { ERROR_CODES, ProviderError } from "../core/errors.ts";
import { createProviderContext } from "../core/request.ts";
import type { CanonicalRequest } from "../core/request.ts";
import type { QoderProvider } from "../core/provider.ts";
import { CloudAgentsClient, SessionStore } from "../providers/cloudAgents/client.ts";
import { CloudAgentsProvider } from "../providers/cloudAgents/index.ts";
import { createProviderRegistry } from "../routing/providerRegistry.ts";
import type { ProviderRegistry } from "../routing/providerRegistry.ts";
import { parseModelRoutes, resolveModel } from "../routing/modelRouter.ts";
import type { ModelRoutes } from "../routing/modelRouter.ts";
import { handleChatCompletions } from "../protocols/openai/chat.ts";
import { handleResponses } from "../protocols/openai/responses.ts";
import { handleAnthropicMessages } from "../protocols/anthropic/messages.ts";
import { loadConfig, publicConfig } from "../config.ts";
import type { AppConfig } from "../config.ts";
import {
  HttpError,
  parseUrl,
  readJsonBody,
  requireBearer,
  setCors,
  wireId,
  writeJson,
  writeOpenAIError,
} from "./http.ts";
import type { IncomingBody, ProtocolHandlerArgs, ProtocolRun } from "./http.ts";

export interface ServerDeps {
  qoderClient?: CloudAgentsClient;
  sessionStore?: SessionStore;
  cloudAgentsProvider?: CloudAgentsProvider;
  providerRegistry?: ProviderRegistry;
  modelRoutes?: ModelRoutes;
  defaultProviderId?: string;
}

export function createServer(config: AppConfig = loadConfig(), deps: ServerDeps = {}) {
  const client =
    deps.qoderClient ||
    new CloudAgentsClient({
      baseUrl: config.qoderApiBaseUrl,
      accessToken: config.qoderAccessToken,
      requestTimeoutMs: config.requestTimeoutMs,
    });
  const sessions = deps.sessionStore || new SessionStore({ ttlMs: config.sessionTtlMs });
  // Provider 类的 id 字段被声明为拓宽的 string；运行时即注册 id 本身，
  // 在组装点按 QoderProvider 契约收窄（纯编译期，无行为变化）。
  const cloudAgents = (deps.cloudAgentsProvider ||
    new CloudAgentsProvider({
      client,
      sessionStore: sessions,
      modelMap: config.modelMap,
      archiveEphemeralSessions: config.archiveEphemeralSessions,
    })) as unknown as QoderProvider;

  const registry = deps.providerRegistry || createProviderRegistry();
  if (!deps.providerRegistry) registry.register(cloudAgents);
  const modelRoutes = deps.modelRoutes || parseModelRoutes(config);
  // 显式路由未命中的模型名直通默认 provider（路由策略，非故障 fallback）。
  const defaultProviderId = deps.defaultProviderId || registry.ids()[0];

  return http.createServer(async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // 客户端提前断开时中止上游，避免子连接与流继续消耗。
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      const url = parseUrl(req);
      if (req.method === "GET" && url.pathname === "/health") {
        writeJson(res, 200, { ok: true, config: publicConfig(config) });
        return;
      }

      if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
        requireBearer(req, config.proxyApiKey);
        writeJson(res, 200, await collectModels(registry));
        return;
      }

      const route = resolveRoute(req.method, url.pathname);
      if (route) {
        requireBearer(req, config.proxyApiKey);
        const body = await readJsonBody(req);
        // model 解析：显式路由优先，否则直通默认 provider 裁决。
        // 空/缺省 model 统一以 "default" 传递，由目标 Provider 决定默认模型。
        const requested = String(body.model || "").trim() || "default";
        const resolved = await resolveModel(registry, modelRoutes, requested, {
          defaultProviderId,
        });
        const run = createRunner(resolved.provider, {
          conversationId: getSessionKey(req, body),
          signal: controller.signal,
        });
        // 显式路由命中时用路由后的目标 model；直通时 resolved.route.model 即原别名。
        await route.handle({ req, res, body, model: resolved.route.model, run });
        return;
      }

      writeOpenAIError(
        res,
        404,
        `route not found: ${req.method} ${url.pathname}`,
        "not_found_error",
      );
    } catch (error) {
      const mapped = mapError(error);
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) {
        // 流已开始：结构化错误已无法送达，截断连接让客户端看到不完整流。
        res.end();
        return;
      }
      const message = error instanceof Error ? error.message : "";
      writeOpenAIError(
        res,
        mapped.status,
        message || "internal server error",
        mapped.type,
        error instanceof HttpError ? error.details : undefined,
      );
    }
  });
}

interface RouteEntry {
  method: string;
  path: string;
  handle: (args: ProtocolHandlerArgs) => Promise<void>;
}

const ROUTES: RouteEntry[] = [
  { method: "POST", path: "/v1/chat/completions", handle: handleChatCompletions },
  { method: "POST", path: "/v1/responses", handle: handleResponses },
  { method: "POST", path: "/v1/messages", handle: handleAnthropicMessages },
];

// /v1/models 来自统一 Model Registry：聚合全部 provider 的 listModels。
// owned_by 固定品牌名，不暴露 provider 拓扑。
async function collectModels(registry: ProviderRegistry) {
  const created = Math.floor(Date.now() / 1000);
  const data: Array<{ id: string; object: string; created: number; owned_by: string }> = [];
  for (const id of registry.ids()) {
    // id 来自 registry.keys()，对应条目必然存在。
    const models = await registry
      .get(id)!
      .listModels()
      .catch(() => []);
    for (const model of models) {
      data.push({ id: model.id, object: "model", created, owned_by: "qoder-proxy-api" });
    }
  }
  return { object: "list", data };
}

function resolveRoute(method: string | undefined, pathname: string): RouteEntry | undefined {
  return ROUTES.find((route) => route.method === method && route.path === pathname);
}

// 协议适配器拿到的唯一出站接口：聚合（非流式）或事件流（流式）。
function createRunner(
  provider: QoderProvider,
  { conversationId, signal }: { conversationId?: string; signal: AbortSignal },
): ProtocolRun {
  const context = createProviderContext({
    requestId: wireId("req"),
    conversationId: conversationId || undefined,
    signal,
  });
  return {
    aggregate(request: CanonicalRequest) {
      return aggregateStream(provider.stream(request, context));
    },
    stream(request: CanonicalRequest) {
      return provider.stream(request, context);
    },
  };
}

// ProviderError → 下游 HTTP 语义。上游失败保持 500（v0.1 行为）；
// 模型与能力问题属于请求方错误，映射 400。
function mapError(error: unknown): { status: number; type: string } {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      type: error.status >= 500 ? "server_error" : "invalid_request_error",
    };
  }
  if (
    error instanceof ProviderError &&
    (error.code === ERROR_CODES.MODEL_NOT_FOUND ||
      error.code === ERROR_CODES.UNSUPPORTED_CAPABILITY)
  ) {
    return { status: 400, type: "invalid_request_error" };
  }
  return { status: 500, type: "server_error" };
}

function getSessionKey(req: IncomingMessage, body: IncomingBody): string {
  const header = req.headers["x-qoder-session-id"];
  if (header) return String(header).trim();
  return String(
    body?.metadata?.qoder_session_id ||
      body?.metadata?.session_id ||
      body?.conversation ||
      body?.conversation_id ||
      body?.user ||
      "",
  ).trim();
}
