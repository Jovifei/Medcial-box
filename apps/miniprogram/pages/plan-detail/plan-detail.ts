import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import { clearDirtyDraft, registerDirtyDraft } from "../../services/draft-guard";
import { scopedStorageKey } from "../../services/session-scope";
import type { MedicationPlanSummary, PlanHistoryRecord } from "../../services/api-types";

/**
 * 计划详情（R3-b）：查看计划、服药历史与纠正记录，并可改期／调整时间点／暂停／结束。
 * - 历史来自确认事件：一次确认可能被纠正多次，事件全部保留，只以最新状态展示；
 * - 编辑只影响之后的安排，已物化的历史记录不会被改写；
 * - 版本冲突提示刷新，不覆盖他人修改；
 * - 编辑态有未保存改动时登记草稿守卫（R14）：更新重启／退出页面前先给出保存机会，
 *   保存失败则延期，绝不静默丢弃家人改好的时间安排。
 */

const LEAVE_WARNING = "计划修改有未保存内容，离开会丢失；如需保留请先保存。";

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
  slotText: string;
  rangeText: string;
  history: HistoryCard[];
  historyEmpty: boolean;
  leaveSheetVisible: boolean;
  draftAvailable: boolean;
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
    slotText: "",
    rangeText: "",
    history: [] as HistoryCard[],
    historyEmpty: false,
    leaveSheetVisible: false,
    draftAvailable: false,
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

  /** 编辑态是否有未保存改动；只在 true 时占用草稿守卫与原生离开提示。 */
  dirty: false,
  /** Captured only after the plan's original household is resolved. Never recompute on unload. */
  draftOwnerKey: null as string | null,

  async onLoad(options: { planId?: string }): Promise<void> {
    this.setData({ planId: options.planId ?? "" });
    await this.refresh();
    const key = scopedStorageKey("plan-edit-draft", this.data.planId);
    this.draftOwnerKey = key;
    this.setData({ draftAvailable: key !== null && Boolean(wx.getStorageSync(key)) });
  },

  onUnload(): void {
    if (this.dirty) this.persistLocalDraft();
    this.releaseDraftGuard();
  },

  async refresh(): Promise<void> {
    const data = this.data as PlanDetailPageData;
    const retained = this.dirty ? this.editFields() : null;
    const planId = data.planId;
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
        slotText: plan.timeSlots.join(" / "),
        rangeText: `${plan.startDate}${plan.endDate === null ? " 起（长期）" : ` 至 ${plan.endDate}`}`,
        history: history.history.map(toHistoryCard),
        historyEmpty: history.history.length === 0,
        dosageText: plan.dosageText,
        startDate: plan.startDate,
        endDate: plan.endDate ?? "",
        timeSlots: [...plan.timeSlots],
        loading: false,
      });
      if (retained !== null) this.setData(retained);
      this.updateDirtyState();
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
    this.updateDirtyState();
  },

  onCancelEdit(): void {
    if (this.dirty) { this.setData({ leaveSheetVisible: true }); return; }
    this.discardEdit();
  },

  discardEdit(): void {
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
    this.updateDirtyState();
  },

  onEditInput(event: { currentTarget: { dataset: { field?: string } }; detail: { value: string } }): void {
    if (this.data.saving || this.data.working) return;
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [field]: event.detail.value });
    this.updateDirtyState();
  },

  onEditDateChange(event: { currentTarget: { dataset: { field?: string } }; detail: { value: string } }): void {
    if (this.data.saving || this.data.working) return;
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [field]: event.detail.value });
    this.updateDirtyState();
  },

  onTimeSlotChange(event: { currentTarget: { dataset: { time?: string } }; detail: { value: string } }): void {
    if (this.data.saving || this.data.working) return;
    const previous = event.currentTarget.dataset.time;
    const value = event.detail.value;
    if (!previous || !this.data.timeSlots.includes(previous) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return;
    if (value !== previous && this.data.timeSlots.includes(value)) { wx.showToast({ title: "该时间点已添加", icon: "none" }); return; }
    this.setData({ timeSlots: this.data.timeSlots.map((time: string) => time === previous ? value : time).sort() });
    this.updateDirtyState();
  },

  onAddTimeSlot(): void {
    if (this.data.saving || this.data.working) return;
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
    this.updateDirtyState();
  },

  onRemoveTimeSlot(event: { currentTarget: { dataset: { time?: string } } }): void {
    if (this.data.saving || this.data.working) return;
    const time = event.currentTarget.dataset.time;
    if (!time) return;
    this.setData({ timeSlots: (this.data as PlanDetailPageData).timeSlots.filter((item) => item !== time) });
    this.updateDirtyState();
  },

  /** 编辑态相对已保存计划的改动才叫“脏”；未改动时释放守卫，避免误报未保存。 */
  updateDirtyState(): void {
    const data = this.data as PlanDetailPageData;
    const plan = data.plan;
    let changed = false;
    if (data.editing && plan !== null) {
      changed =
        data.dosageText !== plan.dosageText ||
        data.startDate !== plan.startDate ||
        data.endDate !== (plan.endDate ?? "") ||
        data.timeSlots.length !== plan.timeSlots.length ||
        data.timeSlots.some((slot, index) => slot !== plan.timeSlots[index]);
    }
    if (changed) this.persistLocalDraft();
    if (changed && !this.dirty) {
      this.dirty = true;
      registerDirtyDraft({
        label: "计划修改有未保存内容。",
        save: async () => {
          await this.persistEdit();
        },
      });
      try {
        wx.enableAlertBeforeUnload({ message: LEAVE_WARNING });
      } catch {
        // 部分基础库没有原生离开提示；草稿守卫仍在更新重启链路生效。
      }
    } else if (!changed && this.dirty) {
      this.releaseDraftGuard();
    }
  },

  releaseDraftGuard(): void {
    this.dirty = false;
    clearDirtyDraft();
    try {
      wx.disableAlertBeforeUnload();
    } catch {
      // 与 enable 对称：老基础库缺该 API 时静默。
    }
  },

  /** 校验编辑内容；返回错误文案，全部合法时返回 null。 */
  validateEdit(): string | null {
    const data = this.data as PlanDetailPageData;
    if (data.dosageText.trim() === "") return "请填写剂量说明";
    if (data.timeSlots.length === 0) return "请至少保留一个时间点";
    if (data.endDate !== "" && data.endDate < data.startDate) return "结束日期不能早于开始日期";
    return null;
  },

  /**
   * 提交编辑（不含确认弹窗）：供“保存修改”按钮与更新重启前的草稿保存共用。
   * 校验失败或接口失败都会抛出，交由调用方决定提示与是否延期。
   */
  async persistEdit(): Promise<string> {
    const data = this.data as PlanDetailPageData;
    if (data.plan === null) throw new Error("计划尚未加载");
    const invalid = this.validateEdit();
    if (invalid !== null) throw new Error(invalid);
    await ensureLoggedIn();
    const result = await api.updateMedicationPlan(data.plan.id, {
      version: data.plan.version,
      dosageText: data.dosageText.trim(),
      timeSlots: data.timeSlots,
      startDate: data.startDate,
      endDate: data.endDate === "" ? null : data.endDate,
    });
    return result.note;
  },

  async onSubmitEdit(): Promise<void> {
    const data = this.data as PlanDetailPageData;
    if (data.saving || data.plan === null) return;
    const invalid = this.validateEdit();
    if (invalid !== null) {
      wx.showToast({ title: invalid, icon: "none" });
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
      const note = await this.persistEdit();
      this.releaseDraftGuard();
      this.removeLocalDraft();
      this.setData({ editing: false, saving: false, note });
      await this.refresh();
      wx.showToast({ title: "已保存", icon: "success" });
    } catch (error) {
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        this.persistLocalDraft();
        this.setData({ saving: false });
        await this.refresh();
        this.setData({ note: "家人已修改计划。你的草稿仍在编辑区，已读取最新版本；请对照当前计划核对，再保存。" });
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

  editFields(): Pick<PlanDetailPageData, "dosageText" | "startDate" | "endDate" | "timeSlots" | "timeInput"> {
    const { dosageText, startDate, endDate, timeSlots, timeInput } = this.data as PlanDetailPageData;
    return { dosageText, startDate, endDate, timeSlots: [...timeSlots], timeInput };
  },
  persistLocalDraft(): void {
    const key = this.draftOwnerKey;
    if (key && key === scopedStorageKey("plan-edit-draft", this.data.planId)) {
      try { wx.setStorageSync(key, this.editFields()); } catch { wx.showToast({ title: "本机草稿保存失败，请保留当前页面", icon: "none" }); }
    }
  },
  removeLocalDraft(): void {
    const key = this.draftOwnerKey;
    if (key && key === scopedStorageKey("plan-edit-draft", this.data.planId)) {
      try { wx.removeStorageSync(key); } catch { return; }
    }
    this.setData({ draftAvailable: false });
  },
  onRestoreLocalDraft(): void {
    const key = this.draftOwnerKey;
    if (key !== scopedStorageKey("plan-edit-draft", this.data.planId)) return;
    if (!key || !this.data.canManage) return;
    const fields = wx.getStorageSync(key) as Partial<PlanDetailPageData> | undefined;
    if (fields) { this.setData({ ...fields, editing: true, draftAvailable: false }); this.updateDirtyState(); }
  },
  onLeaveChoice(event: { currentTarget: { dataset: { choice?: string } } }): void {
    const choice = event.currentTarget.dataset.choice;
    this.setData({ leaveSheetVisible: false });
    if (choice === "continue") return;
    if (choice === "keep") this.persistLocalDraft();
    else if (choice === "discard") this.removeLocalDraft();
    else return;
    this.releaseDraftGuard();
    this.discardEdit();
  },
  onBack(): void {
    if (this.dirty) { this.setData({ leaveSheetVisible: true }); return; }
    wx.navigateBack();
  },
});
