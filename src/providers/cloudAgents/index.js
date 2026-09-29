// CloudAgentsProvider：Qoder Cloud Agents 的出站适配器。
// 上游 SSE 在本 Provider 内归一为 Canonical Event；协议层不感知 Cloud 私有语义。
import { ERROR_CODES, ProviderError } from "../../core/errors.js";
import { assertCapability } from "../../core/capabilities.js";
import {
  canonicalToPrompt,
  extractQoderError,
  extractTextDelta,
  isQoderIdleEvent,
  isQoderRunningEvent,
} from "./normalize.js";

export class CloudAgentsProvider {
  id = "cloudAgents";

  constructor({ client, sessionStore, modelMap, archiveEphemeralSessions = true } = {}) {
    this.client = client;
    this.sessions = sessionStore;
    this.modelMap = modelMap || {};
    this.archiveEphemeralSessions = archiveEphemeralSessions;
  }

  capabilities() {
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

  async listModels() {
    return Object.values(this.modelMap).map((spec) => ({ id: spec.modelId, label: spec.title }));
  }

  async *stream(request, context) {
    const alias =
      !request.model || request.model === "default"
        ? Object.keys(this.modelMap)[0]
        : request.model;
    const spec = this.modelMap[alias];
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

  async createSessionGuarded(spec, request, sessionKey) {
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
      throw new ProviderError(ERROR_CODES.PROVIDER_UNAVAILABLE, error.message, { cause: error });
    }
  }

  // 事件循环语义与 v0.1 runTurn 一致：running 门控、全文去重、idle 结束、无 idle 也结束。
  async *consumeTurn(sessionId, prompt, signal) {
    let started = false;
    const extractionState = { fullTextsSeen: new Set() };
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

function toProviderError(error, signal) {
  if (error instanceof ProviderError) return error;
  if (signal?.aborted || error?.name === "AbortError") {
    return new ProviderError(ERROR_CODES.PROVIDER_ABORTED, "request aborted before upstream finished");
  }
  return new ProviderError(ERROR_CODES.PROVIDER_UNAVAILABLE, error?.message || String(error), {
    cause: error,
  });
}
