import { showReleaseNotesIfNeeded, watchForUpdates } from "./services/app-update";

App<IAppOption>({
  globalData: {
    stage: "P2-family-trial",
  },
  onLaunch() {
    // 默认关闭移动端 vConsole 调试球，避免遮挡界面内容；可在"我的 → 版本与更新"连击 5 次按需唤起
    if (typeof wx.setEnableDebug === "function") {
      try {
        const debugEnabled = wx.getStorageSync("medbox_debug_enabled") === true;
        wx.setEnableDebug({ enableDebug: debugEnabled });
      } catch {
        // 环境不支持或静默失败时不阻塞启动
      }
    }
    // 小程序更新链路（R4）：新版本就绪后提示重启，每版本仅提示一次；
    // 功能介绍同样每版本只自动展示一次，"我的 → 版本与更新"可再次查看。
    watchForUpdates();
    showReleaseNotesIfNeeded();
  },
});
