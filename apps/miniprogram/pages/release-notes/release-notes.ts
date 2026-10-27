import { APP_VERSION, RELEASE_NOTES, markReleaseNotesSeen } from "../../services/app-update";

/**
 * 版本与更新（R4）：展示当前版本说明与历史版本重点改进。
 * 打开本页即视为已读，避免与启动时的自动介绍重复打扰。
 */

interface ReleaseNotesPageData {
  appVersion: string;
  notes: Array<{ version: string; date: string; items: string[]; isCurrent: boolean }>;
}

Page({
  data: {
    appVersion: APP_VERSION,
    notes: [],
  } as ReleaseNotesPageData,
  debugTapCount: 0,
  debugTapTimer: 0,

  onTapDebugTrigger(): void {
    const now = Date.now();
    if (now - this.debugTapTimer > 3000) {
      this.debugTapCount = 1;
    } else {
      this.debugTapCount++;
    }
    this.debugTapTimer = now;
    if (this.debugTapCount >= 5) {
      this.debugTapCount = 0;
      const current = wx.getStorageSync("medbox_debug_enabled") === true;
      const next = !current;
      wx.setStorageSync("medbox_debug_enabled", next);
      if (typeof wx.setEnableDebug === "function") {
        try {
          wx.setEnableDebug({ enableDebug: next });
        } catch {
          // ignore
        }
      }
      wx.showToast({ title: next ? "已开启调试日志" : "已关闭调试日志", icon: "none" });
    }
  },

  onLoad(): void {
    markReleaseNotesSeen();
    this.setData({
      appVersion: APP_VERSION,
      notes: RELEASE_NOTES.map((note) => ({
        version: note.version,
        date: note.date,
        items: note.items.slice(0, 3),
        isCurrent: note.version === APP_VERSION,
      })),
    });
  },
});
