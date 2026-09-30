// 进站侧共享 HTTP 工具。
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { AggregateResult } from "../core/aggregate.ts";
import type { ProviderEvent } from "../core/events.ts";
import type { CanonicalRequest } from "../core/request.ts";

// 进站 JSON body 的最小 wire 形状：字段按各端点实际读取声明，
// 动态载荷（messages/tools/content）以 unknown 进入，由各适配器窄化。
export interface IncomingBody {
  stream?: unknown;
  model?: unknown;
  messages?: Array<Record<string, unknown>>;
  input?: unknown;
  system?: unknown;
  instructions?: unknown;
  tools?: unknown;
  max_tokens?: unknown;
  max_output_tokens?: unknown;
  temperature?: unknown;
  metadata?: Record<string, unknown>;
  title?: unknown;
  // 会话 key 提取（server.ts getSessionKey）
  conversation?: unknown;
  conversation_id?: unknown;
  user?: unknown;
}

// 协议适配器拿到的唯一出站接口：聚合（非流式）或事件流（流式）。
export interface ProtocolRun {
  aggregate(request: CanonicalRequest): Promise<AggregateResult>;
  stream(request: CanonicalRequest): AsyncIterable<ProviderEvent>;
}

export interface ProtocolHandlerArgs {
  req: IncomingMessage;
  res: ServerResponse;
  body: IncomingBody;
  model: string;
  run: ProtocolRun;
}

export class HttpError extends Error {
  status: number;
  details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

export async function readJsonBody(
  req: IncomingMessage,
  maxBytes = 2 * 1024 * 1024,
): Promise<IncomingBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new HttpError(413, "request body too large");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new HttpError(400, "invalid JSON body", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: OutgoingHttpHeaders = {},
) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export function writeOpenAIError(
  res: ServerResponse,
  status: number,
  message: string,
  type: string = "invalid_request_error",
  details: unknown = undefined,
) {
  writeJson(res, status, {
    error: {
      message,
      type,
      param: null,
      code: null,
      details,
    },
  });
}

export function requireBearer(req: IncomingMessage, expectedKey: string): void {
  if (!expectedKey) return;
  const auth = req.headers.authorization || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (token !== expectedKey) {
    throw new HttpError(401, "invalid or missing bearer token");
  }
}

export function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url || "/", "http://127.0.0.1");
}

export function setCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,content-type,x-qoder-session-id");
}

// 各协议 wire id 的统一生成规则：前缀 + base36 时间 + 随机尾巴（v0.1 语义）。
export function wireId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
