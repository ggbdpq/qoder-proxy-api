// CloudAgentsProvider：Qoder Cloud Agents 的出站适配器。
// 上游 SSE 在本 Provider 内归一为 Canonical Event；协议层不感知 Cloud 私有语义。
import { ERROR_CODES, ProviderError } from "../../core/errors.ts";
import { assertCapability } from "../../core/capabilities.ts";
import type { ProviderCapabilities } from "../../core/capabilities.ts";
import type { CanonicalRequest, ProviderContext } from "../../core/request.ts";
import type { ProviderEvent } from "../../core/events.ts";
import type { ProviderModel } from "../../core/provider.ts";
import type { CloudAgentsClient, SessionStore } from "./client.ts";
import type { CloudModelSpec } from "./config.ts";
import {
  canonicalToPrompt,
  extractQoderError,
  extractTextDelta,
  isQoderIdleEvent,
  isQoderRunningEvent,
} from "./normalize.ts";

export class CloudAgentsProvider {
  id = "cloudAgents";

  client: CloudAgentsClient;
  sessions: SessionStore;
  modelMap: Record<string, CloudModelSpec>;
  archiveEphemeralSessions: boolean;

  constructor({
    client,
    sessionStore,
    modelMap,
    archiveEphemeralSessions = true,
  }: {
    client?: CloudAgentsClient;
    sessionStore?: SessionStore;
    modelMap?: Record<string, CloudModelSpec>;
    archiveEphemeralSessions?: boolean;
  } = {}) {
    // client/sessionStore 缺省即不可用（v0.1 不做兜底）。
    this.client = client!;
    this.sessions = sessionStore!;
    this.modelMap = modelMap || {};
    this.archiveEphemeralSessions = archiveEphemeralSessions;
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      cancellation: true,
      sessions: "native",
      tools: "none",
      thinking: "none",
      vision: "none",
      modelDiscovery: "configured",
      usage: "none",
      resume: "none",
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    return Object.values(this.modelMap).map((spec) => ({ id: spec.modelId, label: spec.title }));
  }

  async *stream(
    request: CanonicalRequest,
    context: ProviderContext,
  ): AsyncGenerator<ProviderEvent> {
    const alias =
      !request.model || request.model === "default" ? Object.keys(this.modelMap)[0] : request.model;
    const spec = this.modelMap[alias!];
    if (!spec) {
      throw new ProviderError(ERROR_CODES.MODEL_NOT_FOUND, `unknown model: ${alias}`);
    }
    assertCapability(this.capabilities(), request);

    const prompt = canonicalToPrompt(request);
    const sessionKey = context.conversationId || "";
    let sessionId = this.sessions.get(sessionKey);
    let ephemeral = false;
    if (!sessionId) {
      sessionId = await this.createSessionGuarded(spec, request, sessionKey);
      if (sessionKey) this.sessions.set(sessionKey, sessionId);
      else ephemeral = true;
    }

    try {
      yield { type: "message.start" };
      yield* this.consumeTurn(sessionId, prompt, context.signal);
    } finally {
      if (ephemeral && this.archiveEphemeralSessions) {
        await this.client.archiveSession(sessionId);
      }
    }
  }

  async createSessionGuarded(
    spec: CloudModelSpec,
    request: CanonicalRequest,
    sessionKey: string,
  ): Promise<string> {
    try {
      const sessionId = await this.client.createSession(spec, {
        title: request.metadata?.title,
        metadata: { downstream: "compatible-api", session_key: sessionKey || undefined },
      });
      if (!sessionId) {
        throw new ProviderError(
          ERROR_CODES.PROVIDER_PROTOCOL_ERROR,
          "Qoder did not return a session id",
        );
      }
      return sessionId;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      // 等价于原 `error.message` 透传（message 字段实践为 string）。
      throw new ProviderError(
        ERROR_CODES.PROVIDER_UNAVAILABLE,
        errorField(error, "message") as string,
        {
          cause: error,
        },
      );
    }
  }

  // 事件循环语义与 v0.1 runTurn 一致：running 门控、全文去重、idle 结束、无 idle 也结束。
  async *consumeTurn(
    sessionId: string,
    prompt: string,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    let started = false;
    const extractionState = { fullTextsSeen: new Set<string>() };
    try {
      const lastEventId = await this.client.latestEventId(sessionId);
      await this.client.sendUserMessage(sessionId, prompt);

      for await (const event of this.client.streamEvents(sessionId, signal, lastEventId)) {
        const qoderError = extractQoderError(event);
        if (qoderError) {
          yield {
            type: "error",
            error: new ProviderError(ERROR_CODES.PROVIDER_PROTOCOL_ERROR, qoderError),
          };
          return;
        }

        if (isQoderRunningEvent(event)) {
          started = true;
          continue;
        }

        const delta = extractTextDelta(event, extractionState);
        if (delta && (started || String(event.event || "").includes("agent.message"))) {
          started = true;
          yield { type: "text.delta", text: delta };
        }

        if (started && isQoderIdleEvent(event)) break;
      }

      yield { type: "message.end", stopReason: "stop" };
    } catch (error) {
      yield { type: "error", error: toProviderError(error, signal) };
    }
  }
}

function toProviderError(error: unknown, signal: AbortSignal | undefined): ProviderError {
  if (error instanceof ProviderError) return error;
  if (signal?.aborted || errorField(error, "name") === "AbortError") {
    return new ProviderError(
      ERROR_CODES.PROVIDER_ABORTED,
      "request aborted before upstream finished",
    );
  }
  return new ProviderError(ERROR_CODES.PROVIDER_UNAVAILABLE, errorText(error), {
    cause: error,
  });
}

// 等价于原 `error?.message || String(error)`（v0.1 动态取值；message 字段实践为 string）。
function errorText(error: unknown): string {
  return (errorField(error, "message") || String(error)) as string;
}

// 宽松 JSON 记录：动态取值的统一读取形状（值保持 unknown，消费处自行窄化）。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// unknown error 的诊断字段读取：非对象时与原可选链一样得到 undefined。
function errorField(error: unknown, field: string): unknown {
  return isRecord(error) ? error[field] : undefined;
}
