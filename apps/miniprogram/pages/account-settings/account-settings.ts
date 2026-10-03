import { api, ApiError } from "../../services/api";
import { ensureLoggedIn, logout } from "../../services/auth";
Page({
  data: { nicknameDraft: "", saving: false, errorMessage: "" },
  onShow(): void { void this.refresh(); },
  async refresh(): Promise<void> {
    try { await ensureLoggedIn({ allowInteractive: false }); const me = await api.getAuthMe(); this.setData({ nicknameDraft: me.user.nickname ?? "", errorMessage: "" }); }
    catch (error) { this.setData({ errorMessage: error instanceof ApiError ? error.message : "读取账号失败，请重试" }); }
  },
  onNicknameInput(event: { detail: { value: string } }): void { this.setData({ nicknameDraft: event.detail.value }); },
  async onSaveNickname(): Promise<void> {
    if (this.data.saving) return;
    const nickname = this.data.nicknameDraft.trim();
    if (nickname.length > 20) { wx.showToast({ title: "显示名最多20个字", icon: "none" }); return; }
    this.setData({ saving: true });
    try { await ensureLoggedIn({ allowInteractive: false }); await api.updateProfile(nickname || null); wx.showToast({ title: "显示名已保存", icon: "success" }); }
    catch (error) { this.setData({ errorMessage: error instanceof ApiError ? error.message : "保存失败，请重试" }); }
    finally { this.setData({ saving: false }); }
  },
  async onLogout(): Promise<void> {
    const confirmed = await new Promise<boolean>((resolve) => wx.showModal({ title: "退出登录", content: "清除本机登录状态；家庭库存与本账号草稿仍保留。", success: (result) => resolve(result.confirm), fail: () => resolve(false) }));
    if (!confirmed) return;
    try { await logout(); } catch (error) {
      if (error instanceof ApiError && error.code === "STALE_SESSION") return;
      // Current-session logout still returns to welcome when the network fails.
    }
    wx.reLaunch({ url: "/pages/login/login" });
  },
});
