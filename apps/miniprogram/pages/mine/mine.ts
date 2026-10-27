import { APP_VERSION } from "../../services/app-update";
import { api, ApiError, captureSessionIdentity, isCurrentSession } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import type { DeviceSessionSummary } from "../../services/api-types";

const ROUTES: Record<string, string> = {
  account: "/pages/account-settings/account-settings",
  family: "/pages/family-settings/family-settings",
  care: "/pages/care-profiles/care-profiles",
  invite: "/pages/invite/invite",
  app: "/pages/app-link/app-link",
  notifications: "/pages/notification-settings/notification-settings",
  export: "/pages/export-preview/export-preview",
  backup: "/pages/backup-restore/backup-restore",
  restock: "/pages/restock/restock",
  stocktake: "/pages/stocktake/stocktake",
  stocktakeSettings: "/pages/family-settings/family-settings?section=stocktake",
  trash: "/pages/trash/trash",
  audit: "/pages/audit/audit",
  release: "/pages/release-notes/release-notes",
};

interface DeviceView extends DeviceSessionSummary { kindLabel: string }

Page({
  data: {
    familyName: "", roleLabel: "", loading: true, errorMessage: "", appVersion: APP_VERSION,
    devices: [] as DeviceView[], devicesLoading: true, devicesError: "", revokingDeviceId: "", deviceExpanded: false,
  },

  onShow(): void { void this.refresh(); },
  onHide(): void { ++this.refreshSeq; },
  onUnload(): void { ++this.refreshSeq; },
  refreshSeq: 0,
  viewIdentity: null as ReturnType<typeof captureSessionIdentity> | null,

  onToggleDevices(): void { this.setData({ deviceExpanded: !this.data.deviceExpanded }); },

  clearPrivateView(): void {
    this.viewIdentity = null;
    this.setData({ familyName: "", roleLabel: "", devices: [], deviceExpanded: false,
      revokingDeviceId: "", loading: false, devicesLoading: false });
  },

  async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    const identity = captureSessionIdentity();
    const current = (): boolean => seq === this.refreshSeq && isCurrentSession(identity);
    const discardStale = (): void => { if (seq === this.refreshSeq && !isCurrentSession(identity)) this.clearPrivateView(); };
    this.viewIdentity = null;
    this.setData({ familyName: "", roleLabel: "", devices: [], deviceExpanded: false, revokingDeviceId: "",
      loading: true, devicesLoading: true, errorMessage: "", devicesError: "" });
    try {
      await ensureLoggedIn({ allowInteractive: false, rejectScopeChange: true });
      if (!current()) { discardStale(); return; }
      const result = await api.getCurrentFamily();
      if (!current()) { discardStale(); return; }
      this.viewIdentity = identity;
      this.setData({ familyName: result.family.name, roleLabel: result.family.role === "owner" ? "管理员" : "成员" });
      try {
        const deviceResult = await api.getDevices();
        if (!current()) { discardStale(); return; }
        this.setData({ devices: deviceResult.devices.map((device) => ({ ...device,
          kindLabel: device.clientKind === "android" ? "Android App" : "微信小程序" })), devicesError: "" });
      } catch (error) {
        if (!current()) { discardStale(); return; }
        this.setData({ devices: [], devicesError: error instanceof ApiError ? error.message : "暂时无法读取已登录设备" });
      }
    } catch (error) {
      if (!current()) { discardStale(); return; }
      const message = error instanceof ApiError ? error.message : "暂时无法读取家庭信息";
      this.setData({ errorMessage: message });
    } finally {
      if (current()) this.setData({ loading: false, devicesLoading: false });
    }
  },

  onOpenItem(event: { currentTarget: { dataset: { route?: string } } }): void {
    const route = ROUTES[event.currentTarget.dataset.route ?? ""];
    if (route) wx.navigateTo({ url: route });
  },

  async onRevokeDevice(event: { currentTarget: { dataset: { id?: string } } }): Promise<void> {
    const id = event.currentTarget.dataset.id;
    if (!id || this.data.revokingDeviceId !== "") return;
    const device = (this.data.devices as DeviceView[]).find((item) => item.id === id);
    if (device === undefined || device.clientKind !== "android" || device.isCurrent) return;
    const identity = this.viewIdentity;
    const seq = this.refreshSeq;
    const current = (): boolean => identity !== null && identity === this.viewIdentity && seq === this.refreshSeq && isCurrentSession(identity);
    if (!current()) { if (seq === this.refreshSeq) this.clearPrivateView(); return; }
    const confirmed = await new Promise<boolean>((resolve) => wx.showModal({
      title: "撤销 Android App 授权",
      content: "撤销后该 App 需要重新通过小程序确认连接，家庭数据访问会立即失效。",
      success: (result) => resolve(result.confirm), fail: () => resolve(false),
    }));
    if (!current()) { if (seq === this.refreshSeq) this.clearPrivateView(); return; }
    if (!confirmed) return;
    this.setData({ revokingDeviceId: id });
    try {
      await ensureLoggedIn({ allowInteractive: false, rejectScopeChange: true });
      if (!current()) { if (seq === this.refreshSeq) this.clearPrivateView(); return; }
      await api.revokeAndroidDevice(id);
      if (!current()) { if (seq === this.refreshSeq) this.clearPrivateView(); return; }
      wx.showToast({ title: "已撤销设备授权", icon: "success" });
      await this.refresh();
    } catch (error) {
      if (current()) wx.showToast({ title: error instanceof ApiError ? error.message : "撤销失败，请刷新后重试", icon: "none" });
      else if (seq === this.refreshSeq) this.clearPrivateView();
    } finally {
      if (seq === this.refreshSeq) this.setData({ revokingDeviceId: "" });
    }
  },

  onRetry(): void { void this.refresh(); },
});
