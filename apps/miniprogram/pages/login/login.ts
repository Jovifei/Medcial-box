import { ApiError } from "../../services/api";
import { loginWithWechat } from "../../services/auth";

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
    submitting: false,
    errorMessage: "",
  },

  redirectPath: "",
  invitationCode: "",

  onLoad(options: Record<string, string | undefined>): void {
    this.redirectPath = decode(options.redirect);
    this.invitationCode = decode(options.code).trim();
  },

  async onLogin(): Promise<void> {
    const data = this.data as LoginPageData;
    if (data.submitting) return;
    this.setData({ submitting: true, errorMessage: "" });
    try {
      const session = await loginWithWechat();
      const target = session.hasFamily ? "/pages/index/index" : "/pages/family-entry/family-entry";
      const path = this.redirectPath !== "" && this.redirectPath.startsWith("/pages/") ? this.redirectPath : target;
      const separator = path.includes("?") ? "&" : "?";
      const withCode = this.invitationCode === "" ? path : `${path}${separator}code=${encodeURIComponent(this.invitationCode)}`;
      wx.reLaunch({ url: withCode });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "登录失败，请稍后重试";
      this.setData({ errorMessage: message });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
