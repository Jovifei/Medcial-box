/**
 * 应用版本与小程序更新（R2-e / R4 更新链路）：
 * - APP_VERSION 由发布流程维护，"我的 → 版本与更新"展示；
 * - watchForUpdates 使用 wx.getUpdateManager：新版本就绪后提示用户重启，
 *   每个版本只提示一次（按版本号记 storage），不静默重启——
 *   重启前若有未保存草稿，给出「保存并重启 / 放弃草稿并重启 / 稍后」三选，
 *   保存失败则延期更新（R14），不把"提示先保存"当成保存措施；
 * - 功能介绍（release notes）每个版本只自动弹一次，"版本与更新"可再次查看；
 *   每次最多展示三项重点改进，不写营销话术。
 */

import { clearDirtyDraft, peekDirtyDraft } from "./draft-guard";

export const APP_VERSION = "0.2.0-s0s1r1";

export interface ReleaseNote {
  version: string;
  date: string;
  items: string[];
}

/** 新版本重点改进：只列用户能直接感知的变化，最多三项。 */
export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "0.2.0-s0s1r1",
    date: "2026-10-01",
    items: [
      "新增用药计划：照护对象、每日时间点、今日安排与服用确认，纠正会保留操作历史。",
      "数量支持毫升（最多三位小数）与“板”，切换单位不再自动换算旧数字。",
      "药箱首页支持按人群与用途组合筛选，并按有效期或名称排序。",
    ],
  },
];

const UPDATE_PROMPT_KEY = "update:prompted-version";
const RELEASE_NOTES_KEY = "update:release-notes-version";

export function currentReleaseNote(): ReleaseNote | null {
  return RELEASE_NOTES.find((note) => note.version === APP_VERSION) ?? null;
}

export function releaseNotesSeen(): boolean {
  try {
    return String(wx.getStorageSync(RELEASE_NOTES_KEY) ?? "") === APP_VERSION;
  } catch {
    return false;
  }
}

export function markReleaseNotesSeen(): void {
  try {
    wx.setStorageSync(RELEASE_NOTES_KEY, APP_VERSION);
  } catch {
    // 本地存储不可用时静默：最坏情况是本版本再次展示一次。
  }
}

/**
 * 新版本首次进入时展示功能介绍（最多三项），每个版本仅一次。
 * 与安装更新提示分开：这里只做介绍，不打断未保存的录入。
 */
export function showReleaseNotesIfNeeded(): boolean {
  const note = currentReleaseNote();
  if (note === null || releaseNotesSeen()) return false;
  markReleaseNotesSeen();
  if (typeof wx.showModal !== "function") return false;
  wx.showModal({
    title: `版本 ${note.version} 更新`,
    content: note.items.slice(0, 3).join("\n"),
    showCancel: false,
    confirmText: "知道了",
  });
  return true;
}

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
      content: `新版本（${APP_VERSION}）已下载完成。重启会关闭当前页面；如正在填写计划或药品信息，请先处理未保存的草稿。`,
      confirmText: "处理并重启",
      cancelText: "稍后",
      success: (result) => {
        if (result.confirm) void confirmRestart(manager);
      },
    });
  });
  manager.onUpdateFailed(() => {
    wx.showToast({ title: "新版本下载失败，可删除小程序后重新打开", icon: "none", duration: 3000 });
  });
}

/**
 * 重启前处理未保存草稿（R14）：有脏草稿时给出「保存并重启 / 放弃草稿并重启 / 稍后」三选；
 * 保存失败则延期更新（不重启），把选择权交回用户。无草稿时直接重启。
 */
async function confirmRestart(manager: { applyUpdate: () => void }): Promise<void> {
  const draft = peekDirtyDraft();
  if (draft === null) {
    manager.applyUpdate();
    return;
  }
  if (typeof wx.showActionSheet !== "function") {
    // 极少数环境没有 action sheet：退回二选一，默认不重启以保护草稿。
    wx.showModal({
      title: "有未保存的草稿",
      content: `${draft.label}重启会丢失它。是否放弃草稿并重启？`,
      confirmText: "放弃并重启",
      cancelText: "稍后",
      success: (result) => {
        if (result.confirm) {
          clearDirtyDraft();
          manager.applyUpdate();
        }
      },
    });
    return;
  }
  wx.showActionSheet({
    itemList: ["保存并重启", "放弃草稿并重启", "稍后再说"],
    success: async (choice) => {
      const tapIndex = choice.tapIndex;
      if (tapIndex === 2) return; // 稍后再说：继续编辑，不重启。
      if (tapIndex === 1) {
        clearDirtyDraft();
        manager.applyUpdate();
        return;
      }
      try {
        await draft.save();
        clearDirtyDraft();
        manager.applyUpdate();
      } catch {
        wx.showToast({ title: "保存失败，已延期更新；请稍后重试或手动保存", icon: "none", duration: 3000 });
      }
    },
    fail: () => {
      // 用户取消 action sheet：视为"稍后再说"，不重启。
    },
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
