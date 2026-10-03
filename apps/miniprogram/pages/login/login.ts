import { api, ApiError, readToken } from "../../services/api";
import { ensureLoggedIn, loginWithWechat } from "../../services/auth";

interface LoginPageData {
  submitting: boolean;
  errorMessage: string;
}

function decode(value: string | undefined): string {
  if (typeof value !== "string" || value === "") return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

Page({
  data: {
    guestExpanded: false,
    submitting: false,
    errorMessage: "",
  },

  redirectPath: "",
  invitationCode: "",

  onLoad(options: Record<string, string | undefined>): void {
    this.redirectPath = decode(options.redirect);
    this.invitationCode = decode(options.code).trim();
    if (readToken() !== "") void this.restoreSession();
  },

  onExplore(): void { this.setData({ guestExpanded: !this.data.guestExpanded }); },
  async restoreSession(): Promise<void> {
    try { await ensureLoggedIn({ allowInteractive: false }); const me = await api.getAuthMe(); const target = this.invitationCode ? `/pages/invite/invite?code=${encodeURIComponent(this.invitationCode)}` : this.redirectPath.startsWith("/pages/") ? this.redirectPath : me.family ? "/pages/index/index" : "/pages/family-entry/family-entry"; wx.reLaunch({ url: target }); }
    catch { this.setData({ errorMessage: "未能恢复登录；请检查网络后重试微信登录。" }); }
  },
  async onLogin(): Promise<void> {
    const data = this.data as LoginPageData;
    if (data.submitting) return;
    this.setData({ submitting: true, errorMessage: "" });
    try {
      const session = await loginWithWechat();
      const target = session.hasFamily ? "/pages/index/index" : "/pages/family-entry/family-entry";
      const path = this.invitationCode ? "/pages/invite/invite" : this.redirectPath !== "" && this.redirectPath.startsWith("/pages/") ? this.redirectPath : target;
      const separator = path.includes("?") ? "&" : "?";
      const withCode = this.invitationCode === "" ? path : `${path}${separator}code=${encodeURIComponent(this.invitationCode)}`;
      wx.reLaunch({ url: withCode });
    } catch (error) {
      const message = error instanceof ApiError && error.statusCode !== 401 ? error.message : "登录没有完成，请检查网络后重新点击微信登录；仍失败可稍后重试。";
      this.setData({ errorMessage: message });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
