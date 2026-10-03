import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import type { FamilyInventorySettings, FamilyMemberSummary, StocktakeInterval } from "../../services/api-types";

interface FamilySettingsPageData {
  familyName: string;
  members: FamilyMemberSummary[];
  role: "owner" | "member" | "";
  settings: FamilyInventorySettings | null;
  intervalLabels: string[];
  intervalIndex: number;
  saving: boolean;
  errorMessage: string;
}

const INTERVALS: StocktakeInterval[] = ["weekly", "monthly", "disabled"];

Page({
  data: {
    familyName: "", members: [] as FamilyMemberSummary[], role: "" as FamilySettingsPageData["role"],
    settings: null as FamilyInventorySettings | null,
    intervalLabels: ["每周", "每月（默认）", "关闭自动盘点"], intervalIndex: 1,
    saving: false, errorMessage: "",
  },
  onShow(): void { void this.refresh(); },

  async refresh(): Promise<void> {
    this.setData({ errorMessage: "" });
    try {
      await ensureLoggedIn();
      const [familyResult, settingsResult] = await Promise.all([api.getCurrentFamily(), api.getFamilyInventorySettings()]);
      const index = Math.max(0, INTERVALS.indexOf(settingsResult.settings.stocktakeInterval));
      this.setData({ familyName: familyResult.family.name, members: familyResult.family.members,
        role: familyResult.family.role, settings: settingsResult.settings, intervalIndex: index });
    } catch (error) {
      this.setData({ errorMessage: error instanceof ApiError ? error.message : "暂时无法读取家庭设置" });
    }
  },

  async onIntervalChange(event: { detail: { value: string | number } }): Promise<void> {
    const index = Number(event.detail.value);
    const data = this.data as FamilySettingsPageData;
    if (data.settings === null || index < 0 || index >= INTERVALS.length || data.saving) return;
    const settings = { ...data.settings, stocktakeInterval: INTERVALS[index] };
    this.setData({ intervalIndex: index, saving: true });
    try {
      await ensureLoggedIn();
      const result = await api.updateFamilyInventorySettings(settings);
      this.setData({ settings: result.settings, intervalIndex: Math.max(0, INTERVALS.indexOf(result.settings.stocktakeInterval)) });
      wx.showToast({ title: "盘点频率已保存", icon: "success" });
    } catch (error) {
      this.setData({ intervalIndex: Math.max(0, INTERVALS.indexOf(data.settings.stocktakeInterval)) });
      wx.showToast({ title: error instanceof ApiError ? error.message : "保存失败，请重试", icon: "none" });
    } finally {
      this.setData({ saving: false });
    }
  },

  async onManageMember(event: { currentTarget: { dataset: { id?: string; action?: string } } }): Promise<void> {
    const { id, action } = event.currentTarget.dataset;
    if (!id || this.data.role !== "owner") return;
    const confirmed = await new Promise<boolean>((resolve) => wx.showModal({ title: action === "transfer" ? "转让管理员" : "移除成员", content: action === "transfer" ? "转让后你将成为普通成员，可退出家庭。" : "该成员将失去此药箱访问权限，库存保留。", success: (result) => resolve(result.confirm), fail: () => resolve(false) }));
    if (!confirmed) return;
    try { await ensureLoggedIn(); if (action === "transfer") await api.transferOwnership(id); else await api.removeMember(id); await this.refresh(); }
    catch (error) { wx.showToast({ title: error instanceof ApiError ? error.message : "操作失败，请重试", icon: "none" }); }
  },
  async onLeaveFamily(): Promise<void> {
    if (this.data.role === "owner") { wx.showToast({ title: "请先转让管理员，再退出家庭", icon: "none" }); return; }
    const confirmed = await new Promise<boolean>((resolve) => wx.showModal({ title: "退出家庭", content: "退出后立即失去药箱访问权限，重新加入需要新的邀请。", success: (result) => resolve(result.confirm), fail: () => resolve(false) }));
    if (!confirmed) return;
    try { await api.leaveFamily(); wx.reLaunch({ url: "/pages/family-entry/family-entry" }); }
    catch (error) { wx.showToast({ title: error instanceof ApiError ? error.message : "退出失败，请重试", icon: "none" }); }
  },
  onOpenInvite(): void { wx.navigateTo({ url: "/pages/invite/invite" }); },
  onStartStocktake(): void { wx.navigateTo({ url: "/pages/stocktake/stocktake" }); },
});
