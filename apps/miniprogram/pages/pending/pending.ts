import { api, ApiError, captureSessionIdentity, isCurrentSession } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import type { PendingNotificationSummary } from "../../services/api-types";

function showError(error: unknown): string {
  return error instanceof ApiError ? error.message : "暂时无法读取待处理事项";
}

Page({
  data: { loading: true, items: [] as PendingNotificationSummary[], errorMessage: "", lastUpdated: "" },
  requestSeq: 0,
  onShow(): void { void this.refresh(); },
  onHide(): void { ++this.requestSeq; },
  onUnload(): void { ++this.requestSeq; },
  onPullDownRefresh(): void { void this.refresh().finally(() => wx.stopPullDownRefresh()); },

  async refresh(): Promise<void> {
    const seq = ++this.requestSeq;
    const identity = captureSessionIdentity();
    const current = (): boolean => seq === this.requestSeq && isCurrentSession(identity);
    this.setData({ loading: true, errorMessage: "" });
    try {
      await ensureLoggedIn();
      if (!current()) return;
      const result = await api.getPendingNotifications();
      if (!current()) return;
      this.setData({ items: result.items, lastUpdated: new Date().toLocaleString() });
    } catch (error) {
      if (current()) this.setData({ errorMessage: showError(error) });
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