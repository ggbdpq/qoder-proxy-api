// Provider Registry：路由层唯一认识的出站适配器集合。
// 注册期 fail-fast 校验，禁止坏 Provider 进入路由。
import { assertProvider } from "../core/provider.ts";
import type { QoderProvider } from "../core/provider.ts";

export interface ProviderRegistry {
  register(provider: QoderProvider): void;
  get(id: string | undefined): QoderProvider | undefined;
  ids(): string[];
}

export function createProviderRegistry(): ProviderRegistry {
  const providers = new Map<string, QoderProvider>();

  return {
    register(provider: QoderProvider): void {
      assertProvider(provider);
      if (providers.has(provider.id)) {
        throw new TypeError(`provider "${provider.id}" is already registered`);
      }
      providers.set(provider.id, provider);
    },
    get(id: string | undefined): QoderProvider | undefined {
      // v0.1 行为保留：defaultProviderId 可能为 undefined（空注册表），Map 原样 miss。
      return providers.get(id as string);
    },
    ids(): string[] {
      return [...providers.keys()];
    },
  };
}
