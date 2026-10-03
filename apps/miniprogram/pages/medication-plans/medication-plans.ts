import { api, ApiError, captureSessionIdentity, isCurrentSession, type SessionIdentity } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import type {
  CareProfileSummary,
  DoseReminderDelivery,
  MedicationPlanSummary,
  ScheduleEntry,
} from "../../services/api-types";

// Keep only unresolved operation metadata in memory, across tab/page remounts.
// Never replay on load; a different action waits for the original explicit retry.
interface DoseAttempt {
  identity: SessionIdentity;
  date: string;
  action: "taken" | "skipped";
  key: string;
  busy: boolean;
}
const doseAttempts = new Map<string, DoseAttempt>();
const doseObservers = new Set<(id: string, date: string) => void>();
let doseSequence = 0;
function pendingDose(id: string): DoseAttempt | undefined {
  for (const [key, attempt] of doseAttempts) {
    if (!isCurrentSession(attempt.identity)) doseAttempts.delete(key);
  }
  return doseAttempts.get(id);
}

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
  retryAction: "" | "taken" | "skipped";
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
  careProfiles: CareProfileSummary[];
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
  const pending = pendingDose(entry.occurrenceId);
  const statusLabels: Record<string, string> = { pending: "未确认", taken: "已服用", skipped: "本次跳过" };
  return {
    ...entry,
    statusLabel: statusLabels[entry.status] ?? "未确认",
    statusClass: entry.status === "taken" ? "taken" : entry.status === "skipped" ? "skipped" : "pending",
    overdue: entry.status === "pending" && !isFutureEntry(entry, date),
    retryAction: pending?.date === date ? pending.action : "",
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
    careProfiles: [] as CareProfileSummary[],
    confirmingId: "",
    reminderAvailable: false,
    reminderTemplateId: "",
    reminderReason: "",
    reminderSubscribing: false,
    reminderStatusText: "",
    deliveries: [] as DoseReminderDelivery[],
  } as MedicationPlansPageData,

  /** 请求代号：每次 refresh 自增，用于作废旧响应（非渲染字段）。 */
  requestSeq: 0,
  loadedIdentity: null as SessionIdentity | null,
  loadedDate: "",
  doseObserver: null as ((id: string, date: string) => void) | null,
  /** 今日模式：为 true 时回前台跨零点自动前进日期；用户手选日期后置 false。 */
  followToday: true,

  onUnload(): void {
    this.requestSeq += 1;
    this.loadedIdentity = null;
    if (this.doseObserver) doseObservers.delete(this.doseObserver);
    this.doseObserver = null;
  },

  async onShow(): Promise<void> {
    // 回前台与写入返回统一走这里合并刷新：今日模式跨零点自动前进，用户手选日期保持不变。
    // 首次进入时 onLoad 之后必然触发 onShow，因此不在 onLoad 里重复请求。
    if (this.followToday) {
      const today = shanghaiDate(0);
      if ((this.data as MedicationPlansPageData).date !== today) {
        this.setData({ date: today });
      }
    }
    await this.refresh();
  },

  async refresh(): Promise<void> {
    if (!this.doseObserver) {
      this.doseObserver = (_id: string, date: string): void => {
        if ((this.data as MedicationPlansPageData).date === date) void this.refresh();
      };
      doseObservers.add(this.doseObserver);
    }
    const seq = ++this.requestSeq;
    const requestedDate = (this.data as MedicationPlansPageData).date;
    this.setData({ loading: true, errorMessage: "" });
    try {
      await ensureLoggedIn();
      const identity = captureSessionIdentity();
      pendingDose("");
      // 计划列表始终拉全量（含已结束），状态筛选在客户端做，避免切换时漏掉历史。
      // 日期用请求发起时捕获的值，避免加载途中被再次切换导致张冠李戴。
      const [schedule, plans, careProfiles] = await Promise.all([
        api.getMedicationSchedule(requestedDate),
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
      // 旧响应作废：仅当本次请求仍是最新一次、且日期未被再次切换时才写入。
      if (!isCurrentSession(identity) || seq !== this.requestSeq || requestedDate !== (this.data as MedicationPlansPageData).date) return;
      this.loadedIdentity = identity;
      this.loadedDate = requestedDate;
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
      // 旧请求的失败不该覆盖新请求的结果。
      if (seq !== this.requestSeq || requestedDate !== (this.data as MedicationPlansPageData).date) return;
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
    // 手动切到今天则恢复今日模式；切到其它日期则保留用户选择，回前台不再自动前进。
    this.followToday = shifted === shanghaiDate(0);
    this.setData({ date: shifted });
    this.refresh();
  },

  /** Same explicit retry reuses its key; unresolved writes cannot be corrected. */
  async onConfirmDose(event: { currentTarget: { dataset: { id?: string; action?: string } } }): Promise<void> {
    const id = event.currentTarget.dataset.id;
    const action = event.currentTarget.dataset.action;
    if (!id || (action !== "taken" && action !== "skipped")) return;
    const data = this.data as MedicationPlansPageData;
    if (data.loading || data.confirmingId !== "") return;
    const target = data.entries.find((item) => item.occurrenceId === id);
    if (!target) return;
    const identity = this.loadedIdentity;
    const date = data.date;
    const sequence = this.requestSeq;
    const isCurrentTarget = (): boolean => identity !== null && identity === this.loadedIdentity && isCurrentSession(identity)
      && sequence === this.requestSeq && this.loadedDate === date && (this.data as MedicationPlansPageData).date === date
      && !(this.data as MedicationPlansPageData).loading
      && (this.data as MedicationPlansPageData).entries.some((item) => item.occurrenceId === id);
    if (!isCurrentTarget()) {
      wx.showToast({ title: "列表已更新，请刷新后重新确认", icon: "none" });
      return;
    }
    let attempt = pendingDose(id);
    const wasPending = attempt !== undefined;
    let writeStarted = false;
    if (attempt?.busy) return;
    if (attempt && (attempt.action !== action || attempt.date !== date)) {
      wx.showToast({ title: `上次“${attempt.action === "taken" ? "已服用" : "跳过"}”结果未确定，请先重试上次记录，再纠正`, icon: "none", duration: 3500 });
      return;
    }
    // Lock before the correction dialog, not after it, so double taps cannot
    // create two dialogs or two independent operations.
    this.setData({ confirmingId: id });
    try {
      if (target.status !== "pending" && !attempt) {
        const confirmed = await new Promise<boolean>((resolve) => {
          wx.showModal({
            title: "纠正记录",
            content: `当前记录是“${target.statusLabel}”，改为“${action === "taken" ? "已服用" : "本次跳过"}”会保留操作历史。`,
            success: (result) => resolve(result.confirm),
            fail: () => resolve(false),
          });
        });
        if (!confirmed || !isCurrentTarget()) return;
      }
      // A remounted page can be acting on the same occurrence while a dialog
      // is open. Recheck the shared lock before reserving the original key.
      const currentAttempt = pendingDose(id);
      if (currentAttempt?.busy || (currentAttempt && currentAttempt !== attempt)) return;
      attempt ??= { identity: identity!, date, action, key: `dose-${Date.now()}-${++doseSequence}-${Math.random().toString(36).slice(2, 10)}`, busy: false };
      attempt.busy = true;
      doseAttempts.set(id, attempt);
      await ensureLoggedIn();
      if (!isCurrentTarget()) return;
      writeStarted = true;
      const result = await api.confirmDoseOccurrence(id, action, attempt.key);
      if (result.status !== "taken" && result.status !== "skipped") throw new Error("Unrecognized confirmation response");
      if (doseAttempts.get(id) === attempt) doseAttempts.delete(id);
      if (identity && isCurrentSession(identity)) {
        // An older page may finish while a new instance is open. Invalidate
        // that page's pre-ACK read and refresh it before another write is allowed.
        for (const observer of doseObservers) {
          if (observer !== this.doseObserver) observer(id, date);
        }
      }
      if (!identity || !isCurrentSession(identity) || !this.loadedIdentity
          || !isCurrentSession(this.loadedIdentity)
          || (this.data as MedicationPlansPageData).date !== date || this.loadedDate !== date) return;
      // Invalidate any read started before this acknowledged write.
      this.requestSeq += 1;
      this.setData({ loading: false });
      // Preserve the acknowledged server status even when the following read
      // fails; never invite a fresh duplicate write against stale pending UI.
      this.setData({ entries: (this.data as MedicationPlansPageData).entries.map((item) =>
        item.occurrenceId === id ? toScheduleCard({ ...item, status: result.status }, date) : item) });
      this.applyFilters();
      await this.refresh();
      if (identity && isCurrentSession(identity) && (this.data as MedicationPlansPageData).date === date) {
        wx.showToast({ title: result.status === "taken" ? "当前记录：已服用" : "当前记录：已跳过", icon: "success" });
      }
    } catch (error) {
      if (!identity || !isCurrentSession(identity) || (this.data as MedicationPlansPageData).date !== date) return;
      const message = error instanceof ApiError ? error.message : "结果尚未确定，请重试上次记录";
      wx.showToast({ title: message, icon: "none", duration: 2800 });
    } finally {
      if (attempt && doseAttempts.get(id) === attempt) {
        attempt.busy = false;
        // No POST was started: cancelling/changing identity during login is not
        // an uncertain server write and must not freeze an unsubmitted intent.
        if (!wasPending && !writeStarted) doseAttempts.delete(id);
      }
      this.setData({ confirmingId: "", entries: (this.data as MedicationPlansPageData).entries
        .map((item) => toScheduleCard(item, (this.data as MedicationPlansPageData).date)) });
      this.applyFilters();
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

  /**
   * 创建流程走独立非 tab 页：本页是 tabBar 页，弹层表单与底部导航体验冲突，
   * 且药品详情无法用 navigateTo 携带身份进入 tabBar 页（R12）。
   */
  onOpenCreateForm(): void {
    wx.navigateTo({ url: "/pages/plan-create/plan-create" });
  },
});
