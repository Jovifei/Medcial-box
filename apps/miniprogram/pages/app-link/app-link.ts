import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";

Page({
  data: { code: "", submitting: false, resultText: "" },
  onInput(event: { detail: { value: string } }): void {
    this.setData({ code: event.detail.value.replace(/\s+/g, "").toUpperCase(), resultText: "" });
  },
  async onApprove(): Promise<void> {
    const code = (this.data.code as string).trim();
    if (!/^\d{8}$/.test(code)) {
      this.setData({ resultText: "连接码格式不正确，请输入 Android App 显示的 8 位数字。" });
      wx.showToast({ title: "连接码需为 8 位数字", icon: "none" });
      return;
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true, resultText: "等待确认设备…" });
    const confirmed = await new Promise<boolean>((resolve) => wx.showModal({
      title: "确认连接设备",
      content: "只在你正在连接自己的 Android App 时确认。连接码一次性有效，切勿转发给他人。",
      success: (result) => resolve(result.confirm),
      fail: () => resolve(false),
    }));
    if (!confirmed) {
      this.setData({ submitting: false, resultText: "" });
      return;
    }
    this.setData({ resultText: "正在确认设备…" });
    try {
      await ensureLoggedIn();
      const result = await api.approveAppDeviceLink(code);
      this.setData({ resultText: result.approved ? "连接已确认，请返回 Android App 继续。" : "连接尚未完成，请重新检查连接码。", code: "" });
      if (result.approved) wx.showToast({ title: "设备已确认", icon: "success" });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "设备连接失败，请重新获取连接码";
      this.setData({ resultText: message });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
