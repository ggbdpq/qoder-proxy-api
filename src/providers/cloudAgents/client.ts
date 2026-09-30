// Qoder Cloud Agents HTTP/SSE 客户端与 SessionStore，自 src/qoder-client.js 机械迁入。
// 行为保持 v0.1 不变；超时语义与调用方 signal 通过 AbortSignal.any 组合。
import { ERROR_CODES, ProviderError } from "../../core/errors.ts";
import { decodeSseData, parseSseChunk } from "../../sse.ts";
import type { CloudModelSpec } from "./config.ts";
import {
  extractQoderError,
  extractTextDelta,
  isQoderIdleEvent,
  isQoderRunningEvent,
  isRecord,
} from "./normalize.ts";
import type { JsonRecord } from "./normalize.ts";

// streamEvents 产出的流事件：sse.ts 原始信封字段 + 解码后的 json（可为任意 JSON 值）。
interface CloudStreamEvent {
  id: string;
  event: string;
  data: string;
  json?: unknown;
}

// 私有 HTTP 选项：body 为任意 JSON 值（调用方已按 v0.1 形状构造）。
interface CloudRequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export class CloudAgentsClient {
  baseUrl: string;
  accessToken: string;
  fetch: typeof globalThis.fetch;
  requestTimeoutMs: number;

  constructor({
    baseUrl,
    accessToken,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = 600000,
  }: {
    baseUrl?: string;
    accessToken?: string;
    fetchImpl?: typeof globalThis.fetch;
    requestTimeoutMs?: number;
  } = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.accessToken = accessToken || "";
    this.fetch = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  assertReady(): void {
    if (!this.baseUrl) throw new Error("QODER_API_BASE_URL is empty");
    if (!this.accessToken) throw new Error("QODER_ACCESS_TOKEN is empty");
    if (typeof this.fetch !== "function")
      throw new Error("fetch is not available in this Node runtime");
  }

  async createSession(
    modelSpec: CloudModelSpec,
    // title/metadata 为透传 JSON 字段（v0.1 原语义：真值链拼接，不校验类型）。
    { title, metadata }: { title?: unknown; metadata?: Record<string, unknown> } = {},
  ): Promise<string | undefined> {
    this.assertReady();
    if (!modelSpec?.agentId)
      throw new Error(`model ${modelSpec?.modelId || ""} is missing agentId`);
    if (!modelSpec?.environmentId)
      throw new Error(`model ${modelSpec?.modelId || ""} is missing environmentId`);

    const agent: { id: string; type: string; version?: number } = {
      id: modelSpec.agentId,
      type: "agent",
    };
    if (
      modelSpec.agentVersion !== undefined &&
      modelSpec.agentVersion !== null &&
      modelSpec.agentVersion !== ""
    ) {
      agent.version = Number(modelSpec.agentVersion);
    }

    const body = {
      agent,
      environment_id: modelSpec.environmentId,
      title: title || modelSpec.title || `Qoder proxy: ${modelSpec.modelId}`,
      metadata: {
        via: "qoder-proxy-api",
        model: modelSpec.modelId,
        ...modelSpec.metadata,
        ...metadata,
      },
    };

    const json = await this.requestJson("/sessions", { method: "POST", body });
    // v0.1 信封兼容：{id} / {data:{id}} / {session:{id}} 取首个真值（实践为 string）。
    const direct = json?.id;
    const nested = isRecord(json?.data) ? json.data.id : undefined;
    const session = isRecord(json?.session) ? json.session.id : undefined;
    return (direct || nested || session) as string | undefined;
  }

  async sendUserMessage(sessionId: string, text: string): Promise<Record<string, unknown>> {
    this.assertReady();
    const content = [{ type: "text", text: text || " " }];
    return this.requestJson(`/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: "POST",
      body: { events: [{ type: "user.message", content }] },
    });
  }

  async archiveSession(sessionId: string): Promise<void> {
    if (!sessionId) return;
    try {
      await this.requestJson(`/sessions/${encodeURIComponent(sessionId)}/archive`, {
        method: "POST",
      });
    } catch {
      // Archival is best-effort for ephemeral compatibility calls.
    }
  }

  async latestEventId(sessionId: string): Promise<string> {
    try {
      const json = await this.requestJson(
        `/sessions/${encodeURIComponent(sessionId)}/events?limit=1&order=desc`,
        { method: "GET" },
      );
      const data = json?.data;
      const events: JsonRecord[] = Array.isArray(data) ? data : [];
      // v0.1 原语义：取首个事件的真值 id（实践为 string）。
      return (events[0]?.id || "") as string;
    } catch {
      return "";
    }
  }

  async runTurn({
    sessionId,
    prompt,
    onDelta,
    signal,
  }: {
    sessionId: string;
    prompt: string;
    onDelta?: (delta: string, event: CloudStreamEvent) => void;
    signal?: AbortSignal;
  }): Promise<string> {
    this.assertReady();
    const lastEventId = await this.latestEventId(sessionId);
    await this.sendUserMessage(sessionId, prompt);

    let output = "";
    let started = false;
    const extractionState = { fullTextsSeen: new Set<string>() };

    for await (const event of this.streamEvents(sessionId, signal, lastEventId)) {
      const qoderError = extractQoderError(event);
      if (qoderError) throw new Error(qoderError);

      if (isQoderRunningEvent(event)) {
        started = true;
        continue;
      }

      const delta = extractTextDelta(event, extractionState);
      if (delta && (started || String(event.event || "").includes("agent.message"))) {
        started = true;
        output += delta;
        if (onDelta) onDelta(delta, event);
      }

      if (started && isQoderIdleEvent(event)) {
        return output;
      }
    }

    return output;
  }

  async *streamEvents(
    sessionId: string,
    signal: AbortSignal | undefined,
    lastEventId = "",
  ): AsyncGenerator<CloudStreamEvent> {
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (lastEventId) headers["last-event-id"] = lastEventId;
    const response = await this.request(
      `/sessions/${encodeURIComponent(sessionId)}/events/stream`,
      {
        method: "GET",
        headers,
        signal,
      },
    );

    const decoder = new TextDecoder();
    let remainder = "";
    for await (const chunk of response.body!) {
      const { events, remainder: nextRemainder } = parseSseChunk(
        remainder,
        decoder.decode(chunk, { stream: true }),
      );
      remainder = nextRemainder;
      for (const rawEvent of events) {
        const json = decodeSseData(rawEvent.data);
        yield { ...rawEvent, json };
      }
    }

    if (remainder.trim()) {
      const { events } = parseSseChunk("", `${remainder}\n\n`);
      for (const rawEvent of events) {
        const json = decodeSseData(rawEvent.data);
        yield { ...rawEvent, json };
      }
    }
  }

  async requestJson(
    path: string,
    { method = "GET", body, headers = {}, signal }: CloudRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.request(path, { method, body, headers, signal });
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Qoder returned non-JSON response: ${text.slice(0, 300)}`);
    }
  }

  async request(
    path: string,
    { method = "GET", body, headers = {}, signal }: CloudRequestOptions = {},
  ): Promise<Response> {
    this.assertReady();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const url = `${this.baseUrl}${path}`;
    const requestHeaders: Record<string, string> = {
      authorization: `Bearer ${this.accessToken}`,
      ...headers,
    };
    const init: RequestInit = {
      method,
      headers: requestHeaders,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    };
    if (body !== undefined) {
      requestHeaders["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetch(url, init);
    } catch (error) {
      // 超时 abort 与客户端 abort 分流：前者是 PROVIDER_TIMEOUT，不是不可用。
      if (controller.signal.aborted && !signal?.aborted) {
        throw new ProviderError(
          ERROR_CODES.PROVIDER_TIMEOUT,
          `Qoder request timeout after ${this.requestTimeoutMs}ms`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      let details = "";
      try {
        details = await response.text();
      } catch {
        details = response.statusText || "";
      }
      throw new Error(`Qoder HTTP ${response.status}: ${details.slice(0, 500)}`);
    }
    return response;
  }
}

interface StoredSession {
  sessionId: string;
  updatedAt: number;
}

export class SessionStore {
  ttlMs: number;
  sessions: Map<string, StoredSession>;

  constructor({ ttlMs = 2 * 60 * 60 * 1000 }: { ttlMs?: number } = {}) {
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  get(key: string): string | null {
    if (!key) return null;
    const entry = this.sessions.get(key);
    if (!entry) return null;
    if (Date.now() - entry.updatedAt > this.ttlMs) {
      this.sessions.delete(key);
      return null;
    }
    entry.updatedAt = Date.now();
    return entry.sessionId;
  }

  set(key: string, sessionId: string): void {
    if (!key || !sessionId) return;
    this.sessions.set(key, { sessionId, updatedAt: Date.now() });
  }

  delete(key: string): void {
    this.sessions.delete(key);
  }
}
