import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";

interface InvitationPreview {
  familyName: string;
  expiresAt: string;
}

interface FamilyEntryPageData {
  inviteInput: string;
  preview: InvitationPreview | null;
  previewing: boolean;
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

function loginUrl(invitationCode: string): string {
  const code = invitationCode.trim();
  return code === "" ? "/pages/login/login" : `/pages/login/login?code=${encodeURIComponent(code)}`;
}

function showError(page: WechatMiniprogram.Page.Instance<WechatMiniprogram.Page.DataOption, WechatMiniprogram.Page.CustomOption>, error: unknown): void {
  const message = error instanceof ApiError ? error.message : "操作失败，请稍后重试";
  page.setData({ errorMessage: message });
}

Page({
  data: {
    inviteInput: "",
    preview: null as InvitationPreview | null,
    previewing: false,
    submitting: false,
    errorMessage: "",
  },

  onLoad(options: Record<string, string | undefined>): void {
    const code = decode(options.code).trim();
    if (code !== "") this.setData({ inviteInput: code });
  },

  onShow(): void {
    this.refresh();
  },

  async refresh(): Promise<void> {
    try {
      await ensureLoggedIn({ allowInteractive: false });
      const result = await api.getCurrentFamily();
      if (result.family !== undefined) wx.reLaunch({ url: "/pages/index/index" });
    } catch (error) {
      if (error instanceof ApiError && error.code === "FAMILY_NOT_FOUND") return;
      if (error instanceof ApiError && (error.statusCode === 401 || error.code === "UNAUTHENTICATED")) {
        wx.reLaunch({ url: loginUrl((this.data as FamilyEntryPageData).inviteInput) });
        return;
      }
      showError(this, error);
    }
  },

  onInviteInput(event: { detail: { value: string } }): void {
    this.setData({ inviteInput: event.detail.value, preview: null, errorMessage: "" });
  },

  async onPreviewInvitation(): Promise<void> {
    const code = (this.data as FamilyEntryPageData).inviteInput.trim();
    if (code === "") {
      this.setData({ errorMessage: "请先粘贴邀请码" });
      return;
    }
    if ((this.data as FamilyEntryPageData).previewing) return;
    this.setData({ previewing: true, errorMessage: "" });
    try {
      await ensureLoggedIn({ allowInteractive: false });
      const result = await api.previewInvitation(code);
      this.setData({
        preview: { familyName: result.family.name, expiresAt: result.expiresAt.slice(0, 16).replace("T", " ") },
      });
    } catch (error) {
      if (error instanceof ApiError && (error.statusCode === 401 || error.code === "UNAUTHENTICATED")) {
        wx.reLaunch({ url: loginUrl(code) });
        return;
      }
      showError(this, error);
    } finally {
      this.setData({ previewing: false });
    }
  },

  async onAcceptInvitation(): Promise<void> {
    const data = this.data as FamilyEntryPageData;
    const code = data.inviteInput.trim();
    if (code === "") {
      this.setData({ errorMessage: "请先粘贴邀请码" });
      return;
    }
    if (data.submitting) return;
    if (data.preview === null) {
      await this.onPreviewInvitation();
      return;
    }
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: "确认加入家庭",
        content: `将加入「${data.preview?.familyName ?? "该家庭"}」。邀请码使用后不能再次使用，确定加入吗？`,
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    this.setData({ submitting: true, errorMessage: "" });
    try {
      await ensureLoggedIn({ allowInteractive: false });
      const result = await api.acceptInvitation(code);
      wx.showToast({ title: `已加入 ${result.family.name}`, icon: "success" });
      setTimeout(() => wx.reLaunch({ url: "/pages/index/index" }), 700);
    } catch (error) {
      showError(this, error);
    } finally {
      this.setData({ submitting: false });
    }
  },

  onCreateFamily(): void {
    wx.navigateTo({ url: "/pages/family-create/family-create" });
  },
});
