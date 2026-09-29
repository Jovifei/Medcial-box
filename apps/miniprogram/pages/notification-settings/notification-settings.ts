import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import type { NotificationTemplateSummary, PendingNotificationSummary } from "../../services/api-types";

interface SubscribeResult { errMsg?: string; [templateId: string]: string | undefined }
interface SubscribeOptions {
  tmplIds: string[];
  success?: (result: SubscribeResult) => void;
  fail?: (error: { errMsg?: string }) => void;
  complete?: () => void;
}
interface SubscribeCapableWx { requestSubscribeMessage?: (options: SubscribeOptions) => void }

Page({
  data: {
    loading: true,
    subscribing: false,
    templates: [] as NotificationTemplateSummary[],
    notifications: [] as PendingNotificationSummary[],
    platformAvailable: false,
    canSubscribe: false,
    statusText: "",
    errorMessage: "",
  },
  onShow(): void { void this.refresh(); },

  async refresh(): Promise<void> {
    this.setData({ loading: true, errorMessage: "" });
    try {
      await ensureLoggedIn();
      const [templateResult, pending] = await Promise.all([
        api.getNotificationTemplates(), api.getPendingNotifications(),
      ]);
      const templates = templateResult.templates;
      this.setData({
        templates,
        notifications: pending.items,
        platformAvailable: templateResult.available,
        canSubscribe: templateResult.available && templates.some((template) => template.available),
        statusText: templateResult.available
          ? "可以在你主动点击后请求微信授权；每次送达仍取决于微信授权和平台规则。"
          : templateResult.reason ?? "当前小程序没有可用的提醒模板，暂不能开启微信通知。待处理列表仍可查看。",
      });
    } catch (error) {
      this.setData({ errorMessage: error instanceof ApiError ? error.message : "暂时无法读取提醒设置" });
    } finally {
      this.setData({ loading: false });
    }
  },

  onTapSubscribe(): void {
    const templates = this.data.templates as NotificationTemplateSummary[];
    const eligibleIds = templates.filter((template) => template.available).map((template) => template.templateId).slice(0, 3);
    if (eligibleIds.length === 0) {
      wx.showToast({ title: "当前没有可用的提醒模板", icon: "none" });
      return;
    }
    if (this.data.subscribing) return;
    const native = wx as unknown as SubscribeCapableWx;
    if (typeof native.requestSubscribeMessage !== "function") {
      this.setData({ statusText: "当前微信版本不支持订阅消息，请使用待处理列表查看。" });
      return;
    }
    this.setData({ subscribing: true, statusText: "等待微信授权…" });
    native.requestSubscribeMessage.call(wx, {
      tmplIds: eligibleIds,
      success: (result) => { void this.persistAcceptedSubscriptions(eligibleIds, result); },
      fail: (error) => {
        const cancelled = (error.errMsg ?? "").includes("cancel");
        this.setData({ statusText: cancelled ? "你取消了授权；待处理列表仍可查看。" : "微信授权未完成，请稍后重试。", subscribing: false });
      },
      complete: () => {},
    });
  },

  async persistAcceptedSubscriptions(ids: string[], result: SubscribeResult): Promise<void> {
    const accepted = ids.filter((id) => result[id] === "accept");
    if (accepted.length === 0) {
      this.setData({ statusText: "没有模板获得授权；待处理列表仍可查看。", subscribing: false });
      return;
    }
    try {
      await ensureLoggedIn();
      const saved = await api.subscribeToNotifications(accepted);
      const confirmed = saved.acceptedTemplateIds.length > 0;
      this.setData({ statusText: confirmed
        ? "微信返回了接受结果，服务端已记录所选模板 ID；实际送达仍由微信平台控制。"
        : "服务端未确认模板授权，请查看待处理列表。" });
    } catch (error) {
      this.setData({ statusText: error instanceof ApiError ? error.message : "授权已返回，但保存订阅状态失败，请重试。" });
    } finally {
      this.setData({ subscribing: false });
    }
  },

  onOpenPending(): void { wx.switchTab({ url: "/pages/pending/pending" }); },
});
