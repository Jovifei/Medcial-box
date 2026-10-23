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
  authEpoch: 0,

  onLoad(options: Record<string, string | undefined>): void {
    this.redirectPath = decode(options.redirect);
    this.invitationCode = decode(options.code).trim();
    if (readToken() !== "") void this.restoreSession();
  },

  onUnload(): void { this.authEpoch += 1; },

  onExplore(): void { this.setData({ guestExpanded: !this.data.guestExpanded }); },
  async restoreSession(): Promise<void> {
    const epoch = this.authEpoch;
    try {
      await ensureLoggedIn({ allowInteractive: false });
      if (epoch !== this.authEpoch) return;
      const me = await api.getAuthMe();
      if (epoch !== this.authEpoch) return;
      const target = this.invitationCode ? `/pages/invite/invite?code=${encodeURIComponent(this.invitationCode)}` : this.redirectPath.startsWith("/pages/") ? this.redirectPath : me.family ? "/pages/index/index" : "/pages/family-entry/family-entry";
      wx.reLaunch({ url: target });
    } catch {
      if (epoch === this.authEpoch) this.setData({ errorMessage: "未能恢复登录；请检查网络后重试微信登录。" });
    }
  },
  async onLogin(): Promise<void> {
    const data = this.data as LoginPageData;
    if (data.submitting) return;
    const epoch = ++this.authEpoch;
    this.setData({ submitting: true, errorMessage: "" });
    try {
      const session = await loginWithWechat();
      if (epoch !== this.authEpoch) return;
      const target = session.hasFamily ? "/pages/index/index" : "/pages/family-entry/family-entry";
      const path = this.invitationCode ? "/pages/invite/invite" : this.redirectPath !== "" && this.redirectPath.startsWith("/pages/") ? this.redirectPath : target;
      const separator = path.includes("?") ? "&" : "?";
      const withCode = this.invitationCode === "" ? path : `${path}${separator}code=${encodeURIComponent(this.invitationCode)}`;
      wx.reLaunch({ url: withCode });
    } catch (error) {
      if (epoch !== this.authEpoch) return;
      const message = error instanceof ApiError && error.statusCode !== 401 ? error.message : "登录没有完成，请检查网络后重新点击微信登录；仍失败可稍后重试。";
      this.setData({ errorMessage: message });
    } finally {
      if (epoch === this.authEpoch) this.setData({ submitting: false });
    }
  },
});