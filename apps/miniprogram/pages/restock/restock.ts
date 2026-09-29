import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import type { RestockItemSummary, RestockStatus } from "../../services/api-types";

interface RestockView extends RestockItemSummary { statusLabel: string; quantityLabel: string }

Page({
  data: { loading: true, items: [] as RestockView[], errorMessage: "", busyId: "" },
  onShow(): void { void this.refresh(); },
  onPullDownRefresh(): void { void this.refresh().finally(() => wx.stopPullDownRefresh()); },

  async refresh(): Promise<void> {
    this.setData({ loading: true, errorMessage: "" });
    try {
      await ensureLoggedIn();
      const result = await api.listRestockItems();
      const labels: Record<RestockStatus, string> = { needed: "待购买", purchased: "已购买", dismissed: "已取消" };
      const units: Record<string, string> = { tablet: "片", capsule: "粒", sachet: "袋", bottle: "瓶", box: "盒", other: "份" };
      this.setData({ items: result.items.map((item) => ({ ...item, statusLabel: labels[item.status],
        quantityLabel: item.desiredQuantity === null ? "数量待定" : `目标 ${item.desiredQuantity}${units[item.unit] ?? "份"}` })) });
    } catch (error) {
      this.setData({ errorMessage: error instanceof ApiError ? error.message : "暂时无法读取补货清单" });
    } finally {
      this.setData({ loading: false });
    }
  },

  async onSetStatus(event: { currentTarget: { dataset: { id?: string; status?: RestockStatus; version?: string } } }): Promise<void> {
    const { id, status, version } = event.currentTarget.dataset;
    if (!id || !status || this.data.busyId) return;
    const item = (this.data.items as RestockView[]).find((entry) => entry.id === id);
    if (!item) return;
    this.setData({ busyId: id });
    try {
      await ensureLoggedIn();
      await api.updateRestockItem(id, status, item.version ?? Number(version));
      await this.refresh();
    } catch (error) {
      wx.showToast({ title: error instanceof ApiError ? error.message : "更新失败，请刷新后重试", icon: "none" });
    } finally {
      this.setData({ busyId: "" });
    }
  },

  async onDelete(event: { currentTarget: { dataset: { id?: string } } }): Promise<void> {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    const confirmed = await new Promise<boolean>((resolve) => wx.showModal({
      title: "移出补货清单", content: "这只会移除补货提醒，不会修改药箱库存。",
      success: (result) => resolve(result.confirm), fail: () => resolve(false),
    }));
    if (!confirmed) return;
    try {
      await ensureLoggedIn();
      await api.deleteRestockItem(id);
      await this.refresh();
    } catch (error) {
      wx.showToast({ title: error instanceof ApiError ? error.message : "移除失败", icon: "none" });
    }
  },

  onOpenMedicine(event: { currentTarget: { dataset: { id?: string } } }): void {
    const medicineId = event.currentTarget.dataset.id;
    if (!medicineId) return;
    wx.navigateTo({ url: `/pages/medicine-detail/medicine-detail?id=${encodeURIComponent(medicineId)}` });
  },
});
