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

interface ExportOptions {
  includePersonalDosage: boolean;
  includeArchived: boolean;
  includeStorageLocation: boolean;
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

  /** 请求序号（审核修复 #4）：响应只在其仍是最新一次请求且选项未变时才生效。 */
  requestSeq: 0,

  onShow() {
    this.refresh();
  },

  buildOptions(): ExportOptions {
    const data = this.data as ExportPreviewPageData;
    return {
      includePersonalDosage: data.includePersonalDosage,
      includeArchived: data.includeArchived,
      includeStorageLocation: data.includeStorageLocation,
    };
  },

  async refresh(): Promise<void> {
    const seq = ++this.requestSeq;
    const requestedKey = JSON.stringify(this.buildOptions());
    this.setData({ loading: true });
    try {
      await ensureLoggedIn();
      const result = await api.exportMarkdown(this.buildOptions());
      // 等待期间用户又改了开关或触发了新请求：本次响应作废，不覆盖预览。
      if (seq !== this.requestSeq) return;
      if (JSON.stringify(this.buildOptions()) !== requestedKey) return;
      this.setData({ markdown: result.markdown, generatedAt: result.generatedAt });
    } catch (error) {
      if (seq !== this.requestSeq) return;
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
      if (seq === this.requestSeq) this.setData({ loading: false });
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

  /** 复制/分享前都按当前选项重新生成（审核修复 #4）：绝不使用开关变更前的旧结果。 */
  async freshMarkdown(): Promise<string> {
    await ensureLoggedIn();
    const result = await api.exportMarkdown(this.buildOptions());
    this.setData({ markdown: result.markdown, generatedAt: result.generatedAt });
    return result.markdown;
  },

  async onCopy(): Promise<void> {
    try {
      const markdown = await this.freshMarkdown();
      await new Promise<void>((resolve, reject) => {
        wx.setClipboardData({
          data: markdown,
          success: () => resolve(),
          fail: (result) => reject(new Error(result.errMsg ?? "复制失败")),
        });
      });
      this.setData({ lastAction: "已按当前选项重新生成并复制" });
      wx.showToast({ title: "已复制文本", icon: "success" });
    } catch (error) {
      showError(error);
    }
  },

  async onShareFile(): Promise<void> {
    const filePath = `${wx.env.USER_DATA_PATH}/home-medicine-cabinet.md`;
    try {
      const markdown = await this.freshMarkdown();
      await new Promise<void>((resolve, reject) => {
        wx.getFileSystemManager().writeFile({
          filePath,
          data: markdown,
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
      this.setData({ lastAction: "已按当前选项重新生成并发起 .md 文件分享" });
    } catch (error) {
      // 真机/当前版本不支持分享或用户取消：回退为复制文本，始终保证可用路径。
      await this.onCopy();
      this.setData({
        lastAction: `文件分享不可用（${error instanceof Error ? error.message : "未知原因"}），已按当前选项重新复制`,
      });
    }
  },
});
