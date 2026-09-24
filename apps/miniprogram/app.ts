App<IAppOption>({
  globalData: {
    stage: "P1-B2",
    // 开发默认本机回环；真机/生产由发布配置替换。令牌存本地存储（services/api.ts）。
    apiBase: "http://127.0.0.1:3000",
    token: "",
  },
});
