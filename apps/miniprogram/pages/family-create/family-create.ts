import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";

interface FamilyCreatePageData {
  name: string;
  submitting: boolean;
}

function showError(error: unknown): void {
  const message =
    error instanceof ApiError ? error.message : "操作失败，请稍后重试";
  wx.showToast({ title: message, icon: "none", duration: 2600 });
}

Page({
  data: {
    name: "",
    submitting: false,
  },

  onNameInput(event: { detail: { value: string } }): void {
    this.setData({ name: event.detail.value });
  },

  async onSubmit(): Promise<void> {
    const data = this.data as FamilyCreatePageData;
    const name = data.name.trim();
    if (name === "") {
      wx.showToast({ title: "请填写家庭名称", icon: "none" });
      return;
    }
    if (data.submitting) return;
    this.setData({ submitting: true });
    try {
      await ensureLoggedIn();
      await api.createFamily(name);
      wx.showToast({ title: "家庭已创建，你是 owner", icon: "success" });
      setTimeout(() => wx.navigateBack({ fail: () => wx.reLaunch({ url: "/pages/index/index" }) }), 900);
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ submitting: false });
    }
  },
});
