import { peekDirtyDraft } from "../../services/draft-guard";

type Tab = "index" | "plans" | "pending" | "mine";
const PRIMARY_TABS: Record<string, Tab> = {
  "pages/index/index": "index",
  "pages/medication-plans/medication-plans": "plans",
  "pages/pending/pending": "pending",
  "pages/mine/mine": "mine",
};
const ROUTE_TABS: Record<string, Tab> = {
  ...PRIMARY_TABS,
  "pages/login/login": "mine",
  "pages/family-entry/family-entry": "mine",
  "pages/family-create/family-create": "mine",
  "pages/medicine-edit/medicine-edit": "index",
  "pages/medicine-detail/medicine-detail": "index",
  "pages/batch-edit/batch-edit": "index",
  "pages/export-preview/export-preview": "mine",
  "pages/invite/invite": "mine",
  "pages/plan-detail/plan-detail": "plans",
  "pages/plan-create/plan-create": "plans",
  "pages/release-notes/release-notes": "mine",
  "pages/care-profiles/care-profiles": "mine",
  "pages/family-settings/family-settings": "mine",
  "pages/app-link/app-link": "mine",
  "pages/stocktake/stocktake": "index",
  "pages/restock/restock": "mine",
  "pages/trash/trash": "mine",
  "pages/audit/audit": "mine",
  "pages/backup-restore/backup-restore": "mine",
  "pages/notification-settings/notification-settings": "mine",
  "pages/account-settings/account-settings": "mine",
};

Component({
  properties: { embedded: { type: Boolean, value: false } },
  data: {
    busy: false,
    activeTab: "index",
  },
  lifetimes: {
    attached() {
      this.updateActiveTab();
    },
  },
  pageLifetimes: {
    show() {
      this.updateActiveTab();
    },
  },
  methods: {
    updateActiveTab(): void {
      try {
        const pages = getCurrentPages();
        for (let index = pages.length - 1; index >= 0; index--) {
          const tab = PRIMARY_TABS[pages[index]?.route ?? ""];
          if (tab) {
            this.setData({ activeTab: tab });
            return;
          }
        }
        const route = pages[pages.length - 1]?.route ?? "";
        this.setData({ activeTab: ROUTE_TABS[route] ?? "index" });
      } catch {
        this.setData({ activeTab: "index" });
      }
    },
    async navigate(url: string, tab: boolean): Promise<void> {
      if (this.data.busy) return;
      this.setData({ busy: true });
      try {
        const draft = peekDirtyDraft();
        if (draft) {
          const save = await new Promise<boolean>((resolve) =>
            wx.showModal({
              title: "保留未保存输入",
              content: "保存当前草稿后离开？取消会留在本页。",
              success: (result) => resolve(result.confirm),
              fail: () => resolve(false),
            })
          );
          if (!save) return;
          await draft.save();
        }
        const options = { url, fail: () => wx.showToast({ title: "暂时无法打开，请重试", icon: "none" as const }) };
        if (tab) wx.switchTab(options);
        else wx.navigateTo(options);
      } catch {
        wx.showToast({ title: "草稿未能保存，请留在本页重试", icon: "none" });
      } finally {
        this.setData({ busy: false });
      }
    },
    async go(event: { currentTarget: { dataset: { url: string } } }): Promise<void> {
      await this.navigate(event.currentTarget.dataset.url, true);
    },
    async choose(): Promise<void> {
      await this.navigate("/pages/family-entry/family-entry", false);
    },
  },
});
