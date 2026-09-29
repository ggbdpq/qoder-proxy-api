// Provider Contract：路由层唯一认识的出站适配器接口。
// 保持极小：id / capabilities / listModels / stream / dispose。
// 非流式由 core/aggregate.js 统一聚合 stream() 实现，Provider 不再写第二套执行路径。

import { CAPABILITY_KEYS, defaultCapabilities } from "./capabilities.js";

/**
 * @typedef {import("./request.js").CanonicalRequest} CanonicalRequest
 * @typedef {import("./request.js").ProviderContext} ProviderContext
 * @typedef {import("./events.js").ProviderEvent} ProviderEvent
 * @typedef {import("./capabilities.js").ProviderCapabilities} ProviderCapabilities
 *
 * @typedef {object} QoderProvider
 * @property {"gateway" | "cli" | "cloudAgents"} id
 * @property {() => ProviderCapabilities | Promise<ProviderCapabilities>} capabilities
 * @property {() => Promise<Array<{ id: string, label?: string }>>} listModels
 * @property {(request: CanonicalRequest, context: ProviderContext) => AsyncIterable<ProviderEvent>} stream
 * @property {() => Promise<void>} [dispose]
 */

// 注册期校验：缺方法或缺能力键直接 fail fast，不让坏 Provider 进入路由。
export function assertProvider(provider) {
  if (!provider || typeof provider !== "object") {
    throw new TypeError("provider must be an object");
  }
  for (const method of ["capabilities", "listModels", "stream"]) {
    if (typeof provider[method] !== "function") {
      throw new TypeError(`provider "${provider.id ?? "?"}" is missing ${method}()`);
    }
  }
  const caps = provider.capabilities();
  for (const key of CAPABILITY_KEYS) {
    if (!(key in { ...defaultCapabilities(), ...caps })) {
      throw new TypeError(`provider "${provider.id ?? "?"}" capabilities missing "${key}"`);
    }
  }
  return provider;
}
