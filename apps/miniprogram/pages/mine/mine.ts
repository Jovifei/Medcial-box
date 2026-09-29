import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import type { DeviceSessionSummary } from "../../services/api-types";

const ROUTES: Record<string, string> = {
  family: "/pages/family-settings/family-settings",
  invite: "/pages/invite/invite",
  app: "/pages/app-link/app-link",
  notifications: "/pages/notification-settings/notification-settings",
  export: "/pages/export-preview/export-preview",
  backup: "/pages/backup-restore/backup-restore",
  restock: "/pages/restock/restock",
  trash: "/pages/trash/trash",
  audit: "/pages/audit/audit",
};

interface DeviceView extends DeviceSessionSummary { kindLabel: string }

Page({
  data: {
    familyName: "", roleLabel: "", loading: true, errorMessage: "",
    devices: [] as DeviceView[], devicesLoading: true, devicesError: "", revokingDeviceId: "",
  },

  onShow(): void { void this.refresh(); },

  async refresh(): Promise<void> {
    this.setData({ loading: true, devicesLoading: true, errorMessage: "", devicesError: "" });
    try {
      await ensureLoggedIn();
      const result = await api.getCurrentFamily();
      this.setData({ familyName: result.family.name, roleLabel: result.family.role === "owner" ? "管理员" : "成员" });
      try {
        const deviceResult = await api.getDevices();
        this.setData({ devices: deviceResult.devices.map((device) => ({ ...device,
          kindLabel: device.clientKind === "android" ? "Android App" : "微信小程序" })), devicesError: "" });
      } catch (error) {
        this.setData({ devices: [], devicesError: error instanceof ApiError ? error.message : "暂时无法读取已登录设备" });
      }
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "暂时无法读取家庭信息";
      this.setData({ errorMessage: message });
    } finally {
      this.setData({ loading: false, devicesLoading: false });
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
    const confirmed = await new Promise<boolean>((resolve) => wx.showModal({
      title: "撤销 Android App 授权",
      content: "撤销后该 App 需要重新通过小程序确认连接，家庭数据访问会立即失效。",
      success: (result) => resolve(result.confirm), fail: () => resolve(false),
    }));
    if (!confirmed) return;
    this.setData({ revokingDeviceId: id });
    try {
      await ensureLoggedIn();
      await api.revokeAndroidDevice(id);
      wx.showToast({ title: "已撤销设备授权", icon: "success" });
      await this.refresh();
    } catch (error) {
      wx.showToast({ title: error instanceof ApiError ? error.message : "撤销失败，请刷新后重试", icon: "none" });
    } finally {
      this.setData({ revokingDeviceId: "" });
    }
  },

  onRetry(): void { void this.refresh(); },
});
