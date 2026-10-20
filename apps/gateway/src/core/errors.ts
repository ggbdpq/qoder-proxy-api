// Provider 错误的统一机器可读码。协议层依赖这些码做下游错误映射，
// Provider 内部禁止抛裸字符串错误。
export const ERROR_CODES = Object.freeze({
  PROVIDER_AUTH_ERROR: "PROVIDER_AUTH_ERROR",
  PROVIDER_RATE_LIMITED: "PROVIDER_RATE_LIMITED",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  PROVIDER_PROTOCOL_ERROR: "PROVIDER_PROTOCOL_ERROR",
  PROVIDER_ABORTED: "PROVIDER_ABORTED",
  // 上游 400 / 内容拒答：问题在请求本身，不改道、不歇息。
  PROVIDER_REJECTED: "PROVIDER_REJECTED",
  UNSUPPORTED_CAPABILITY: "UNSUPPORTED_CAPABILITY",
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
});

export type ProviderErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ProviderErrorOptions {
  cause?: unknown;
  status?: number;
  retryAfterMs?: number;
}

export class ProviderError extends Error {
  code: ProviderErrorCode;
  status: number | undefined;
  retryAfterMs: number | undefined;

  constructor(
    code: ProviderErrorCode,
    message: string,
    { cause, status, retryAfterMs }: ProviderErrorOptions = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    if (cause !== undefined) this.cause = cause;
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}
