import { api, ApiError, captureSessionIdentity, isCurrentSession } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import { registerTemporaryShareFile, cleanupTemporaryShareFile, recoverTemporaryShareFiles, temporaryShareScope } from "../../services/temporary-share-files";
import type { FamilyMedicineBackup, PreviewJsonBackupResponse } from "../../services/api-types";

interface LocalFile { path: string; name: string }
interface FileSystemCapableWx {
  chooseMessageFile?: (options: { count: number; type: "file"; extension: string[]; success: (result: { tempFiles: Array<{ path: string; name: string }> }) => void; fail: (error: { errMsg?: string }) => void }) => void;
  shareFileMessage?: (options: { filePath: string; fileName: string; success: () => void; fail: (error: { errMsg?: string }) => void }) => void;
}

function readLocalText(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => wx.getFileSystemManager().readFile({
    filePath,
    encoding: "utf8",
    success: (result) => resolve(String(result.data)),
    fail: (error) => reject(new Error(error.errMsg ?? "无法读取文件")),
  }));
}

Page({
  // Keep the full import payload on the JS page instance. Putting it in data would
  // serialize the whole backup to the view layer and can exceed WeChat setData limits.
  pendingImportPayload: null as FamilyMedicineBackup | null,
  pendingConfirmationToken: null as string | null,
  backupLifecycleEpoch: 0,
  backupOperationIdentity: null as ReturnType<typeof captureSessionIdentity> | null,
  backupOperationScope: null as string | null,
  backupCopyScope: null as string | null,
  backupCopyIdentity: null as ReturnType<typeof captureSessionIdentity> | null,
  onUnload(): void { this.backupLifecycleEpoch += 1; },
  onShow(): void {
    if (this.backupOperationIdentity !== null &&
        (!isCurrentSession(this.backupOperationIdentity) || this.backupOperationScope !== temporaryShareScope())) {
      ++this.backupLifecycleEpoch;
      this.backupOperationIdentity = null;
      this.backupOperationScope = null;
      this.pendingImportPayload = null;
      this.pendingConfirmationToken = null;
      this.setData({ busy: false, backupJson: "", backupCreatedAt: "", statusText: "", errorMessage: "",
        importPreview: null, previewCountsText: "", conflictText: "", restoreAllowed: false, selectedFileName: "" });
    }
    if (this.backupCopyScope !== null &&
        (this.backupCopyScope !== temporaryShareScope() || !this.backupCopyIdentity || !isCurrentSession(this.backupCopyIdentity))) {
      this.backupCopyScope = null;
      this.backupCopyIdentity = null;
      this.setData({ backupJson: "", backupCreatedAt: "", statusText: "" });
    }
    if (!this.data.busy) void recoverTemporaryShareFiles();
  },
  data: {
    busy: false,
    errorMessage: "",
    statusText: "",
    backupJson: "",
    backupCreatedAt: "",
    importPreview: null as PreviewJsonBackupResponse | null,
    previewCountsText: "",
    conflictText: "",
    restoreAllowed: false,
    selectedFileName: "",
  },

  async onCreateBackup(): Promise<void> {
    if (this.data.busy) return;
    const identity = captureSessionIdentity();
    const scope = temporaryShareScope();
    if (scope === null) { this.setData({ errorMessage: "请先登录并选择家庭，再生成备份。" }); return; }
    this.pendingImportPayload = null;
    this.pendingConfirmationToken = null;
    this.setData({ busy: true, errorMessage: "", statusText: "正在生成 JSON 备份…",
      importPreview: null, restoreAllowed: false, previewCountsText: "", conflictText: "" });
    let localFile = "";
    const epoch = ++this.backupLifecycleEpoch;
    this.backupOperationIdentity = identity;
    this.backupOperationScope = scope;
    const current = (): boolean => scope !== null && temporaryShareScope() === scope &&
      isCurrentSession(identity) && this.backupLifecycleEpoch === epoch;
    const ensureCurrent = (): void => { if (!current()) throw new Error("家庭或登录状态已变化；旧备份不会分享，请在当前家庭重新操作。"); };
    try {
      ensureCurrent();
      await ensureLoggedIn();
      ensureCurrent();
      const backup = await api.createJsonBackup();
      ensureCurrent();
      const json = JSON.stringify(backup, null, 2);
      const filename = `home-medicine-backup-${backup.backupId}.json`;
      const native = wx as unknown as FileSystemCapableWx;
      if (typeof native.shareFileMessage === "function") {
        localFile = `${wx.env.USER_DATA_PATH}/home-medicine-share-${Date.now()}-${Math.random().toString(36).slice(2, 12)}.json`;
        ensureCurrent();
        if (!registerTemporaryShareFile(localFile, scope)) {
          throw new Error("无法安全登记临时备份文件；本次没有将备份写入磁盘");
        }
        ensureCurrent();
        await new Promise<void>((resolve, reject) => wx.getFileSystemManager().writeFile({
          filePath: localFile, data: json, encoding: "utf8", success: () => resolve(),
          fail: (error) => reject(new Error(error.errMsg ?? "写入临时备份文件失败")),
        }));
        ensureCurrent();
        await new Promise<void>((resolve, reject) => native.shareFileMessage?.({
          filePath: localFile, fileName: filename, success: resolve,
          fail: (error) => reject(new Error(error.errMsg ?? "分享未完成")),
        }));
        ensureCurrent();
        this.setData({ backupCreatedAt: backup.exportedAt, backupJson: "", statusText: "JSON 备份文件已交给微信分享。" });
      } else {
        ensureCurrent();
        this.backupCopyScope = scope;
        this.backupCopyIdentity = identity;
        this.setData({ backupJson: json, backupCreatedAt: backup.exportedAt, statusText: "当前微信版本不支持文件分享。可复制下方 JSON 并保存为 .json 文件。" });
      }
    } catch (error) {
      // 页面已换家庭/身份时旧错误不能回填到新的视图。
      if (current()) this.setData({ errorMessage: error instanceof ApiError ? error.message :
        error instanceof Error ? error.message : "备份生成或分享失败" });
    } finally {
      const cleaned = localFile === "" || await cleanupTemporaryShareFile(localFile, scope);
      if (current()) {
        if (!cleaned) this.setData({ errorMessage: "临时备份原件清理待重试；下次进入页面将再次清理" });
        this.setData({ busy: false });
      }
    }
  },

  onCopyBackup(): void {
    const json = this.data.backupJson as string;
    if (json === "") return;
    if (!this.backupCopyIdentity || !isCurrentSession(this.backupCopyIdentity) ||
        this.backupCopyScope !== temporaryShareScope()) {
      this.backupCopyIdentity = null;
      this.backupCopyScope = null;
      this.setData({ backupJson: "", backupCreatedAt: "", statusText: "", errorMessage: "登录或家庭已变化，请重新生成备份。" });
      return;
    }
    const identity = this.backupCopyIdentity;
    const scope = this.backupCopyScope;
    const epoch = this.backupLifecycleEpoch;
    wx.setClipboardData({ data: json,
      success: () => { if (epoch === this.backupLifecycleEpoch && isCurrentSession(identity) && scope === temporaryShareScope()) this.setData({ statusText: "JSON 已复制，请粘贴保存为 .json 文件。" }); },
      fail: () => { if (epoch === this.backupLifecycleEpoch && isCurrentSession(identity) && scope === temporaryShareScope()) this.setData({ errorMessage: "复制失败，请重试" }); } });
  },

  async onChooseImport(): Promise<void> {
    if (this.data.busy) return;
    const identity = captureSessionIdentity();
    const scope = temporaryShareScope();
    if (scope === null) { this.setData({ errorMessage: "请先登录并选择家庭，再预览备份。" }); return; }
    const epoch = ++this.backupLifecycleEpoch;
    this.backupOperationIdentity = identity;
    this.backupOperationScope = scope;
    const current = (): boolean => epoch === this.backupLifecycleEpoch && isCurrentSession(identity) && scope === temporaryShareScope();
    const native = wx as unknown as FileSystemCapableWx;
    if (typeof native.chooseMessageFile !== "function") {
      this.setData({ errorMessage: "当前微信版本不支持选择文件，请升级微信后重试。" });
      return;
    }
    this.pendingImportPayload = null;
    this.pendingConfirmationToken = null;
    this.setData({ busy: true, errorMessage: "", importPreview: null, restoreAllowed: false,
      previewCountsText: "", conflictText: "", selectedFileName: "" });
    try {
      const file = await new Promise<LocalFile | null>((resolve) => {
        const choose = native.chooseMessageFile;
        if (typeof choose !== "function") { resolve(null); return; }
        choose({
          count: 1, type: "file", extension: ["json"],
          success: (result) => resolve(result.tempFiles[0] ? { path: result.tempFiles[0].path, name: result.tempFiles[0].name } : null),
          fail: () => resolve(null),
        });
      });
      if (file === null || !current()) return;
      this.setData({ statusText: "正在读取并检查备份…", selectedFileName: file.name });
      await ensureLoggedIn({ allowInteractive: false });
      if (!current()) return;
      const text = await readLocalText(file.path);
      if (!current()) return;
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("JSON 根节点必须是对象");
      }
      const payload = parsed as FamilyMedicineBackup;
      const preview = await api.previewJsonBackup(payload);
      if (!current()) return;
      this.pendingImportPayload = payload;
      this.pendingConfirmationToken = preview.confirmationToken ?? null;
      const countsText = `药品 ${preview.medicineCount} 项${preview.duplicateBackup ? " · 此备份已导入过" : ""}`;
      const matches = preview.likelyMatches.map((entry) => `${entry.importedName} ↔ ${entry.existingName}`);
      const stocktake = preview.inventorySettings?.stocktakeInterval ?? "未提供";
      const displayPreview = { ...preview };
      delete displayPreview.confirmationToken;
      this.setData({ importPreview: displayPreview, previewCountsText: countsText,
        conflictText: [
          `备份盘点频率：${stocktake}（仅供参考，恢复不会修改当前家庭设置）`,
          ...matches.map((name) => `可能重复：${name}（不会自动合并）`),
          ...preview.errors,
        ].join("；") || "没有检测到需要提示的问题。",
        restoreAllowed: preview.valid && !preview.duplicateBackup && typeof preview.confirmationToken === "string",
        statusText: "预览完成；确认前不会写入家庭药箱。" });
    } catch (error) {
      if (!current()) return;
      this.pendingImportPayload = null;
      this.pendingConfirmationToken = null;
      this.setData({ errorMessage: error instanceof ApiError ? error.message : error instanceof Error ? error.message : "备份文件无效" });
    } finally { if (current()) this.setData({ busy: false }); }
  },

  async onConfirmRestore(): Promise<void> {
    const preview = this.data.importPreview as PreviewJsonBackupResponse | null;
    const backup = this.pendingImportPayload;
    const identity = this.backupOperationIdentity;
    const scope = this.backupOperationScope;
    const epoch = this.backupLifecycleEpoch;
    const confirmationToken = this.pendingConfirmationToken;
    if (preview === null || backup === null || identity === null || scope === null ||
        confirmationToken === null || !this.data.restoreAllowed || this.data.busy) return;
    const current = (): boolean => epoch === this.backupLifecycleEpoch && isCurrentSession(identity) &&
      scope === temporaryShareScope() && this.pendingImportPayload === backup &&
      this.pendingConfirmationToken === confirmationToken;
    if (!current()) { this.onShow(); return; }
    this.setData({ busy: true, errorMessage: "" });
    try {
      const confirmed = await new Promise<boolean>((resolve) => wx.showModal({
        title: "恢复到当前家庭",
        content: "恢复会新增备份中的药品和批次，不会覆盖现有药品或家庭盘点设置。确认后无法自动撤回。",
        success: (result) => resolve(result.confirm), fail: () => resolve(false),
      }));
      if (!confirmed || !current()) return;
      this.setData({ statusText: "正在恢复…" });
      await ensureLoggedIn({ allowInteractive: false });
      if (!current()) return;
      const response = await api.restoreJsonBackup(backup, confirmationToken);
      if (!current()) return;
      this.pendingImportPayload = null;
      this.pendingConfirmationToken = null;
      this.setData({ statusText: `已新增 ${response.restoredCount} 种药品到当前家庭。`, importPreview: null, restoreAllowed: false });
      wx.showToast({ title: "恢复完成", icon: "success" });
    } catch (error) {
      if (current()) this.setData({ errorMessage: error instanceof ApiError ? error.message : "恢复失败；当前家庭数据未显示为已恢复" });
    } finally {
      if (epoch === this.backupLifecycleEpoch && isCurrentSession(identity) && scope === temporaryShareScope()) this.setData({ busy: false });
    }
  },
});
