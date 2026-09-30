// Gateway HTTP/SSE 客户端：带 Bearer 签名的 POST + 流式响应。
import { ProviderError, ERROR_CODES } from "../../core/errors.ts";
import { encode } from "./codec.ts";
import type { GatewayAuth, GatewayEndpoints } from "./auth.ts";

export class GatewayClient {
  auth: GatewayAuth;
  endpoints: GatewayEndpoints;
  fetch: typeof globalThis.fetch;
  requestTimeoutMs: number;

  constructor({
    auth,
    endpoints,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = 600000,
  }: {
    auth?: GatewayAuth;
    endpoints?: GatewayEndpoints;
    fetchImpl?: typeof globalThis.fetch;
    requestTimeoutMs?: number;
  } = {}) {
    // auth/endpoints 缺省即不可用（v0.1 不做兜底）。
    this.auth = auth!;
    this.endpoints = endpoints!;
    this.fetch = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async getJson(url: string, { signal }: { signal?: AbortSignal } = {}): Promise<unknown> {
    const session = await this.auth.ensureSession();
    const headers = this.auth.requestHeaders(session, { body: "", fullUrl: url });
    const response = await timedFetch(
      this.fetch,
      url,
      { method: "GET", headers, signal },
      this.requestTimeoutMs,
    );
    if (!response.ok) {
      throw await httpError(response, "gateway request failed");
    }
    return response.json();
  }

  // 打开聊天 SSE 流，产出原始 SSE 文本行（每行已去掉 \r\n，空行被跳过）。
  async *openStreamLines(
    url: string,
    jsonBody: unknown,
    { signal }: { signal?: AbortSignal } = {},
  ): AsyncGenerator<string> {
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
    // ok 响应的 body 为已建立的流（stdio 契约保证非空）。
    for await (const chunk of response.body!) {
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
  async *streamEvents(
    url: string,
    jsonBody: unknown,
    { signal }: { signal?: AbortSignal } = {},
  ): AsyncGenerator<string> {
    for await (const line of this.openStreamLines(url, jsonBody, { signal })) {
      if (!line.startsWith("data:")) continue;
      yield line;
    }
  }
}

async function timedFetch(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("gateway timeout")), timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (error) {
    if (init.signal?.aborted) {
      throw new ProviderError(
        ERROR_CODES.PROVIDER_ABORTED,
        "request aborted before gateway finished",
        {
          cause: error,
        },
      );
    }
    if (controller.signal.aborted) {
      throw new ProviderError(
        ERROR_CODES.PROVIDER_TIMEOUT,
        `gateway timeout after ${timeoutMs}ms`,
        {
          cause: error,
        },
      );
    }
    throw new ProviderError(ERROR_CODES.PROVIDER_UNAVAILABLE, errorText(error), {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function httpError(response: Response, label: string): Promise<ProviderError> {
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

// 宽松 JSON 记录：动态取值的统一读取形状（值保持 unknown，消费处自行窄化）。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// unknown error 的诊断字段读取：非对象时与原可选链一样得到 undefined。
function errorField(error: unknown, field: string): unknown {
  return isRecord(error) ? error[field] : undefined;
}

// 等价于原 `error?.message || String(error)`（v0.1 动态取值；message 字段实践为 string）。
function errorText(error: unknown): string {
  return (errorField(error, "message") || String(error)) as string;
}
