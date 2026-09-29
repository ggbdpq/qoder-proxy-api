// Canonical Request 与 ProviderContext：下游协议 → Provider 的统一请求语言。
// workspace / session / cwd / request id 等运行上下文一律走 ProviderContext，
// 不允许污染消息正文，也不允许 Provider 私有概念泄漏进协议层。

/**
 * @typedef {object} TextPart
 * @property {"text"} type
 * @property {string} text
 *
 * @typedef {object} ImagePart
 * @property {"image"} type
 * @property {object} source
 *
 * @typedef {TextPart | ImagePart} CanonicalContentPart
 *
 * @typedef {object} CanonicalMessage
 * @property {"user" | "assistant" | "tool"} role
 * @property {string | CanonicalContentPart[]} content
 * @property {string} [toolCallId]
 * @property {Array<{ id: string, name: string, arguments: string }>} [toolCalls]
 *
 * @typedef {object} CanonicalTool
 * @property {string} name
 * @property {string} [description]
 * @property {object} inputSchema
 *
 * @typedef {object} CanonicalRequest
 * @property {string} model
 * @property {string | CanonicalContentPart[]} [system]
 * @property {CanonicalMessage[]} messages
 * @property {CanonicalTool[]} [tools]
 * @property {"auto" | "none" | { name: string }} [toolChoice]
 * @property {number} [maxTokens]
 * @property {number} [temperature]
 * @property {"low" | "medium" | "high" | "max"} [reasoningEffort]
 * @property {Record<string, unknown>} [metadata]
 *
 * @typedef {object} ProviderContext
 * @property {string} requestId
 * @property {string} [conversationId]
 * @property {string} [cwd]
 * @property {AbortSignal} signal
 */

/** @returns {ProviderContext} */
export function createProviderContext({ requestId, conversationId, cwd, signal } = {}) {
  return {
    requestId: requestId || `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    conversationId,
    cwd,
    signal: signal ?? new AbortController().signal,
  };
}
