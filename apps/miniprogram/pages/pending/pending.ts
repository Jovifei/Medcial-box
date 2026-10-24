import { api, ApiError, captureSessionIdentity, isCurrentSession } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import type { PendingNotificationSummary } from "../../services/api-types";

function showError(error: unknown): string {
  return error instanceof ApiError ? error.message : "暂时无法读取待处理事项";
}

Page({
  data: { loading: true, items: [] as PendingNotificationSummary[], errorMessage: "", lastUpdated: "" },
  requestSeq: 0,
  displayedIdentity: null as ReturnType<typeof captureSessionIdentity> | null,
  onShow(): void { void this.refresh(); },
  onHide(): void { ++this.requestSeq; },
  onUnload(): void { ++this.requestSeq; },
  onPullDownRefresh(): void { void this.refresh().finally(() => wx.stopPullDownRefresh()); },

  async refresh(): Promise<void> {
    const seq = ++this.requestSeq;
    let identity = captureSessionIdentity();
    const shown = this.displayedIdentity;
    if (shown === null || shown.generation !== identity.generation || shown.token !== identity.token) {
      this.displayedIdentity = identity;
      this.setData({ items: [], lastUpdated: "", errorMessage: "" });
    }
    const current = (): boolean => seq === this.requestSeq && isCurrentSession(identity);
    this.setData({ loading: true, errorMessage: "" });
    const acceptFailure = (error: unknown): boolean => {
      if (seq !== this.requestSeq) return false;
      if (isCurrentSession(identity)) return true;
      if (error instanceof ApiError && error.invalidatedSession && isCurrentSession(error.invalidatedSession)) {
        identity = error.invalidatedSession;
        return true;
      }
      return false;
    };
    try {
      await ensureLoggedIn({ allowInteractive: false, rejectScopeChange: true });
      if (!current()) return;
      const result = await api.getPendingNotifications();
      if (!current()) return;
      this.setData({ items: result.items, lastUpdated: new Date().toLocaleString() });
    } catch (error) {
      if (!acceptFailure(error)) return;
      if (error instanceof ApiError && (error.statusCode === 401 || error.code === "UNAUTHENTICATED")) {
        this.setData({ items: [], lastUpdated: "", loading: false });
        wx.reLaunch({ url: "/pages/login/login" });
        return;
      }
      if (error instanceof ApiError && (error.code === "SESSION_SCOPE_CHANGED" || error.code === "FAMILY_NOT_FOUND")) {
        this.setData({ items: [], lastUpdated: "", loading: false });
        wx.reLaunch({ url: "/pages/family-entry/family-entry" });
        return;
      }
      this.setData({ errorMessage: showError(error) });
    } finally {
      if (current()) this.setData({ loading: false });
    }
  },

  onHandle(event: { currentTarget: { dataset: { id?: string; batchId?: string; action?: string } } }): void {
    const { id, batchId, action } = event.currentTarget.dataset;
    if (action === "stocktake") {
      wx.navigateTo({ url: "/pages/stocktake/stocktake" });
    } else if (action === "restock") {
      wx.navigateTo({ url: "/pages/restock/restock" });
    } else if (action === "edit_batch" && id && batchId) {
      wx.navigateTo({ url: `/pages/batch-edit/batch-edit?medicineId=${encodeURIComponent(id)}&batchId=${encodeURIComponent(batchId)}` });
    } else if (id) {
      wx.navigateTo({ url: `/pages/medicine-detail/medicine-detail?id=${encodeURIComponent(id)}` });
    }
  },

  onRetry(): void { void this.refresh(); },
});
