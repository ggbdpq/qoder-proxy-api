// Gateway HTTP/SSE 客户端：带 Bearer 签名的 POST + 流式响应。
import { ProviderError, ERROR_CODES } from "../../core/errors.js";
import { decodeSseData, parseSseChunk } from "../../sse.js";
import { encode } from "./codec.js";

export class GatewayClient {
  constructor({ auth, endpoints, fetchImpl = globalThis.fetch, requestTimeoutMs = 600000 } = {}) {
    this.auth = auth;
    this.endpoints = endpoints;
    this.fetch = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async getJson(url, { signal } = {}) {
    const session = await this.auth.ensureSession();
    const headers = this.auth.requestHeaders(session, { body: "", fullUrl: url });
    const response = await timedFetch(this.fetch, url, { method: "GET", headers, signal }, this.requestTimeoutMs);
    if (!response.ok) {
      throw await httpError(response, "gateway request failed");
    }
    return response.json();
  }

  // 打开聊天 SSE 流，产出原始 SSE 文本行（每行已去掉 \r\n，空行被跳过）。
  async *openStreamLines(url, jsonBody, { signal } = {}) {
    const session = await this.auth.ensureSession();
    const body = encode(Buffer.from(JSON.stringify(jsonBody, undefined, 0), "utf8")).toString();
    const headers = this.auth.requestHeaders(session, {
      body,
      fullUrl: url,
      accept: "text/event-stream",
    });
    headers["cache-control"] = "no-cache";

    const response = await timedFetch(
      this.fetch,
      url,
      { method: "POST", headers, body, signal },
      this.requestTimeoutMs,
    );
    if (!response.ok) {
      throw await httpError(response, "gateway chat stream failed");
    }

    const decoder = new TextDecoder();
    let remainder = "";
    for await (const chunk of response.body) {
      const text = remainder + decoder.decode(chunk, { stream: true });
      const lines = text.split(/\r?\n/);
      remainder = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) yield line;
      }
    }
    if (remainder.trim()) yield remainder;
  }

  // SSE 行 → 解析后的 data JSON（保持 raw text 以便 normalize 消费）。
  async *streamEvents(url, jsonBody, { signal } = {}) {
    for await (const line of this.openStreamLines(url, jsonBody, { signal })) {
      if (!line.startsWith("data:")) continue;
      yield line;
    }
  }
}

async function timedFetch(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("gateway timeout")), timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (error) {
    if (init.signal?.aborted) {
      throw new ProviderError(ERROR_CODES.PROVIDER_ABORTED, "request aborted before gateway finished", {
        cause: error,
      });
    }
    if (controller.signal.aborted) {
      throw new ProviderError(ERROR_CODES.PROVIDER_TIMEOUT, `gateway timeout after ${timeoutMs}ms`, {
        cause: error,
      });
    }
    throw new ProviderError(ERROR_CODES.PROVIDER_UNAVAILABLE, error?.message || String(error), {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function httpError(response, label) {
  const detail = (await response.text().catch(() => "")).slice(0, 300);
  const code =
    response.status === 401 || response.status === 403
      ? ERROR_CODES.PROVIDER_AUTH_ERROR
      : response.status === 429
        ? ERROR_CODES.PROVIDER_RATE_LIMITED
        : ERROR_CODES.PROVIDER_UNAVAILABLE;
  return new ProviderError(code, `${label}: HTTP ${response.status} ${detail}`, {
    status: response.status,
  });
}
