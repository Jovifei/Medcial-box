import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import type { AuditEventSummary } from "../../services/api-types";

interface AuditView extends AuditEventSummary { changeText: string; actorLabel: string }

Page({
  data: { loading: true, events: [] as AuditView[], errorMessage: "" },
  onShow(): void { void this.refresh(); },
  onPullDownRefresh(): void { void this.refresh().finally(() => wx.stopPullDownRefresh()); },
  async refresh(): Promise<void> {
    this.setData({ loading: true, errorMessage: "" });
    try {
      await ensureLoggedIn();
      const result = await api.listAuditEvents();
      const events = result.events.map((event) => ({ ...event, actorLabel: event.actorName ?? "家庭成员", changeText: Object.entries(event.changes)
        .map(([key, value]) => `${key}：${typeof value === "string" ? value : JSON.stringify(value)}`)
        .join("；") || "未提供字段明细" }));
      this.setData({ events });
    } catch (error) {
      this.setData({ errorMessage: error instanceof ApiError ? error.message : "暂时无法读取家庭变更记录" });
    } finally { this.setData({ loading: false }); }
  },
});
