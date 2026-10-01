import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import type { MedicationPlanSummary, PlanHistoryRecord } from "../../services/api-types";

/**
 * 计划详情（R3-b）：查看计划、服药历史与纠正记录，并可改期／调整时间点／暂停／结束。
 * - 历史来自确认事件：一次确认可能被纠正多次，事件全部保留，只以最新状态展示；
 * - 编辑只影响之后的安排，已物化的历史记录不会被改写；
 * - 版本冲突提示刷新，不覆盖他人修改。
 */

const WEEKDAY_LABELS: Record<string, string> = {
  mon: "一", tue: "二", wed: "三", thu: "四", fri: "五", sat: "六", sun: "日",
};

interface HistoryCard extends PlanHistoryRecord {
  statusLabel: string;
  eventText: string;
}

interface PlanDetailPageData {
  planId: string;
  loading: boolean;
  errorMessage: string;
  plan: MedicationPlanSummary | null;
  canManage: boolean;
  statusLabel: string;
  weekdayText: string;
  rangeText: string;
  history: HistoryCard[];
  historyEmpty: boolean;
  editing: boolean;
  dosageText: string;
  startDate: string;
  endDate: string;
  timeSlots: string[];
  timeInput: string;
  saving: boolean;
  working: boolean;
  note: string;
}

function toHistoryCard(record: PlanHistoryRecord): HistoryCard {
  const labels: Record<string, string> = { pending: "未确认", taken: "已服用", skipped: "本次跳过" };
  return {
    ...record,
    statusLabel: labels[record.status] ?? "未确认",
    eventText: record.events.length === 0
      ? "还没有确认记录"
      : record.events.map((event) => `${event.action === "taken" ? "已服用" : "跳过"} · ${event.actor ?? "家人"}`).join(" → "),
  };
}

Page({
  data: {
    planId: "",
    loading: false,
    errorMessage: "",
    plan: null,
    canManage: false,
    statusLabel: "",
    weekdayText: "",
    rangeText: "",
    history: [] as HistoryCard[],
    historyEmpty: false,
    editing: false,
    dosageText: "",
    startDate: "",
    endDate: "",
    timeSlots: [] as string[],
    timeInput: "",
    saving: false,
    working: false,
    note: "",
  } as PlanDetailPageData,

  async onLoad(options: { planId?: string }): Promise<void> {
    this.setData({ planId: options.planId ?? "" });
    await this.refresh();
  },

  async refresh(): Promise<void> {
    const planId = (this.data as PlanDetailPageData).planId;
    if (planId === "") {
      this.setData({ errorMessage: "缺少计划标识，请从用药计划页进入" });
      return;
    }
    this.setData({ loading: true, errorMessage: "" });
    try {
      await ensureLoggedIn();
      const [detail, history] = await Promise.all([
        api.getMedicationPlan(planId),
        api.getMedicationPlanHistory(planId),
      ]);
      const plan = detail.plan;
      this.setData({
        plan,
        canManage: detail.canManage,
        statusLabel: plan.status === "active" ? "进行中" : plan.status === "paused" ? "已暂停" : "已结束",
        weekdayText: plan.weekdays.length === 7
          ? "每天"
          : plan.weekdays.map((day) => WEEKDAY_LABELS[day] ?? day).join("、"),
        rangeText: `${plan.startDate}${plan.endDate === null ? " 起（长期）" : ` 至 ${plan.endDate}`}`,
        history: history.history.map(toHistoryCard),
        historyEmpty: history.history.length === 0,
        dosageText: plan.dosageText,
        startDate: plan.startDate,
        endDate: plan.endDate ?? "",
        timeSlots: [...plan.timeSlots],
        loading: false,
      });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "加载失败，请重试";
      this.setData({ loading: false, errorMessage: message });
    }
  },

  onStartEdit(): void {
    if (!(this.data as PlanDetailPageData).canManage) {
      wx.showToast({ title: "你对该计划只有查看权限", icon: "none" });
      return;
    }
    this.setData({ editing: true });
  },

  onCancelEdit(): void {
    const plan = (this.data as PlanDetailPageData).plan;
    if (plan === null) return;
    this.setData({
      editing: false,
      dosageText: plan.dosageText,
      startDate: plan.startDate,
      endDate: plan.endDate ?? "",
      timeSlots: [...plan.timeSlots],
      timeInput: "",
    });
  },

  onEditInput(event: { currentTarget: { dataset: { field?: string } }; detail: { value: string } }): void {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [field]: event.detail.value });
  },

  onEditDateChange(event: { currentTarget: { dataset: { field?: string } }; detail: { value: string } }): void {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [field]: event.detail.value });
  },

  onAddTimeSlot(): void {
    const data = this.data as PlanDetailPageData;
    const raw = data.timeInput.trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) {
      wx.showToast({ title: "时间格式需为 HH:MM，例如 08:00", icon: "none" });
      return;
    }
    if (data.timeSlots.includes(raw)) {
      wx.showToast({ title: "该时间点已添加", icon: "none" });
      return;
    }
    if (data.timeSlots.length >= 6) {
      wx.showToast({ title: "每日最多 6 个时间点", icon: "none" });
      return;
    }
    this.setData({ timeSlots: [...data.timeSlots, raw].sort(), timeInput: "" });
  },

  onRemoveTimeSlot(event: { currentTarget: { dataset: { time?: string } } }): void {
    const time = event.currentTarget.dataset.time;
    if (!time) return;
    this.setData({ timeSlots: (this.data as PlanDetailPageData).timeSlots.filter((item) => item !== time) });
  },

  async onSubmitEdit(): Promise<void> {
    const data = this.data as PlanDetailPageData;
    if (data.saving || data.plan === null) return;
    const dosageText = data.dosageText.trim();
    if (dosageText === "") { wx.showToast({ title: "请填写剂量说明", icon: "none" }); return; }
    if (data.timeSlots.length === 0) { wx.showToast({ title: "请至少保留一个时间点", icon: "none" }); return; }
    if (data.endDate !== "" && data.endDate < data.startDate) {
      wx.showToast({ title: "结束日期不能早于开始日期", icon: "none" });
      return;
    }
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: "保存修改",
        content: "修改只影响之后的安排；已有服药记录保持原样。",
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    this.setData({ saving: true });
    try {
      await ensureLoggedIn();
      const result = await api.updateMedicationPlan(data.plan.id, {
        version: data.plan.version,
        dosageText,
        timeSlots: data.timeSlots,
        startDate: data.startDate,
        endDate: data.endDate === "" ? null : data.endDate,
      });
      this.setData({ editing: false, saving: false, note: result.note });
      await this.refresh();
      wx.showToast({ title: "已保存", icon: "success" });
    } catch (error) {
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        wx.showToast({ title: "计划已被他人修改，已刷新", icon: "none", duration: 2800 });
        this.setData({ editing: false, saving: false });
        await this.refresh();
      } else {
        wx.showToast({ title: error instanceof ApiError ? error.message : "保存失败", icon: "none", duration: 2800 });
        this.setData({ saving: false });
      }
    }
  },

  async onChangeStatus(event: { currentTarget: { dataset: { action?: string } } }): Promise<void> {
    const data = this.data as PlanDetailPageData;
    const action = event.currentTarget.dataset.action;
    if (data.plan === null || data.working) return;
    if (!data.canManage) {
      wx.showToast({ title: "你对该计划只有查看权限", icon: "none" });
      return;
    }
    if (action !== "pause" && action !== "resume" && action !== "end") return;
    if (data.plan.status === "ended") {
      wx.showToast({ title: "已结束的计划不能恢复，请新建计划", icon: "none" });
      return;
    }
    const label = action === "pause" ? "暂停" : action === "resume" ? "恢复" : "结束";
    const content = action === "pause"
      ? "暂停后不再生成新的服药安排；已有记录保留。"
      : action === "resume" ? "恢复后将继续生成之后的安排。" : "结束后不再出现在进行中的计划里；历史记录保留。";
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({ title: `${label}计划`, content, success: (result) => resolve(result.confirm), fail: () => resolve(false) });
    });
    if (!confirmed) return;
    this.setData({ working: true });
    try {
      await ensureLoggedIn();
      await api.changeMedicationPlanStatus(data.plan.id, action, data.plan.version);
      await this.refresh();
      wx.showToast({ title: `已${label}`, icon: "success" });
    } catch (error) {
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        wx.showToast({ title: "计划已被他人修改，已刷新", icon: "none", duration: 2800 });
        await this.refresh();
      } else {
        wx.showToast({ title: error instanceof ApiError ? error.message : "操作失败", icon: "none", duration: 2800 });
      }
    } finally {
      this.setData({ working: false });
    }
  },

  onBack(): void {
    wx.navigateBack();
  },
});
