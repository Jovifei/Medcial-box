// 邀请页（P2 家庭共享）：
// - owner：生成一次性文本邀请码（72 小时有效）并展示复制；
// - 无家庭用户：粘贴邀请码加入；
// - 已在家庭的普通成员：提示"邀请由 owner 管理；如需更换家庭需先由 owner 移除"。
import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";

type InviteMode = "loading" | "owner" | "join" | "member";

interface InvitePageData {
  mode: InviteMode;
  familyName: string;
  invitationCode: string;
  invitationExpiresAt: string;
  inviteInput: string;
  submitting: boolean;
}

function showError(error: unknown): void {
  const message = error instanceof ApiError ? error.message : "操作失败，请稍后重试";
  wx.showToast({ title: message, icon: "none", duration: 2800 });
}

Page({
  data: {
    mode: "loading" as InviteMode,
    familyName: "",
    invitationCode: "",
    invitationExpiresAt: "",
    inviteInput: "",
    submitting: false,
  },

  onShow() {
    this.refresh();
  },

  async refresh(): Promise<void> {
    try {
      await ensureLoggedIn();
    } catch (error) {
      showError(error);
      return;
    }
    try {
      const result = await api.getCurrentFamily();
      this.setData({
        mode: result.family.role === "owner" ? "owner" : "member",
        familyName: result.family.name,
        invitationCode: "",
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "FAMILY_NOT_FOUND") {
        this.setData({ mode: "join", familyName: "", invitationCode: "" });
        return;
      }
      showError(error);
    }
  },

  async onCreateInvitation(): Promise<void> {
    const data = this.data as InvitePageData;
    if (data.submitting) return;
    this.setData({ submitting: true });
    try {
      const result = await api.createInvitation();
      this.setData({
        invitationCode: result.invitationCode,
        invitationExpiresAt: result.expiresAt,
      });
      wx.showToast({ title: "已生成，72 小时内有效", icon: "none" });
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ submitting: false });
    }
  },

  async onCopyInvitation(): Promise<void> {
    const code = (this.data as InvitePageData).invitationCode;
    if (code === "") return;
    try {
      await new Promise<void>((resolve, reject) => {
        wx.setClipboardData({
          data: code,
          success: () => resolve(),
          fail: (result) => reject(new Error(result.errMsg ?? "复制失败")),
        });
      });
      wx.showToast({ title: "邀请码已复制", icon: "success" });
    } catch (error) {
      showError(error);
    }
  },

  onInviteInput(event: { detail: { value: string } }): void {
    this.setData({ inviteInput: event.detail.value });
  },

  async onAcceptInvitation(): Promise<void> {
    const data = this.data as InvitePageData;
    const code = data.inviteInput.trim();
    if (code === "") {
      wx.showToast({ title: "请先粘贴邀请码", icon: "none" });
      return;
    }
    if (data.submitting) return;
    this.setData({ submitting: true });
    try {
      await ensureLoggedIn();
      const result = await api.acceptInvitation(code);
      wx.showToast({ title: `已加入 ${result.family.name}`, icon: "success" });
      setTimeout(() => wx.reLaunch({ url: "/pages/index/index" }), 900);
    } catch (error) {
      if (error instanceof ApiError && error.code === "ALREADY_IN_FAMILY") {
        wx.showModal({
          title: "已在家庭中",
          content: "每个账号只能属于一个家庭。如需更换，请先由当前家庭的 owner 移除你，再使用新邀请码；药品不会自动搬移或合并。",
          showCancel: false,
        });
        return;
      }
      showError(error);
    } finally {
      this.setData({ submitting: false });
    }
  },
});
