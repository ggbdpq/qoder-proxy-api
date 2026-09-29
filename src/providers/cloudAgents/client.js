// Qoder Cloud Agents HTTP/SSE 客户端与 SessionStore，自 src/qoder-client.js 机械迁入。
// 行为保持 v0.1 不变；超时语义与调用方 signal 通过 AbortSignal.any 组合。
import { decodeSseData, parseSseChunk } from "../../sse.js";
import {
  extractQoderError,
  extractTextDelta,
  isQoderIdleEvent,
  isQoderRunningEvent,
} from "./normalize.js";

export class CloudAgentsClient {
  constructor({ baseUrl, accessToken, fetchImpl = globalThis.fetch, requestTimeoutMs = 600000 }) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.accessToken = accessToken || "";
    this.fetch = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  assertReady() {
    if (!this.baseUrl) throw new Error("QODER_API_BASE_URL is empty");
    if (!this.accessToken) throw new Error("QODER_ACCESS_TOKEN is empty");
    if (typeof this.fetch !== "function")
      throw new Error("fetch is not available in this Node runtime");
  }

  async createSession(modelSpec, { title, metadata } = {}) {
    this.assertReady();
    if (!modelSpec?.agentId)
      throw new Error(`model ${modelSpec?.modelId || ""} is missing agentId`);
    if (!modelSpec?.environmentId)
      throw new Error(`model ${modelSpec?.modelId || ""} is missing environmentId`);

    const agent = { id: modelSpec.agentId, type: "agent" };
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
        ...(modelSpec.metadata || {}),
        ...(metadata || {}),
      },
    };

    const json = await this.requestJson("/sessions", { method: "POST", body });
    return json?.id || json?.data?.id || json?.session?.id;
  }

  async sendUserMessage(sessionId, text) {
    this.assertReady();
    const content = [{ type: "text", text: text || " " }];
    return this.requestJson(`/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: "POST",
      body: { events: [{ type: "user.message", content }] },
    });
  }

  async archiveSession(sessionId) {
    if (!sessionId) return;
    try {
      await this.requestJson(`/sessions/${encodeURIComponent(sessionId)}/archive`, {
        method: "POST",
      });
    } catch {
      // Archival is best-effort for ephemeral compatibility calls.
    }
  }

  async latestEventId(sessionId) {
    try {
      const json = await this.requestJson(
        `/sessions/${encodeURIComponent(sessionId)}/events?limit=1&order=desc`,
        { method: "GET" },
      );
      const events = Array.isArray(json?.data) ? json.data : [];
      return events[0]?.id || "";
    } catch {
      return "";
    }
  }

  async runTurn({ sessionId, prompt, onDelta, signal }) {
    this.assertReady();
    const lastEventId = await this.latestEventId(sessionId);
    await this.sendUserMessage(sessionId, prompt);

    let output = "";
    let started = false;
    const extractionState = { fullTextsSeen: new Set() };

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

  async *streamEvents(sessionId, signal, lastEventId = "") {
    const headers = { accept: "text/event-stream" };
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
    for await (const chunk of response.body) {
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

  async requestJson(path, { method = "GET", body, headers = {}, signal } = {}) {
    const response = await this.request(path, { method, body, headers, signal });
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Qoder returned non-JSON response: ${text.slice(0, 300)}`);
    }
  }

  async request(path, { method = "GET", body, headers = {}, signal } = {}) {
    this.assertReady();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const url = `${this.baseUrl}${path}`;
    const init = {
      method,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        ...headers,
      },
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await this.fetch(url, init);
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

export class SessionStore {
  constructor({ ttlMs = 2 * 60 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  get(key) {
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

  set(key, sessionId) {
    if (!key || !sessionId) return;
    this.sessions.set(key, { sessionId, updatedAt: Date.now() });
  }

  delete(key) {
    this.sessions.delete(key);
  }
}
