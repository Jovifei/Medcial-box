import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import type { CareProfileSummary, FamilyMemberSummary } from "../../services/api-types";

/**
 * 照护对象与共享权限（R3）：
 * - 关联自己账号的照护对象 = 私有计划，家人看不到，管理员也没有特权；
 * - 不关联账号（孩子/老人）由创建者管理，可把查看或管理授权给指定家人；
 * - 撤销授权后该成员立刻看不到该对象及其计划，已产生的记录保留。
 */

interface ProfileCard extends CareProfileSummary {
  kindLabel: string;
  accessLabel: string;
  grantsText: string;
  grants: Array<{ memberUserId: string; displayName: string; canManage: boolean }>;
}

interface CareProfilesPageData {
  loading: boolean;
  errorMessage: string;
  profiles: ProfileCard[];
  members: FamilyMemberSummary[];
  memberNames: Array<{ userId: string; displayName: string }>;
  selfUserId: string;
  formVisible: boolean;
  displayName: string;
  linkSelf: boolean;
  saving: boolean;
  grantProfileId: string;
  grantMemberIndex: number;
  grantCanManage: boolean;
  granting: boolean;
  workingProfileId: string;
  note: string;
}

Page({
  data: {
    loading: false,
    errorMessage: "",
    profiles: [] as ProfileCard[],
    members: [] as FamilyMemberSummary[],
    memberNames: [] as Array<{ userId: string; displayName: string }>,
    selfUserId: "",
    formVisible: false,
    displayName: "",
    linkSelf: false,
    saving: false,
    grantProfileId: "",
    grantMemberIndex: 0,
    grantCanManage: false,
    granting: false,
    workingProfileId: "",
    note: "",
  } as CareProfilesPageData,

  onShow(): void {
    this.refresh();
  },

  async refresh(): Promise<void> {
    this.setData({ loading: true, errorMessage: "" });
    try {
      await ensureLoggedIn();
      const [profiles, family] = await Promise.all([api.listCareProfiles(), api.getCurrentFamily()]);
      const members = family.family.members.filter((member) => !member.isSelf);
      const selfUserId = family.family.members.find((member) => member.isSelf)?.userId ?? "";
      const cards: ProfileCard[] = [];
      for (const profile of profiles.careProfiles) {
        let grantsText = "仅本人可见";
        let grants: ProfileCard["grants"] = [];
        if (!profile.isPrivate) {
          const listed = await api.listCareGrants(profile.id).catch(() => ({ grants: [] }));
          grants = listed.grants.map((grant) => ({ memberUserId: grant.memberUserId, displayName: grant.displayName, canManage: grant.canManage }));
          grantsText = grants.length === 0
            ? "仅创建者可见"
            : grants.map((grant) => `${grant.displayName}（${grant.canManage ? "可代记" : "仅查看"}）`).join("、");
        }
        cards.push({
          ...profile,
          kindLabel: profile.isPrivate ? "本人私有" : "家人共用",
          accessLabel: profile.canManage ? "可管理" : "仅查看",
          grantsText,
          grants,
        });
      }
      this.setData({
        profiles: cards,
        members,
        selfUserId,
        memberNames: members.map((member) => ({ userId: member.userId, displayName: member.displayName })),
        loading: false,
      });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "加载失败，请重试";
      this.setData({ loading: false, errorMessage: message });
    }
  },

  onOpenForm(): void {
    this.setData({ formVisible: true, displayName: "", linkSelf: false });
  },

  onCloseForm(): void {
    this.setData({ formVisible: false });
  },

  onNameInput(event: { detail: { value: string } }): void {
    this.setData({ displayName: event.detail.value });
  },

  onLinkSelfChange(event: { detail: { value: boolean } }): void {
    this.setData({ linkSelf: event.detail.value });
  },

  async onSubmit(): Promise<void> {
    const data = this.data as CareProfilesPageData;
    if (data.saving) return;
    const displayName = data.displayName.trim();
    if (displayName === "") {
      wx.showToast({ title: "请填写照护对象名称", icon: "none" });
      return;
    }
    if (data.linkSelf && data.selfUserId === "") {
      wx.showToast({ title: "未取到本人账号，请刷新后重试", icon: "none" });
      return;
    }
    this.setData({ saving: true });
    try {
      await ensureLoggedIn();
      // 勾选"关联我自己的账号"＝本人私有计划；否则是家人共用的照护对象（孩子/老人）。
      await api.createCareProfile(data.linkSelf ? { displayName, linkedUserId: data.selfUserId } : { displayName });
      this.setData({ formVisible: false, saving: false, displayName: "", linkSelf: false });
      await this.refresh();
      wx.showToast({ title: "已创建", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error instanceof ApiError ? error.message : "创建失败", icon: "none", duration: 2800 });
      this.setData({ saving: false });
    }
  },

  onOpenGrant(event: { currentTarget: { dataset: { id?: string } } }): void {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    this.setData({ grantProfileId: id, grantMemberIndex: 0, grantCanManage: false });
  },

  onCloseGrant(): void {
    this.setData({ grantProfileId: "" });
  },

  onGrantMemberChange(event: { detail: { value: string | number } }): void {
    this.setData({ grantMemberIndex: Number(event.detail.value) });
  },

  onGrantManageChange(event: { detail: { value: boolean } }): void {
    this.setData({ grantCanManage: event.detail.value });
  },

  async onSubmitGrant(): Promise<void> {
    const data = this.data as CareProfilesPageData;
    if (data.granting) return;
    const member = data.members[data.grantMemberIndex];
    if (!member) {
      wx.showToast({ title: "请先邀请家人加入家庭", icon: "none" });
      return;
    }
    this.setData({ granting: true });
    try {
      await ensureLoggedIn();
      await api.createCareGrant(data.grantProfileId, { memberUserId: member.userId, canManage: data.grantCanManage });
      this.setData({ grantProfileId: "", granting: false, note: `${member.displayName} 已获得${data.grantCanManage ? "代记" : "查看"}权限` });
      await this.refresh();
      wx.showToast({ title: "已授权", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error instanceof ApiError ? error.message : "授权失败", icon: "none", duration: 2800 });
      this.setData({ granting: false });
    }
  },

  async onRevokeGrant(event: { currentTarget: { dataset: { profile?: string; member?: string; name?: string } } }): Promise<void> {
    const dataset = event.currentTarget.dataset;
    if (!dataset.profile || !dataset.member) return;
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: "撤销授权",
        content: `撤销后 ${dataset.name ?? "该家人"} 立刻看不到这个照护对象的计划；已产生的服药记录保留。`,
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    this.setData({ workingProfileId: dataset.profile });
    try {
      await ensureLoggedIn();
      await api.revokeCareGrant(dataset.profile, dataset.member);
      await this.refresh();
      wx.showToast({ title: "已撤销", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error instanceof ApiError ? error.message : "撤销失败", icon: "none", duration: 2800 });
    } finally {
      this.setData({ workingProfileId: "" });
    }
  },
});
