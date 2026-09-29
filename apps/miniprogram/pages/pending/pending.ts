import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import type { PendingNotificationSummary } from "../../services/api-types";

function showError(error: unknown): string {
  return error instanceof ApiError ? error.message : "暂时无法读取待处理事项";
}

Page({
  data: { loading: true, items: [] as PendingNotificationSummary[], errorMessage: "", lastUpdated: "" },
  onShow(): void { void this.refresh(); },
  onPullDownRefresh(): void { void this.refresh().finally(() => wx.stopPullDownRefresh()); },

  async refresh(): Promise<void> {
    this.setData({ loading: true, errorMessage: "" });
    try {
      await ensureLoggedIn();
      const result = await api.getPendingNotifications();
      this.setData({ items: result.items, lastUpdated: new Date().toLocaleString() });
    } catch (error) {
      this.setData({ errorMessage: showError(error) });
    } finally {
      this.setData({ loading: false });
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
