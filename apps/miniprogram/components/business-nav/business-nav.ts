import { peekDirtyDraft } from "../../services/draft-guard";

Component({
  properties: { embedded: { type: Boolean, value: false } },
  data: {
    busy: false,
    activeTab: "index",
  },
  lifetimes: {
    attached() {
      try {
        const pages = getCurrentPages();
        const current = pages[pages.length - 1];
        const route = current ? current.route : "";
        if (route.includes("plan")) {
          this.setData({ activeTab: "plans" });
        } else if (route.includes("pending")) {
          this.setData({ activeTab: "pending" });
        } else if (route.includes("mine") || route.includes("setting") || route.includes("care-profile") || route.includes("family")) {
          this.setData({ activeTab: "mine" });
        } else {
          this.setData({ activeTab: "index" });
        }
      } catch {
        this.setData({ activeTab: "index" });
      }
    },
  },
  methods: {
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
