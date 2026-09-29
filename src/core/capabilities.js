import { ERROR_CODES, ProviderError } from "./errors.js";

// Provider 能力声明。能力协商的唯一事实来源：
// 遇到不支持的能力必须显式报错，禁止静默丢弃 tools / thinking / image 输入。

/**
 * @typedef {"native" | "emulated" | "none"} Support3
 * @typedef {"native" | "text" | "none"} ThinkingSupport
 * @typedef {"native" | "attachment" | "none"} VisionSupport
 * @typedef {"dynamic" | "configured" | "static"} ModelDiscovery
 * @typedef {"native" | "estimated" | "none"} UsageSupport
 *
 * @typedef {object} ProviderCapabilities
 * @property {boolean} streaming
 * @property {boolean} cancellation
 * @property {Support3} sessions
 * @property {Support3} tools
 * @property {ThinkingSupport} thinking
 * @property {VisionSupport} vision
 * @property {ModelDiscovery} modelDiscovery
 * @property {UsageSupport} usage
 * @property {"native" | "none"} resume
 */

export const CAPABILITY_KEYS = new Set([
  "streaming",
  "cancellation",
  "sessions",
  "tools",
  "thinking",
  "vision",
  "modelDiscovery",
  "usage",
  "resume",
]);

/** @returns {ProviderCapabilities} */
export function defaultCapabilities() {
  return {
    streaming: false,
    cancellation: false,
    sessions: "none",
    tools: "none",
    thinking: "none",
    vision: "none",
    modelDiscovery: "static",
    usage: "none",
    resume: "none",
  };
}

// 拒绝路径只看 provider 显式声明，不做任何隐式降级。
export function assertCapability(capabilities, request) {
  if (request.tools?.length && capabilities.tools === "none") {
    throw new ProviderError(
      ERROR_CODES.UNSUPPORTED_CAPABILITY,
      "provider does not support tools; drop the tools field or switch provider",
    );
  }
  if (request.reasoningEffort && capabilities.thinking === "none") {
    throw new ProviderError(
      ERROR_CODES.UNSUPPORTED_CAPABILITY,
      "provider does not support thinking; drop reasoningEffort or switch provider",
    );
  }
  if (hasImagePart(request.messages) && capabilities.vision === "none") {
    throw new ProviderError(
      ERROR_CODES.UNSUPPORTED_CAPABILITY,
      "provider does not support vision; remove image content or switch provider",
    );
  }
}

function hasImagePart(messages) {
  for (const message of messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    if (message.content.some((part) => part?.type === "image")) return true;
  }
  return false;
}
