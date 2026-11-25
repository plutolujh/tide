// providers/index.js
// 工厂函数，根据 type 返回对应 Provider 实例。
// 目前仅保留 minimax（doubao / deepseek 已于 2026-11-25 移除）。

const providers = {
  minimax: async () => {
    const { MinimaxProvider } = await import("./minimax.js");
    return new MinimaxProvider();
  },
};

export async function createProvider(type) {
  const Factory = providers[type];
  if (!Factory) throw new Error(`Unknown provider: ${type}`);
  return Factory();
}

export function isProviderAvailable(type) {
  return type in providers;
}
