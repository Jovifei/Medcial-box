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
