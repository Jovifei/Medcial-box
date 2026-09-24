import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";

interface ExportPreviewPageData {
  loading: boolean;
  markdown: string;
  generatedAt: string;
  includePersonalDosage: boolean;
  includeArchived: boolean;
  includeStorageLocation: boolean;
  lastAction: string;
}

interface ShareFileMessageOption {
  filePath: string;
  fileName?: string;
  success?: (result: { errMsg: string }) => void;
  fail?: (result: { errMsg: string }) => void;
}

interface ShareFileCapableWx {
  shareFileMessage?: (option: ShareFileMessageOption) => void;
}

function showError(error: unknown): void {
  const message = error instanceof ApiError ? error.message : "操作失败，请稍后重试";
  wx.showToast({ title: message, icon: "none", duration: 2800 });
}

Page({
  data: {
    loading: false,
    markdown: "",
    generatedAt: "",
    includePersonalDosage: false,
    includeArchived: false,
    includeStorageLocation: true,
    lastAction: "",
  },

  onShow() {
    this.refresh();
  },

  async refresh(): Promise<void> {
    const data = this.data as ExportPreviewPageData;
    if (data.loading) return;
    this.setData({ loading: true });
    try {
      await ensureLoggedIn();
      const result = await api.exportMarkdown({
        includePersonalDosage: data.includePersonalDosage,
        includeArchived: data.includeArchived,
        includeStorageLocation: data.includeStorageLocation,
      });
      this.setData({ markdown: result.markdown, generatedAt: result.generatedAt });
    } catch (error) {
      if (error instanceof ApiError && error.code === "FAMILY_NOT_FOUND") {
        wx.showModal({
          title: "还没有家庭",
          content: "导出前请先创建家庭药箱。",
          showCancel: false,
          success: () => wx.navigateBack(),
        });
        return;
      }
      showError(error);
    } finally {
      this.setData({ loading: false });
    }
  },

  onTogglePersonalDosage(event: { detail: { value: boolean } }): void {
    this.setData({ includePersonalDosage: event.detail.value });
    this.refresh();
  },

  onToggleArchived(event: { detail: { value: boolean } }): void {
    this.setData({ includeArchived: event.detail.value });
    this.refresh();
  },

  onToggleStorageLocation(event: { detail: { value: boolean } }): void {
    this.setData({ includeStorageLocation: event.detail.value });
    this.refresh();
  },

  async onCopy(): Promise<void> {
    const markdown = (this.data as ExportPreviewPageData).markdown;
    if (markdown === "") return;
    try {
      await new Promise<void>((resolve, reject) => {
        wx.setClipboardData({
          data: markdown,
          success: () => resolve(),
          fail: (result) => reject(new Error(result.errMsg ?? "复制失败")),
        });
      });
      this.setData({ lastAction: "已复制到剪贴板" });
      wx.showToast({ title: "已复制文本", icon: "success" });
    } catch (error) {
      showError(error);
    }
  },

  async onShareFile(): Promise<void> {
    const data = this.data as ExportPreviewPageData;
    if (data.markdown === "") return;
    const filePath = `${wx.env.USER_DATA_PATH}/home-medicine-cabinet.md`;
    try {
      await new Promise<void>((resolve, reject) => {
        wx.getFileSystemManager().writeFile({
          filePath,
          data: data.markdown,
          encoding: "utf8",
          success: () => resolve(),
          fail: (result) => reject(new Error(result.errMsg ?? "写入文件失败")),
        });
      });
      const shareApi = (wx as unknown as ShareFileCapableWx).shareFileMessage;
      if (typeof shareApi !== "function") {
        throw new Error("当前微信版本不支持文件分享");
      }
      await new Promise<void>((resolve, reject) => {
        shareApi.call(wx, {
          filePath,
          fileName: "家庭药箱清单.md",
          success: () => resolve(),
          fail: (result) => reject(new Error(result.errMsg ?? "分享未完成")),
        });
      });
      this.setData({ lastAction: "已发起 .md 文件分享" });
    } catch (error) {
      // 真机/当前版本不支持分享或用户取消：回退为复制文本，始终保证可用路径。
      await this.onCopy();
      this.setData({
        lastAction: `文件分享不可用（${error instanceof Error ? error.message : "未知原因"}），已回退为复制文本`,
      });
    }
  },
});
