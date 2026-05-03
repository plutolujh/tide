// providers/index.js
// 工厂函数，根据 type 返回对应 Provider 实例

const providers = {
  minimax: async () => {
    const { MinimaxProvider } = await import('./minimax.js');
    return new MinimaxProvider();
  },
  doubao: async () => {
    const { DoubaoProvider } = await import('./doubao.js');
    return new DoubaoProvider();
  },
  deepseek: async () => {
    const { DeepSeekProvider } = await import('./deepseek.js');
    return new DeepSeekProvider();
  }
};

export async function createProvider(type) {
  const Factory = providers[type];
  if (!Factory) throw new Error(`Unknown provider: ${type}`);
  return Factory();
}

export function isProviderAvailable(type) {
  return type in providers;
}
