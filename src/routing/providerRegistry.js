// Provider Registry：路由层唯一认识的出站适配器集合。
// 注册期 fail-fast 校验，禁止坏 Provider 进入路由。
import { assertProvider } from "../core/provider.js";

export function createProviderRegistry() {
  const providers = new Map();

  return {
    register(provider) {
      assertProvider(provider);
      if (providers.has(provider.id)) {
        throw new TypeError(`provider "${provider.id}" is already registered`);
      }
      providers.set(provider.id, provider);
    },
    get(id) {
      return providers.get(id);
    },
    ids() {
      return [...providers.keys()];
    },
  };
}
