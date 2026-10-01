/**
 * 应用版本与小程序更新（R2-e / R4 更新链路）：
 * - APP_VERSION 由发布流程维护，"我的 → 版本与更新"展示；
 * - watchForUpdates 使用 wx.getUpdateManager：新版本就绪后提示用户重启，
 *   每个版本只提示一次（按版本号记 storage），不静默重启——
 *   用户可能还有未保存的草稿，重启前应先保存。
 */

export const APP_VERSION = "0.2.0-s0s1r1";

const UPDATE_PROMPT_KEY = "update:prompted-version";

export function watchForUpdates(): void {
  if (typeof wx === "undefined" || typeof wx.getUpdateManager !== "function") {
    // 开发者工具与部分环境没有该 API；直接返回，不影响启动。
    return;
  }
  const manager = wx.getUpdateManager();
  manager.onUpdateReady(() => {
    const prompted = readPromptedVersion();
    if (prompted === APP_VERSION) return;
    markPrompted(APP_VERSION);
    wx.showModal({
      title: "新版本已就绪",
      content: `新版本（${APP_VERSION}）已下载完成。如有未保存的录入内容，请先保存，再点击重启应用完成更新。`,
      confirmText: "重启更新",
      cancelText: "稍后",
      success: (result) => {
        if (result.confirm) manager.applyUpdate();
      },
    });
  });
  manager.onUpdateFailed(() => {
    wx.showToast({ title: "新版本下载失败，可删除小程序后重新打开", icon: "none", duration: 3000 });
  });
}

function readPromptedVersion(): string {
  try {
    return String(wx.getStorageSync(UPDATE_PROMPT_KEY) ?? "");
  } catch {
    return "";
  }
}

function markPrompted(version: string): void {
  try {
    wx.setStorageSync(UPDATE_PROMPT_KEY, version);
  } catch {
    // 本地存储不可用时静默：最坏情况是本版本再次提示一次。
  }
}
