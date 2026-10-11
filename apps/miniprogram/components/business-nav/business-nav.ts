import { peekDirtyDraft } from "../../services/draft-guard";
Component({
  data: { busy: false },
  methods: {
    async go(event: { currentTarget: { dataset: { url: string } } }): Promise<void> {
      if (this.data.busy) return;
      this.setData({ busy: true });
      try {
        const draft = peekDirtyDraft();
        if (draft) {
          const save = await new Promise<boolean>(resolve => wx.showModal({ title: "保留未保存输入", content: "保存当前草稿后离开？取消会留在本页。", success: result => resolve(result.confirm), fail: () => resolve(false) }));
          if (!save) return;
          await draft.save();
        }
        wx.switchTab({ url: event.currentTarget.dataset.url, fail: () => wx.showToast({ title: "暂时无法打开，请重试", icon: "none" }) });
      } catch { wx.showToast({ title: "草稿未能保存，请留在本页重试", icon: "none" }); }
      finally { this.setData({ busy: false }); }
    },
    choose(): void { wx.navigateTo({ url: "/pages/family-entry/family-entry" }); },
  },
});
