import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import type {
  CareProfileSummary,
  DoseReminderDelivery,
  MedicationPlanSummary,
  ScheduleEntry,
} from "../../services/api-types";

interface SubscribeCapableWx {
  requestSubscribeMessage?: (options: {
    tmplIds: string[];
    success?: (result: Record<string, string>) => void;
    fail?: (error: { errMsg?: string }) => void;
  }) => void;
}

/**
 * 用药计划页（R3-b）：今日安排 / 全部计划 / 创建计划。
 * - 今日安排：日期左右切换、按时间排列、已服用/跳过/纠正（幂等键防重）；
 *   过了时间没有记录显示"未确认"，不判定漏服。
 * - 全部计划：进行中/暂停列表，暂停与恢复走版本校验。
 * - 创建：照护对象（或新建"我自己"）+ 药名手填 + 剂量 + 时间点 + 起止日期。
 */

const WEEKDAY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "mon", label: "一" }, { value: "tue", label: "二" }, { value: "wed", label: "三" },
  { value: "thu", label: "四" }, { value: "fri", label: "五" }, { value: "sat", label: "六" },
  { value: "sun", label: "日" },
];

interface ScheduleCard extends ScheduleEntry {
  statusLabel: string;
  statusClass: string;
  overdue: boolean;
}

interface PlanCard extends MedicationPlanSummary {
  statusLabel: string;
  weekdayText: string;
  slotText: string;
  rangeText: string;
}

interface MedicationPlansPageData {
  view: "today" | "all";
  loading: boolean;
  errorMessage: string;
  date: string;
  entries: ScheduleCard[];
  plans: PlanCard[];
  visibleEntries: ScheduleCard[];
  visiblePlans: PlanCard[];
  profileOptions: Array<{ id: string; displayName: string }>;
  profileFilter: string;
  planStatusFilter: "all" | "active" | "paused" | "ended";
  hasAnyProfile: boolean;
  formVisible: boolean;
  careProfiles: CareProfileSummary[];
  careProfileIndex: number;
  /** 从药品详情带入的药品身份（只带 ID，剂量与时间仍手填）。 */
  medicineId: string;
  medicineName: string;
  dosageText: string;
  startDate: string;
  endDate: string;
  timeInput: string;
  timeSlots: string[];
  everyDay: boolean;
  selectedWeekdays: string[];
  weekdayOptions: Array<{ value: string; label: string }>;
  creating: boolean;
  confirmingId: string;
  reminderAvailable: boolean;
  reminderTemplateId: string;
  reminderReason: string;
  reminderSubscribing: boolean;
  reminderStatusText: string;
  deliveries: DoseReminderDelivery[];
}

function shanghaiDate(offsetDays: number): string {
  const shanghai = new Date(Date.now() + 8 * 3600 * 1000);
  const shifted = new Date(Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate() + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

function isFutureEntry(entry: ScheduleEntry, date: string): boolean {
  if (date !== shanghaiDate(0)) return date > shanghaiDate(0);
  const shanghai = new Date(Date.now() + 8 * 3600 * 1000);
  const nowMinutes = shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes();
  const [hour, minute] = entry.time.split(":").map(Number);
  return hour * 60 + minute > nowMinutes;
}

function toScheduleCard(entry: ScheduleEntry, date: string): ScheduleCard {
  const statusLabels: Record<string, string> = { pending: "未确认", taken: "已服用", skipped: "本次跳过" };
  return {
    ...entry,
    statusLabel: statusLabels[entry.status] ?? "未确认",
    statusClass: entry.status === "taken" ? "taken" : entry.status === "skipped" ? "skipped" : "pending",
    overdue: entry.status === "pending" && !isFutureEntry(entry, date),
  };
}

function toPlanCard(plan: MedicationPlanSummary): PlanCard {
  const weekdayText = plan.weekdays.length === 7
    ? "每天"
    : plan.weekdays.map((day) => WEEKDAY_OPTIONS.find((option) => option.value === day)?.label ?? day).join("、");
  return {
    ...plan,
    statusLabel: plan.status === "active" ? "进行中" : plan.status === "paused" ? "已暂停" : "已结束",
    weekdayText,
    slotText: plan.timeSlots.join(" / "),
    rangeText: `${plan.startDate}${plan.endDate === null ? " 起" : ` 至 ${plan.endDate}`}`,
  };
}

Page({
  data: {
    view: "today",
    loading: false,
    errorMessage: "",
    date: shanghaiDate(0),
    entries: [] as ScheduleCard[],
    plans: [] as PlanCard[],
    visibleEntries: [] as ScheduleCard[],
    visiblePlans: [] as PlanCard[],
    profileOptions: [{ id: "", displayName: "全部" }],
    profileFilter: "",
    planStatusFilter: "all",
    hasAnyProfile: false,
    formVisible: false,
    careProfiles: [] as CareProfileSummary[],
    careProfileIndex: 0,
    medicineId: "",
    medicineName: "",
    dosageText: "",
    startDate: shanghaiDate(0),
    endDate: "",
    timeInput: "",
    timeSlots: [] as string[],
    everyDay: true,
    selectedWeekdays: [] as string[],
    weekdayOptions: WEEKDAY_OPTIONS,
    creating: false,
    confirmingId: "",
    reminderAvailable: false,
    reminderTemplateId: "",
    reminderReason: "",
    reminderSubscribing: false,
    reminderStatusText: "",
    deliveries: [] as DoseReminderDelivery[],
  } as MedicationPlansPageData,

  onLoad(options: { medicineId?: string; medicineName?: string }): void {
    // 从药品详情进入时只带入药品身份：剂量与时间点仍由用户填写。
    const medicineId = options.medicineId ?? "";
    if (medicineId !== "") {
      this.setData({
        formVisible: true,
        medicineId,
        medicineName: options.medicineName ?? "",
      });
    }
    this.refresh();
  },

  async refresh(): Promise<void> {
    this.setData({ loading: true, errorMessage: "" });
    try {
      await ensureLoggedIn();
      const data = this.data as MedicationPlansPageData;
      // 计划列表始终拉全量（含已结束），状态筛选在客户端做，避免切换时漏掉历史。
      const [schedule, plans, careProfiles] = await Promise.all([
        api.getMedicationSchedule(data.date),
        api.listMedicationPlans("all"),
        api.listCareProfiles(),
      ]);
      // 提醒状态只影响提示区：读取失败不该让整个页面不可用。
      const reminder = await api.getDoseReminderStatus().catch(() => ({
        available: false,
        reason: "暂时无法读取服药提醒状态；计划与今日安排仍可正常使用。",
        templateId: "",
        deliveries: [] as DoseReminderDelivery[],
      }));
      this.setData({
        // 后端已按时间排序；客户端再排一次，避免不同来源的顺序差异把早晚弄反。
        entries: [...schedule.entries]
          .sort((left, right) => left.time.localeCompare(right.time))
          .map((entry) => toScheduleCard(entry, schedule.date)),
        plans: plans.plans.map(toPlanCard),
        careProfiles: careProfiles.careProfiles,
        hasAnyProfile: careProfiles.careProfiles.length > 0,
        reminderAvailable: reminder.available,
        reminderTemplateId: reminder.templateId,
        reminderReason: reminder.available
          ? "到点未确认时会尝试发送一次提醒；每次送达取决于微信授权与平台规则。"
          : reminder.reason ?? "服药提醒模板尚未配置，计划与今日安排仍可正常使用。",
        deliveries: reminder.deliveries.slice(0, 5),
        loading: false,
      });
      this.applyFilters();
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "加载失败，请重试";
      this.setData({ loading: false, errorMessage: message });
    }
  },

  /** 照护对象与状态筛选：只改变当前视图，不重复请求接口。 */
  applyFilters(): void {
    const data = this.data as MedicationPlansPageData;
    const profileOptions = [
      { id: "", displayName: "全部" },
      ...data.careProfiles.map((profile) => ({ id: profile.id, displayName: profile.displayName })),
    ];
    const profileFilter = profileOptions.some((option) => option.id === data.profileFilter) ? data.profileFilter : "";
    const visibleEntries = profileFilter === ""
      ? data.entries
      : data.entries.filter((entry) => entry.careProfileId === profileFilter);
    const visiblePlans = data.planStatusFilter === "all"
      ? data.plans
      : data.plans.filter((plan) => plan.status === data.planStatusFilter);
    this.setData({ profileOptions, profileFilter, visibleEntries, visiblePlans });
  },

  onProfileFilterChange(event: { currentTarget: { dataset: { id?: string } } }): void {
    this.setData({ profileFilter: event.currentTarget.dataset.id ?? "" });
    this.applyFilters();
  },

  onPlanStatusChange(event: { currentTarget: { dataset: { status?: string } } }): void {
    const status = event.currentTarget.dataset.status;
    if (status !== "all" && status !== "active" && status !== "paused" && status !== "ended") return;
    this.setData({ planStatusFilter: status });
    this.applyFilters();
  },

  /**
   * 服药提醒授权必须由用户主动触发：没有模板就如实说明，
   * 不做"打开开关即可每日收到"的承诺。
   */
  onSubscribeDoseReminder(): void {
    const data = this.data as MedicationPlansPageData;
    if (data.reminderSubscribing) return;
    if (!data.reminderAvailable) {
      this.setData({ reminderStatusText: data.reminderReason });
      return;
    }
    const native = wx as unknown as SubscribeCapableWx;
    if (typeof native.requestSubscribeMessage !== "function") {
      this.setData({ reminderStatusText: "当前微信版本不支持订阅消息；今日安排仍可手动查看。" });
      return;
    }
    const templateId = data.reminderTemplateId;
    if (templateId === "") {
      this.setData({ reminderStatusText: "服务端未提供服药提醒模板 ID。" });
      return;
    }
    this.setData({ reminderSubscribing: true, reminderStatusText: "等待微信授权…" });
    native.requestSubscribeMessage.call(wx, {
      tmplIds: [templateId],
      success: (result) => {
        if (result[templateId] !== "accept") {
          this.setData({ reminderStatusText: "本次没有获得授权；可以稍后再次点击订阅。", reminderSubscribing: false });
          return;
        }
        api.subscribeToNotifications([templateId])
          .then(() => this.setData({ reminderStatusText: "已记录本次授权；一次性授权按次数使用，长期提醒以平台能力为准。" }))
          .catch((error: unknown) => this.setData({
            reminderStatusText: error instanceof ApiError ? error.message : "授权已返回但保存失败，请重试。",
          }))
          .finally(() => this.setData({ reminderSubscribing: false }));
      },
      fail: (error) => {
        const cancelled = (error.errMsg ?? "").includes("cancel");
        this.setData({
          reminderStatusText: cancelled ? "你取消了授权；今日安排仍可手动查看。" : "微信授权未完成，请稍后重试。",
          reminderSubscribing: false,
        });
      },
    });
  },

  onOpenPlanDetail(event: { currentTarget: { dataset: { id?: string } } }): void {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/plan-detail/plan-detail?planId=${id}` });
  },

  onSwitchView(event: { currentTarget: { dataset: { view?: string } } }): void {
    const view = event.currentTarget.dataset.view;
    if (view !== "today" && view !== "all") return;
    this.setData({ view });
  },

  onShiftDate(event: { currentTarget: { dataset: { delta?: string } } }): void {
    const delta = Number(event.currentTarget.dataset.delta ?? 0);
    const [year, month, day] = (this.data as MedicationPlansPageData).date.split("-").map(Number);
    const shifted = new Date(Date.UTC(year, month - 1, day + delta)).toISOString().slice(0, 10);
    this.setData({ date: shifted });
    this.refresh();
  },

  /** 已服用/跳过：幂等键由操作本身生成，重试不会重复记账。 */
  async onConfirmDose(event: { currentTarget: { dataset: { id?: string; action?: string } } }): Promise<void> {
    const data = this.data as MedicationPlansPageData;
    const id = event.currentTarget.dataset.id;
    const action = event.currentTarget.dataset.action;
    if (!id || (action !== "taken" && action !== "skipped") || data.confirmingId !== "") return;
    // 纠正已有状态时需要用户明确确认，避免手滑改写历史。
    const target = data.entries.find((item) => item.occurrenceId === id);
    if (target && target.status !== "pending") {
      const confirmed = await new Promise<boolean>((resolve) => {
        wx.showModal({
          title: "纠正记录",
          content: `当前记录是“${target.statusLabel}”，改为“${action === "taken" ? "已服用" : "本次跳过"}”会保留操作历史。`,
          success: (result) => resolve(result.confirm),
          fail: () => resolve(false),
        });
      });
      if (!confirmed) return;
    }
    this.setData({ confirmingId: id });
    try {
      await ensureLoggedIn();
      await api.confirmDoseOccurrence(id, action, `dose-${id}-${Date.now()}`);
      await this.refresh();
      wx.showToast({ title: action === "taken" ? "已记录服用" : "已记录跳过", icon: "success" });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "操作失败，请重试";
      wx.showToast({ title: message, icon: "none", duration: 2800 });
    } finally {
      this.setData({ confirmingId: "" });
    }
  },

  async onTogglePlanStatus(event: { currentTarget: { dataset: { id?: string; action?: string } } }): Promise<void> {
    const dataset = event.currentTarget.dataset;
    const plan = (this.data as MedicationPlansPageData).plans.find((item) => item.id === dataset.id);
    if (!plan || !dataset.action) return;
    const action = dataset.action as "pause" | "resume";
    const label = action === "pause" ? "暂停" : "恢复";
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: `${label}计划`,
        content: action === "pause" ? "暂停后不再生成新的服药安排；已有记录保留。" : "恢复后将继续生成之后的安排。",
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    try {
      await ensureLoggedIn();
      await api.changeMedicationPlanStatus(plan.id, action, plan.version);
      await this.refresh();
      wx.showToast({ title: `已${label}`, icon: "success" });
    } catch (error) {
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        wx.showToast({ title: "计划已被他人修改，已刷新", icon: "none", duration: 2800 });
        this.refresh();
      } else {
        wx.showToast({ title: error instanceof ApiError ? error.message : "操作失败", icon: "none", duration: 2800 });
      }
    }
  },

  // —— 创建计划 ——

  async onOpenCreateForm(): Promise<void> {
    const data = this.data as MedicationPlansPageData;
    if (data.careProfiles.length === 0) {
      // 第一位使用者先为自己创建照护对象（本人计划默认私有）。
      await this.createSelfProfile();
      return;
    }
    this.setData({ formVisible: true });
  },

  async createSelfProfile(): Promise<void> {
    this.setData({ loading: true });
    try {
      await ensureLoggedIn();
      await api.createCareProfile({ displayName: "我自己" });
      await this.refresh();
      this.setData({ formVisible: true });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "创建照护对象失败";
      wx.showToast({ title: message, icon: "none", duration: 2800 });
      this.setData({ loading: false });
    }
  },

  onCloseCreateForm(): void {
    this.setData({ formVisible: false });
  },

  onFormInput(event: { currentTarget: { dataset: { field?: string } }; detail: { value: string } }): void {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [field]: event.detail.value });
  },

  onFormDateChange(event: { currentTarget: { dataset: { field?: string } }; detail: { value: string } }): void {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [field]: event.detail.value });
  },

  onCareProfileChange(event: { detail: { value: string | number } }): void {
    this.setData({ careProfileIndex: Number(event.detail.value) });
  },

  onEveryDayChange(event: { detail: { value: boolean } }): void {
    this.setData({ everyDay: event.detail.value, selectedWeekdays: [] });
  },

  onToggleWeekday(event: { currentTarget: { dataset: { value?: string } } }): void {
    const value = event.currentTarget.dataset.value;
    if (!value) return;
    const current = (this.data as MedicationPlansPageData).selectedWeekdays;
    const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
    this.setData({ selectedWeekdays: next, everyDay: next.length === 7 });
  },

  onAddTimeSlot(): void {
    const data = this.data as MedicationPlansPageData;
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
    this.setData({ timeSlots: (this.data as MedicationPlansPageData).timeSlots.filter((item) => item !== time) });
  },

  async onSubmitPlan(): Promise<void> {
    const data = this.data as MedicationPlansPageData;
    if (data.creating) return;
    const profile = data.careProfiles[data.careProfileIndex];
    if (!profile) return;
    const medicineName = data.medicineName.trim();
    const dosageText = data.dosageText.trim();
    if (medicineName === "") { wx.showToast({ title: "请填写药品名称", icon: "none" }); return; }
    if (dosageText === "") { wx.showToast({ title: "请填写剂量说明，例如每次 1 片", icon: "none" }); return; }
    if (data.timeSlots.length === 0) { wx.showToast({ title: "请至少添加一个每日时间点", icon: "none" }); return; }
    if (!data.everyDay && data.selectedWeekdays.length === 0) {
      wx.showToast({ title: "指定星期需至少选择一天，或改回每天", icon: "none" });
      return;
    }
    if (data.endDate !== "" && data.endDate < data.startDate) {
      wx.showToast({ title: "结束日期不能早于开始日期", icon: "none" });
      return;
    }
    this.setData({ creating: true });
    try {
      await ensureLoggedIn();
      await api.createMedicationPlan({
        careProfileId: profile.id,
        medicineId: data.medicineId === "" ? null : data.medicineId,
        medicineName,
        dosageText,
        timeSlots: data.timeSlots,
        weekdays: data.everyDay ? undefined : data.selectedWeekdays,
        startDate: data.startDate,
        endDate: data.endDate === "" ? null : data.endDate,
      });
      wx.showToast({ title: "计划已保存", icon: "success" });
      this.setData({
        formVisible: false, medicineId: "", medicineName: "", dosageText: "", timeSlots: [], endDate: "",
        everyDay: true, selectedWeekdays: [], startDate: shanghaiDate(0),
      });
      await this.refresh();
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "保存失败，请重试";
      wx.showToast({ title: message, icon: "none", duration: 2800 });
    } finally {
      this.setData({ creating: false });
    }
  },

  noop(): void {
    // 阻止表单弹层点击穿透。
  },
});
