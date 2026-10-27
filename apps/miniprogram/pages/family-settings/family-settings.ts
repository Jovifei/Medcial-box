import { api, ApiError, captureSessionIdentity, isCurrentSession } from "../../services/api";
import { scopedStorageKey } from "../../services/session-scope";
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
    settingsOnly: false,
  },
  refreshSeq: 0,
  viewIdentity: null as ReturnType<typeof captureSessionIdentity> | null,
  viewScope: null as string | null,
  onLoad(options: { section?: string }): void { this.setData({ settingsOnly: options.section === "stocktake" }); },
  onShow(): void { void this.refresh(); },
  onHide(): void { this.refreshSeq += 1; },
  onUnload(): void { this.refreshSeq += 1; },

  clearPrivateView(): void {
    this.viewIdentity = null;
    this.viewScope = null;
    this.setData({ familyName: "", members: [], role: "", settings: null,
      intervalIndex: 1, saving: false });
  },

  requireCurrentFamilyView(): boolean {
    if (this.viewIdentity !== null && isCurrentSession(this.viewIdentity) &&
        this.viewScope !== null && this.viewScope === scopedStorageKey("family-settings")) return true;
    this.clearPrivateView();
    this.setData({ errorMessage: "当前家庭已变化，请重新打开家庭设置。" });
    return false;
  },

  actionIsCurrent(identity: ReturnType<typeof captureSessionIdentity>, scope: string | null, seq: number): boolean {
    if (seq !== this.refreshSeq || this.viewIdentity !== identity) return false;
    if (scope !== null && isCurrentSession(identity) && scopedStorageKey("family-settings") === scope) return true;
    this.clearPrivateView();
    return false;
  },

  handleActionFailure(error: unknown, identity: ReturnType<typeof captureSessionIdentity>, seq: number): void {
    if (seq !== this.refreshSeq || this.viewIdentity !== identity) return;
    if (this.actionIsCurrent(identity, this.viewScope, seq)) {
      wx.showToast({ title: error instanceof ApiError ? error.message : "操作失败，请重试", icon: "none" });
    } else if (error instanceof ApiError && error.invalidatedSession && isCurrentSession(error.invalidatedSession)) {
      this.setData({ errorMessage: error.message });
    }
  },

  async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    const identity = captureSessionIdentity();
    const current = (): boolean => seq === this.refreshSeq && isCurrentSession(identity);
    // 设置表单须等当前家庭回执后才可编辑，不能让上一家庭的控件仍可写。
    this.clearPrivateView();
    this.setData({ errorMessage: "" });
    try {
      await ensureLoggedIn({ allowInteractive: false, rejectScopeChange: true });
      if (!current()) return;
      const [familyResult, settingsResult] = await Promise.all([api.getCurrentFamily(), api.getFamilyInventorySettings()]);
      if (!current()) return;
      const index = Math.max(0, INTERVALS.indexOf(settingsResult.settings.stocktakeInterval));
      this.viewIdentity = identity;
      this.viewScope = scopedStorageKey("family-settings");
      this.setData({ familyName: familyResult.family.name, members: familyResult.family.members,
        role: familyResult.family.role, settings: settingsResult.settings, intervalIndex: index });
    } catch (error) {
      if (seq !== this.refreshSeq || (!isCurrentSession(identity) &&
          !(error instanceof ApiError && error.invalidatedSession && isCurrentSession(error.invalidatedSession)))) return;
      this.setData({ errorMessage: error instanceof ApiError ? error.message : "暂时无法读取家庭设置" });
    }
  },

  async onIntervalChange(event: { detail: { value: string | number } }): Promise<void> {
    const index = Number(event.detail.value);
    const data = this.data as FamilySettingsPageData;
    if (data.settings === null || index < 0 || index >= INTERVALS.length || data.saving) return;
    if (!this.requireCurrentFamilyView()) return;
    const seq = this.refreshSeq;
    const identity = this.viewIdentity!;
    const familyScope = this.viewScope;
    const current = (): boolean => this.actionIsCurrent(identity, familyScope, seq);
    if (!current()) { this.clearPrivateView(); return; }
    const settings = { ...data.settings, stocktakeInterval: INTERVALS[index] };
    this.setData({ intervalIndex: index, saving: true, errorMessage: "" });
    try {
      await ensureLoggedIn({ allowInteractive: false, rejectScopeChange: true });
      if (!current()) return;
      const result = await api.updateFamilyInventorySettings(settings);
      if (!current()) return;
      this.setData({ settings: result.settings, intervalIndex: Math.max(0, INTERVALS.indexOf(result.settings.stocktakeInterval)) });
      wx.showToast({ title: "盘点频率已保存", icon: "success" });
    } catch (error) {
      if (!current()) {
        if (seq === this.refreshSeq && error instanceof ApiError && error.invalidatedSession &&
            isCurrentSession(error.invalidatedSession)) this.setData({ errorMessage: error.message });
        return;
      }
      this.setData({ intervalIndex: Math.max(0, INTERVALS.indexOf(data.settings.stocktakeInterval)) });
      wx.showToast({ title: error instanceof ApiError ? error.message : "保存失败，请重试", icon: "none" });
    } finally {
      if (seq === this.refreshSeq) {
        if (!current()) this.clearPrivateView();
        this.setData({ saving: false });
      }
    }
  },

  async onManageMember(event: { currentTarget: { dataset: { id?: string; action?: string } } }): Promise<void> {
    const { id, action } = event.currentTarget.dataset;
    if (!id || !this.requireCurrentFamilyView() || this.data.role !== "owner") return;
    const identity = this.viewIdentity!;
    const familyScope = this.viewScope;
    const seq = this.refreshSeq;
    const stillOriginal = () => this.actionIsCurrent(identity, familyScope, seq);
    const confirmed = await new Promise<boolean>((resolve) => wx.showModal({ title: action === "transfer" ? "转让管理员" : "移除成员", content: action === "transfer" ? "转让后你将成为普通成员，可退出家庭。" : "该成员将失去此药箱访问权限，库存保留。", success: (result) => resolve(result.confirm), fail: () => resolve(false) }));
    if (!stillOriginal() || !confirmed) return;
    try {
      await ensureLoggedIn({ allowInteractive: false, rejectScopeChange: true });
      if (!stillOriginal()) return;
      if (action === "transfer") await api.transferOwnership(id); else await api.removeMember(id);
      if (stillOriginal()) await this.refresh();
    } catch (error) { this.handleActionFailure(error, identity, seq); }
  },
  async onLeaveFamily(): Promise<void> {
    if (!this.requireCurrentFamilyView()) return;
    if (this.data.role === "owner") { wx.showToast({ title: "请先转让管理员，再退出家庭", icon: "none" }); return; }
    const identity = this.viewIdentity!;
    const familyScope = this.viewScope;
    const seq = this.refreshSeq;
    const stillOriginal = () => this.actionIsCurrent(identity, familyScope, seq);
    const confirmed = await new Promise<boolean>((resolve) => wx.showModal({ title: "退出家庭", content: "退出后立即失去药箱访问权限，重新加入需要新的邀请。", success: (result) => resolve(result.confirm), fail: () => resolve(false) }));
    if (!stillOriginal() || !confirmed) return;
    try {
      await ensureLoggedIn({ allowInteractive: false, rejectScopeChange: true });
      if (!stillOriginal()) return;
      await api.leaveFamily();
      // 本次退家仅递增一次代次并清 scope；后来的登录/切家不能被旧回执导航。
      const after = captureSessionIdentity();
      if (seq !== this.refreshSeq || this.viewIdentity !== identity) return;
      this.clearPrivateView();
      if (after.token !== identity.token || after.generation !== identity.generation + 1 ||
          scopedStorageKey("family-settings") !== null) return;
      wx.reLaunch({ url: "/pages/family-entry/family-entry" });
    }
    catch (error) { this.handleActionFailure(error, identity, seq); }
  },
  onChooseFamily(): void { wx.navigateTo({ url: "/pages/family-entry/family-entry" }); },

  onOpenInvite(): void { wx.navigateTo({ url: "/pages/invite/invite" }); },
  onStartStocktake(): void { wx.navigateTo({ url: "/pages/stocktake/stocktake" }); },
});
