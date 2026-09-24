// 邀请页（P2 家庭共享 + 2026-09-24 决策更新 D2/D3）：
// - owner：生成一次性文本邀请码（72 小时）→ "转发给微信好友"（onShareAppMessage 携带
//   邀请码参数，家人点卡片直达本页自动填充）+ 复制文本邀请码兜底；
// - 无家庭用户：点分享卡片进入自动填充邀请码，或手动粘贴加入；
// - 普通成员：可自助退出家庭（D3）；owner 可先转让所有权再退出。
import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import type { FamilyMemberSummary } from "../../services/api-types";

type InviteMode = "loading" | "owner" | "join" | "member";

interface MemberView extends FamilyMemberSummary {
  joinedDate: string;
}

interface InvitePageData {
  mode: InviteMode;
  familyName: string;
  invitationCode: string;
  invitationExpiresAt: string;
  inviteInput: string;
  submitting: boolean;
  members: MemberView[];
  leaving: boolean;
}

function showError(error: unknown): void {
  const message = error instanceof ApiError ? error.message : "操作失败，请稍后重试";
  wx.showToast({ title: message, icon: "none", duration: 2800 });
}

function confirmModal(title: string, content: string): Promise<boolean> {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content,
      success: (result) => resolve(result.confirm),
      fail: () => resolve(false),
    });
  });
}

Page({
  data: {
    mode: "loading" as InviteMode,
    familyName: "",
    invitationCode: "",
    invitationExpiresAt: "",
    inviteInput: "",
    submitting: false,
    members: [] as MemberView[],
    leaving: false,
  },

  /** 从分享卡片进入时携带的邀请码（onLoad 早于 onShow 的 refresh）。 */
  pendingCode: "",

  onLoad(options: Record<string, string | undefined>) {
    const raw = typeof options.code === "string" ? options.code : "";
    const code = raw === "" ? "" : decodeURIComponent(raw).trim();
    this.pendingCode = code;
    if (code !== "") this.setData({ inviteInput: code });
  },

  onShow() {
    this.refresh();
  },

  /** owner 已生成邀请码后，转发卡片携带邀请码；家人点卡片直达本页自动填充。 */
  onShareAppMessage() {
    const data = this.data as InvitePageData;
    if (data.invitationCode !== "") {
      return {
        title: `邀请你加入「${data.familyName}」的家庭药箱`,
        path: `/pages/invite/invite?code=${encodeURIComponent(data.invitationCode)}`,
      };
    }
    return { title: "家庭药箱：记录家里的药与有效期", path: "/pages/index/index" };
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
        members: result.family.members.map((member) => ({
          ...member,
          joinedDate: member.joinedAt.slice(0, 10),
        })),
        invitationCode: "",
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "FAMILY_NOT_FOUND") {
        this.setData({ mode: "join", familyName: "", invitationCode: "" });
        if (this.pendingCode !== "") {
          this.setData({ inviteInput: this.pendingCode });
          this.pendingCode = "";
        }
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
      wx.showToast({ title: "已生成，可转发或复制", icon: "none" });
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
          content: "每个账号只能属于一个家庭。如需更换，可先在邀请页使用“退出家庭”，再使用新邀请码；药品不会自动搬移或合并。",
          showCancel: false,
        });
        return;
      }
      showError(error);
    } finally {
      this.setData({ submitting: false });
    }
  },

  /** 成员自助退出（D3）：退出后立即失去访问权限。 */
  async onLeaveFamily(): Promise<void> {
    const data = this.data as InvitePageData;
    if (data.leaving) return;
    const confirmed = await confirmModal(
      "退出家庭",
      `退出后将立即失去「${data.familyName}」药箱的访问权限，重新加入需要新的邀请。确定退出吗？`,
    );
    if (!confirmed) return;
    this.setData({ leaving: true });
    try {
      await api.leaveFamily();
      wx.showToast({ title: "已退出家庭", icon: "success" });
      setTimeout(() => wx.reLaunch({ url: "/pages/index/index" }), 900);
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ leaving: false });
    }
  },

  /** owner 移除成员：移除后该成员立即失去访问权限。 */
  async onRemoveMember(event: { currentTarget: { dataset: { memberId?: string } } }): Promise<void> {
    const memberId = event.currentTarget.dataset.memberId;
    if (typeof memberId !== "string" || memberId === "") return;
    const data = this.data as InvitePageData;
    const target = data.members.find((member) => member.id === memberId);
    const confirmed = await confirmModal(
      "移除成员",
      `${target?.displayName ?? "该成员"}将立即失去「${data.familyName}」药箱的访问权限（其记录与备注保留）。确定移除吗？`,
    );
    if (!confirmed) return;
    try {
      await api.removeMember(memberId);
      wx.showToast({ title: "已移除", icon: "success" });
      await this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  /** owner 转让所有权（D3 配套）：转让后原 owner 变为普通成员，即可自助退出。 */
  async onTransferOwnership(
    event: { currentTarget: { dataset: { memberId?: string } } },
  ): Promise<void> {
    const memberId = event.currentTarget.dataset.memberId;
    if (typeof memberId !== "string" || memberId === "") return;
    const confirmed = await confirmModal(
      "转让所有权",
      "转让后你将变为普通成员，新 owner 负责邀请、移除成员与家庭管理。确定转让吗？",
    );
    if (!confirmed) return;
    try {
      await api.transferOwnership(memberId);
      wx.showToast({ title: "已转让，你现在是普通成员", icon: "none" });
      await this.refresh();
    } catch (error) {
      showError(error);
    }
  },
});
