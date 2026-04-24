// 注入一个最小可控的 wx 全局，供纯逻辑测试
(globalThis as any).wx = {
  cloud: {
    callContainer: async () => ({ statusCode: 200, data: {} }),
  },
  getStorageSync: () => undefined,
  setStorageSync: () => undefined,
  removeStorageSync: () => undefined,
};
