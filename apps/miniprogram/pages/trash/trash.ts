import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import type { TrashItemSummary } from "../../services/api-types";

Page({
  data: { loading: true, items: [] as TrashItemSummary[], errorMessage: "", restoringId: "" },
  onShow(): void { void this.refresh(); },
  onPullDownRefresh(): void { void this.refresh().finally(() => wx.stopPullDownRefresh()); },
  async refresh(): Promise<void> {
    this.setData({ loading: true, errorMessage: "" });
    try {
      await ensureLoggedIn();
      const result = await api.listTrash();
      this.setData({ items: result.items });
    } catch (error) {
      this.setData({ errorMessage: error instanceof ApiError ? error.message : "暂时无法读取最近删除" });
    } finally { this.setData({ loading: false }); }
  },
  async onRestore(event: { currentTarget: { dataset: { id?: string; type?: "medicine" | "batch" } } }): Promise<void> {
    const { id, type } = event.currentTarget.dataset;
    if (!id || !type || this.data.restoringId) return;
    const item = (this.data.items as TrashItemSummary[]).find((entry) => entry.id === id && entry.type === type);
    if (!item) return;
    const confirmed = await new Promise<boolean>((resolve) => wx.showModal({
      title: "恢复记录",
      content: `恢复“${item.name}”到家庭药箱？恢复不会改变批次数量。`,
      success: (result) => resolve(result.confirm), fail: () => resolve(false),
    }));
    if (!confirmed) return;
    this.setData({ restoringId: id });
    try {
      await ensureLoggedIn();
      const result = await api.restoreTrashItem(type, id);
      if (!result.restored) throw new Error("恢复没有得到服务端确认");
      wx.showToast({ title: "已恢复", icon: "success" });
      await this.refresh();
    } catch (error) {
      wx.showToast({ title: error instanceof ApiError ? error.message : "恢复失败，请刷新后重试", icon: "none" });
    } finally { this.setData({ restoringId: "" }); }
  },
});
