// Provider 错误的统一机器可读码。协议层依赖这些码做下游错误映射，
// Provider 内部禁止抛裸字符串错误。
export const ERROR_CODES = Object.freeze({
  PROVIDER_AUTH_ERROR: "PROVIDER_AUTH_ERROR",
  PROVIDER_RATE_LIMITED: "PROVIDER_RATE_LIMITED",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  PROVIDER_PROTOCOL_ERROR: "PROVIDER_PROTOCOL_ERROR",
  PROVIDER_ABORTED: "PROVIDER_ABORTED",
  UNSUPPORTED_CAPABILITY: "UNSUPPORTED_CAPABILITY",
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
});

export class ProviderError extends Error {
  constructor(code, message, { cause, status } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
    if (cause !== undefined) this.cause = cause;
  }
}

export function isProviderError(error) {
  return error instanceof ProviderError;
}
