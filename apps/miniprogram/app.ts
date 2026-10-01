import { showReleaseNotesIfNeeded, watchForUpdates } from "./services/app-update";

App<IAppOption>({
  globalData: {
    stage: "P2-family-trial",
    // 开发默认本机回环；真机/生产由发布配置替换。令牌存本地存储（services/api.ts）。
    apiBase: "http://127.0.0.1:3000",
    token: "",
  },
  onLaunch() {
    // 小程序更新链路（R4）：新版本就绪后提示重启，每版本仅提示一次；
    // 功能介绍同样每版本只自动展示一次，"我的 → 版本与更新"可再次查看。
    watchForUpdates();
    showReleaseNotesIfNeeded();
  },
});
