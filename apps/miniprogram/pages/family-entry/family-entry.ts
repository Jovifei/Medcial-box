import { api, ApiError, captureSessionIdentity, isCurrentSession } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";

interface InvitationPreview {
  code: string;
  familyName: string;
  expiresAt: string;
}

interface FamilyEntryPageData {
  inviteInput: string;
  preview: InvitationPreview | null;
  previewing: boolean;
  submitting: boolean;
  errorMessage: string;
  families: { familyId: string; name: string; role: string; isCurrent: boolean }[];
  /** 58号设计：创建/加入区的页面内展开状态；不持久化、不写存储。 */
  addExpanded: boolean;
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
    families: [] as { familyId: string; name: string; role: string; isCurrent: boolean }[],
    addExpanded: false,
  },

  /** 用户手动展开/收起后，onShow 的自动规则不再覆盖本次访问的选择。 */
  addExpandedManually: false,

  onLoad(options: Record<string, string | undefined>): void {
    const code = decode(options.code).trim();
    if (code !== "") this.setData({ inviteInput: code });
  },

  onToggleAdd(): void {
    const data = this.data as FamilyEntryPageData;
    // 58号设计：邀请码已填/预览已出/有错误时，展开区不得被折叠遮住。
    if (data.addExpanded && (data.inviteInput.trim() !== "" || data.preview !== null || data.errorMessage !== "")) {
      wx.showToast({ title: "邀请码操作未完成，暂不能收起", icon: "none" });
      return;
    }
    this.addExpandedManually = true;
    this.setData({ addExpanded: !data.addExpanded });
  },

  onShow(): void {
    this.refresh();
  },

  async refresh(): Promise<void> {
    try {
      await ensureLoggedIn({ allowInteractive: false });
      const result = await api.listFamilies();
      this.setData({ families: result.families });
      this.applyAddExpandedRule();
      if (this.data.inviteInput !== "") await this.onPreviewInvitation();
    } catch (error) {
      if (error instanceof ApiError && error.code === "FAMILY_NOT_FOUND") return;
      if (error instanceof ApiError && (error.statusCode === 401 || error.code === "UNAUTHENTICATED")) {
        wx.reLaunch({ url: loginUrl((this.data as FamilyEntryPageData).inviteInput) });
        return;
      }
      showError(this, error);
    }
  },

  /**
   * 58号设计：无家庭、邀请码已填、预览已出现或有错误时展开创建/加入区；
   * 已有家庭的默认态收起（家庭列表优先）。手动展开在本次访问内不被覆盖。
   */
  applyAddExpandedRule(): void {
    const data = this.data as FamilyEntryPageData;
    const expanded = this.addExpandedManually === true || data.families.length === 0 ||
      data.inviteInput.trim() !== "" || data.preview !== null || data.errorMessage !== "";
    this.setData({ addExpanded: expanded });
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
      if (this.data.inviteInput.trim() !== code) return;
      this.setData({
        preview: { code, familyName: result.family.name, expiresAt: result.expiresAt.slice(0, 16).replace("T", " ") },
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
    if (data.preview === null || data.preview.code !== code) {
      await this.onPreviewInvitation();
      return;
    }
    const identity = captureSessionIdentity();
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: "确认加入家庭",
        content: `将加入「${data.preview?.familyName ?? "该家庭"}」。邀请码使用后不能再次使用，确定加入吗？`,
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed || !isCurrentSession(identity) || this.data.inviteInput.trim() !== code) return;
    this.setData({ submitting: true, errorMessage: "" });
    try {
      await ensureLoggedIn({ allowInteractive: false });
      if (!isCurrentSession(identity) || this.data.inviteInput.trim() !== code) return;
      const result = await api.acceptInvitation(code);
      wx.showToast({ title: `已加入 ${result.family.name}`, icon: "success" });
      const selected = captureSessionIdentity();
      setTimeout(() => { if (isCurrentSession(selected)) wx.switchTab({ url: "/pages/index/index" }); }, 700);
    } catch (error) {
      showError(this, error);
    } finally {
      this.setData({ submitting: false });
    }
  },

  async onSwitchFamily(event: { currentTarget: { dataset: { familyId: string } } }): Promise<void> {
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      await api.switchFamily(event.currentTarget.dataset.familyId);
      await ensureLoggedIn({ allowInteractive: false });
      wx.switchTab({ url: "/pages/index/index" });
    } catch (error) { showError(this, error); }
    finally { this.setData({ submitting: false }); }
  },
  onCreateFamily(): void {
    wx.navigateTo({ url: "/pages/family-create/family-create" });
  },
});
