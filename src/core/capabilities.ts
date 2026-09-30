import { ERROR_CODES, ProviderError } from "./errors.ts";
import type { CanonicalRequest, CanonicalMessage } from "./request.ts";

// Provider 能力声明。能力协商的唯一事实来源：
// 遇到不支持的能力必须显式报错，禁止静默丢弃 tools / thinking / image 输入。

export type Support3 = "native" | "emulated" | "none";
export type ThinkingSupport = "native" | "text" | "none";
export type VisionSupport = "native" | "attachment" | "none";
export type ModelDiscovery = "dynamic" | "configured" | "static";
export type UsageSupport = "native" | "estimated" | "none";

export interface ProviderCapabilities {
  streaming: boolean;
  cancellation: boolean;
  sessions: Support3;
  tools: Support3;
  thinking: ThinkingSupport;
  vision: VisionSupport;
  modelDiscovery: ModelDiscovery;
  usage: UsageSupport;
  resume: "native" | "none";
}

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

export function defaultCapabilities(): ProviderCapabilities {
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
export function assertCapability(
  capabilities: ProviderCapabilities,
  request: CanonicalRequest,
): void {
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

function hasImagePart(messages?: CanonicalMessage[]): boolean {
  for (const message of messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    if (message.content.some((part) => part?.type === "image")) return true;
  }
  return false;
}
