import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";

interface ExportOptions {
  includePersonalDosage: boolean;
  includeArchived: boolean;
  includeStorageLocation: boolean;
}
interface ExportRequest {
  seq: number;
  format: string;
  options: ExportOptions;
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
let nextFileId = 0;
const pendingFileCleanup = new Set<string>();
async function removeTemporaryFile(filePath: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      wx.getFileSystemManager().unlink({ filePath, success: () => resolve(),
        fail: (result) => reject(new Error(result.errMsg ?? "清理失败")) });
    });
    pendingFileCleanup.delete(filePath);
    return true;
  } catch {
    return false;
  }
}
function showError(error: unknown): void {
  const message = error instanceof ApiError ? error.message : "操作失败，请稍后重试";
  wx.showToast({ title: message, icon: "none", duration: 2800 });
}

Page({
  data: {
    format: "markdown",
    formatIndex: 0,
    formats: ["Markdown", "CSV", "PDF"],
    loading: false,
    actionBusy: false,
    nativeActionPending: false,
    markdown: "",
    generatedAt: "",
    includePersonalDosage: false,
    includeArchived: false,
    includeStorageLocation: true,
    lastAction: "",
  },
  requestSeq: 0,
  snapshot: null as { snapshotId: string; options: ExportOptions } | null,

  async onShow() {
    if (this.data.nativeActionPending) return;
    const cleanupResults = await Promise.all([...pendingFileCleanup].map(removeTemporaryFile));
    void this.refresh();
    if (cleanupResults.some((result) => !result)) {
      this.setData({ lastAction: "临时文件清理失败，请重新打开本页重试" });
      wx.showToast({ title: "临时文件清理失败", icon: "none" });
    }
  },
  onUnload() { ++this.requestSeq; },

  buildOptions(): ExportOptions {
    return {
      includePersonalDosage: this.data.includePersonalDosage,
      includeArchived: this.data.includeArchived,
      includeStorageLocation: this.data.includeStorageLocation,
    };
  },
  beginRequest(): ExportRequest {
    const request = { seq: ++this.requestSeq, format: this.data.format, options: this.buildOptions() };
    if (this.snapshot && JSON.stringify(this.snapshot.options) !== JSON.stringify(request.options)) this.snapshot = null;
    this.setData({ loading: true, markdown: "", generatedAt: "", lastAction: "" });
    return request;
  },
  isCurrent(request: ExportRequest): boolean {
    return request.seq === this.requestSeq && request.format === this.data.format &&
      JSON.stringify(request.options) === JSON.stringify(this.buildOptions());
  },
  // 预览与导出动作共用不可变选项快照；每个异步边界后都复核请求身份。
  async generate(request: ExportRequest): Promise<string | undefined> {
    await ensureLoggedIn();
    if (!this.isCurrent(request)) return;
    if (!this.snapshot && api.createExportSnapshot) {
      const snapshot = await api.createExportSnapshot(request.options);
      if (!this.isCurrent(request)) return;
      this.snapshot = { snapshotId: snapshot.snapshotId, options: { ...request.options } };
    }
    const options = { ...request.options, ...(this.snapshot ? { snapshotId: this.snapshot.snapshotId } : {}) };
    if (request.format === "csv" && this.snapshot) {
      const result = await api.exportCsv({ ...options, snapshotId: this.snapshot.snapshotId });
      if (!this.isCurrent(request)) return;
      this.setData({ markdown: result.content }); return result.content;
    }
    if (request.format === "pdf" && this.snapshot) {
      const result = await api.exportPdf({ ...options, snapshotId: this.snapshot.snapshotId });
      if (!this.isCurrent(request)) return;
      this.setData({ markdown: "PDF 已生成，点击分享可查看文件。" }); return result.contentBase64;
    }
    const result = await api.exportMarkdown(options);
    if (!this.isCurrent(request)) return;
    this.setData({ markdown: result.markdown, generatedAt: result.generatedAt });
    return result.markdown;
  },
  async refresh(): Promise<void> {
    const request = this.beginRequest();
    try {
      await this.generate(request);
    } catch (error) {
      if (!this.isCurrent(request)) return;
      if (error instanceof ApiError && error.code === "FAMILY_NOT_FOUND") {
        wx.showModal({ title: "还没有家庭", content: "导出前请先创建家庭药箱。", showCancel: false,
          success: () => wx.navigateBack() });
        return;
      }
      showError(error);
    } finally {
      if (this.isCurrent(request)) this.setData({ loading: false });
    }
  },
  onFormatChange(event: { detail: { value: string | number } }): void {
    if (this.data.nativeActionPending || this.data.actionBusy) return;
    const index = Number(event.detail.value);
    this.setData({ formatIndex: index, format: ["markdown", "csv", "pdf"][index] ?? "markdown" });
    void this.refresh();
  },
  onRefreshSnapshot(): void { this.snapshot = null; void this.refresh(); },

  onTogglePersonalDosage(event: { detail: { value: boolean } }): void {
    if (this.data.nativeActionPending) return;
    this.setData({ includePersonalDosage: event.detail.value });
    this.refresh();
  },
  onToggleArchived(event: { detail: { value: boolean } }): void {
    if (this.data.nativeActionPending) return;
    this.setData({ includeArchived: event.detail.value });
    this.refresh();
  },
  onToggleStorageLocation(event: { detail: { value: boolean } }): void {
    if (this.data.nativeActionPending) return;
    this.setData({ includeStorageLocation: event.detail.value });
    this.refresh();
  },
  async copyMarkdown(request: ExportRequest, markdown: string, fallback = false): Promise<void> {
    if (!this.isCurrent(request)) return;
    // The native clipboard call cannot be retracted. Freeze options at dispatch.
    this.setData({ nativeActionPending: true });
    await new Promise<void>((resolve, reject) => {
      wx.setClipboardData({ data: markdown, success: () => resolve(),
        fail: (result) => reject(new Error(result.errMsg ?? "复制失败")) });
    });
    if (!this.isCurrent(request)) return;
    this.setData({ lastAction: fallback ? "文件分享未完成，已复制当前文本" : "已复制当前文本" });
    wx.showToast({ title: "已复制文本", icon: "success" });
  },
  async onCopy(): Promise<void> { await this.runAction(false); },
  async onShareFile(): Promise<void> { await this.runAction(true); },
  async runAction(share: boolean): Promise<void> {
    if (this.data.actionBusy) return;
    this.setData({ actionBusy: true });
    const request = this.beginRequest();
    let filePath = "";
    try {
      const markdown = await this.generate(request);
      if (markdown === undefined || !this.isCurrent(request)) return;
      const shareApi = (wx as unknown as ShareFileCapableWx).shareFileMessage;
      if (!share || typeof shareApi !== "function") {
        const text = request.format === "pdf" ? (await api.exportMarkdown({ ...request.options, snapshotId: this.snapshot?.snapshotId })).markdown : markdown;
        await this.copyMarkdown(request, text, share);
        return;
      }
      // 独立文件名防止跨页面实例及前后动作互相覆盖。
      const extension = request.format === "markdown" ? "md" : request.format;
      filePath = `${wx.env.USER_DATA_PATH}/home-medicine-${Date.now()}-${++nextFileId}.${extension}`;
      // Failed writes can leave a partial file containing private text.
      pendingFileCleanup.add(filePath);
      await new Promise<void>((resolve, reject) => {
        wx.getFileSystemManager().writeFile({ filePath, data: markdown, encoding: request.format === "pdf" ? "base64" : "utf8",
          success: () => resolve(), fail: (result) => reject(new Error(result.errMsg ?? "写入文件失败")) });
      });
      if (!this.isCurrent(request)) return;
      try {
        // The native share call cannot be retracted. Freeze options at dispatch.
        this.setData({ nativeActionPending: true });
        await new Promise<void>((resolve, reject) => {
          shareApi.call(wx, { filePath, fileName: `家庭药箱清单.${extension}`, success: () => resolve(),
            fail: (result) => reject(new Error(result.errMsg ?? "分享未完成")) });
        });
      } catch {
        // 仅分享失败/取消回退；网络、写入和剪贴板失败不得报告成功。
        if (this.isCurrent(request)) {
          const text = request.format === "pdf" ? (await api.exportMarkdown({ ...request.options, snapshotId: this.snapshot?.snapshotId })).markdown : markdown;
          await this.copyMarkdown(request, text, true);
        }
        return;
      }
      if (this.isCurrent(request)) this.setData({ lastAction: `已分享当前 .${extension} 文件` });
    } catch (error) {
      if (this.isCurrent(request)) showError(error);
    } finally {
      if (filePath !== "" && pendingFileCleanup.has(filePath)) {
        if (!(await removeTemporaryFile(filePath))) {
          this.setData({ lastAction: "临时文件清理失败，请重新打开本页重试" });
          wx.showToast({ title: "临时文件清理失败", icon: "none" });
        }
      }
      this.setData({ actionBusy: false });
      this.setData({ nativeActionPending: false });
      if (this.isCurrent(request)) this.setData({ loading: false });
    }
  },
});
