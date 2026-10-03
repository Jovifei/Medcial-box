import { api, ApiError, captureSessionIdentity, isCurrentSession, staleSessionError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import { clearDirtyDraft, registerDirtyDraft } from "../../services/draft-guard";
import { scopedStorageKey, readSessionScope } from "../../services/session-scope";
import type { SessionIdentity } from "../../services/api";
import type { DirtyDraft } from "../../services/draft-guard";
import type { CareProfileSummary, MedicationSummary, MedicationPlanPayload } from "../../services/api-types";

/**
 * 独立创建用药计划页（R12）：
 * - 用药计划是底部导航（tabBar）页，navigateTo 无法打开，也不能带参数；
 *   因此创建流程独立成非 tab 页，从药品详情或计划页用 navigateTo 进入并携带药品身份。
 * - 保存成功后用 switchTab 回到“用药计划”页（tabBar 页只能用 switchTab 到达）。
 * - 只带入药品 ID 与名称，剂量与时间点仍由用户手填，不做任何推导。
 * - 有未保存内容时登记草稿并开启原生返回确认（R14）：更新重启前可被统一保存，
 *   误触返回也会先提示，不静默丢草稿。
 */

const LEAVE_WARNING = "创建计划表单有未保存内容，离开会保留本机草稿；左下方取消可选择保留或放弃。";

const WEEKDAY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "mon", label: "一" }, { value: "tue", label: "二" }, { value: "wed", label: "三" },
  { value: "thu", label: "四" }, { value: "fri", label: "五" }, { value: "sat", label: "六" },
  { value: "sun", label: "日" },
];

interface WeekdayOption { value: string; label: string; on: boolean; }

interface PlanCreatePageData {
  draftAvailable: boolean;
  leaveSheetVisible: boolean;
  inventoryMedicines: MedicationSummary[];
  loading: boolean;
  errorMessage: string;
  careProfiles: CareProfileSummary[];
  careProfileIndex: number;
  medicineId: string;
  medicineName: string;
  dosageText: string;
  startDate: string;
  endDate: string;
  timeInput: string;
  timeSlots: string[];
  everyDay: boolean;
  selectedWeekdays: string[];
  /** R17：模板只读取字段，选中态在 TS 预先算好，不在 WXML 里调用方法。 */
  weekdayOptions: WeekdayOption[];
  creating: boolean;
  pendingCreation: boolean;
  creationAcknowledged: boolean;
  pendingMedicineName: string;
  contextInvalidated: boolean;
}

interface CreateOperation {
  ownerUserId: string;
  ownerFamilyId: string;
  payload: MedicationPlanPayload & { idempotencyKey: string };
  acknowledged: boolean;
  draftEntity: string;
  draftWriterId: string;
}

function validOperation(value: unknown): value is CreateOperation {
  if (!value || typeof value !== "object") return false;
  const op = value as CreateOperation;
  const p = op.payload;
  return typeof op.ownerUserId === "string" && typeof op.ownerFamilyId === "string" &&
    typeof op.acknowledged === "boolean" && typeof op.draftEntity === "string" && typeof op.draftWriterId === "string" && !!p && typeof p === "object" &&
    typeof p.idempotencyKey === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(p.idempotencyKey) &&
    typeof p.careProfileId === "string" && p.careProfileId !== "" &&
    typeof p.medicineName === "string" && typeof p.dosageText === "string" &&
    typeof p.startDate === "string" && Array.isArray(p.timeSlots) &&
    p.timeSlots.every((v) => typeof v === "string") &&
    (p.weekdays === undefined || (Array.isArray(p.weekdays) && p.weekdays.every((v) => typeof v === "string")));
}

function samePayload(left: MedicationPlanPayload, right: MedicationPlanPayload): boolean {
  const canonical = (p: MedicationPlanPayload) => JSON.stringify({
    careProfileId: p.careProfileId, medicineId: p.medicineId ?? null,
    medicineName: p.medicineName.trim(), dosageText: p.dosageText.trim(),
    startDate: p.startDate, endDate: p.endDate || null,
    timeSlots: [...p.timeSlots].sort(),
    weekdays: [...(p.weekdays ?? WEEKDAY_OPTIONS.map((d) => d.value))].sort(),
  });
  return canonical(left) === canonical(right);
}

function shanghaiDate(offsetDays: number): string {
  const shanghai = new Date(Date.now() + 8 * 3600 * 1000);
  const shifted = new Date(Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate() + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

function weekdayOptionsFor(selected: string[]): WeekdayOption[] {
  return WEEKDAY_OPTIONS.map((option) => ({ ...option, on: selected.includes(option.value) }));
}

Page({
  data: {
    draftAvailable: false,
    leaveSheetVisible: false,
    inventoryMedicines: [] as MedicationSummary[],
    loading: false,
    errorMessage: "",
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
    weekdayOptions: weekdayOptionsFor([]),
    creating: false,
    pendingCreation: false,
    creationAcknowledged: false,
    pendingMedicineName: "",
    contextInvalidated: false,
  } as PlanCreatePageData,

  /** 是否有未保存草稿（非渲染字段），用于更新重启前登记与原生返回确认。 */
  dirty: false,
  discarding: false,
  draftKey: null as string | null,
  draftEntity: "new",
  restoring: false,
  disposed: false,
  visible: true,
  reloadOnShow: false,
  draftWriterId: "",
  pageIdentity: null as SessionIdentity | null,
  pageScope: null as { userId: string; familyId: string } | null,
  bootstrapSequence: 0,
  operation: null as CreateOperation | null,
  operationKey: null as string | null,
  submitting: null as Promise<void> | null,
  ownedDraftGuard: null as DirtyDraft | null,

  bindPageIdentity(): void {
    if (!this.draftWriterId) this.draftWriterId = `form-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (this.pageIdentity === null) this.pageIdentity = captureSessionIdentity();
    if (this.pageScope === null) this.pageScope = readSessionScope();
  },
  isActive(): boolean {
    const scope = readSessionScope();
    return !this.disposed && this.visible && this.pageIdentity !== null && isCurrentSession(this.pageIdentity) &&
      (this.pageScope === null || (scope !== null && scope.userId === this.pageScope.userId && scope.familyId === this.pageScope.familyId));
  },
  showStaleBoundary(): void {
    if (this.disposed || !this.visible) return;
    this.setData({ contextInvalidated: true, creating: false, loading: false,
      pendingCreation: false, pendingMedicineName: "",
      errorMessage: "登录或家庭状态已变更，请返回后重新打开创建页面" });
  },
  requireActive(): void {
    if (!this.isActive()) throw staleSessionError();
  },
  ownsStoredOperation(operation: CreateOperation): boolean {
    if (!this.operationKey) return false;
    const stored: unknown = wx.getStorageSync(this.operationKey);
    return validOperation(stored) && stored.ownerUserId === operation.ownerUserId &&
      stored.ownerFamilyId === operation.ownerFamilyId && stored.payload.idempotencyKey === operation.payload.idempotencyKey;
  },
  readOperation(): CreateOperation | null {
    this.requireActive();
    const scope = readSessionScope();
    this.operationKey = scopedStorageKey("plan-create-operation");
    if (!scope?.familyId || !this.operationKey) throw new Error("请先登录并选择家庭");
    const stored: unknown = wx.getStorageSync(this.operationKey);
    if (stored !== undefined && stored !== null && stored !== "") {
      if (!validOperation(stored) || stored.ownerUserId !== scope.userId || stored.ownerFamilyId !== scope.familyId) {
        throw new Error("本机计划提交记录无法读取，请先核对已保存计划，勿重复创建");
      }
      if (this.operation && this.operation.payload.idempotencyKey !== stored.payload.idempotencyKey) {
        throw new Error("已有另一份计划提交，请重新打开页面核对");
      }
      if (!this.operation?.acknowledged) this.operation = stored;
    }
    this.setData({ pendingCreation: this.operation !== null,
      creationAcknowledged: this.operation?.acknowledged ?? false,
      pendingMedicineName: this.operation?.payload.medicineName ?? "" });
    return this.operation;
  },

  onLoad(options: { medicineId?: string; medicineName?: string }): void {
    this.bindPageIdentity();
    this.setData({
      medicineId: options.medicineId ?? "",
      medicineName: options.medicineName ?? "",
    });
    this.draftEntity = options.medicineId || "new";
    this.draftKey = scopedStorageKey("plan-create-draft", this.draftEntity);
    this.checkStoredDraft();
    // 从药品详情带入名称即视为已有未保存内容。
    this.updateDirtyState();
    this.bootstrap();
  },

  onShow(): void {
    this.visible = true;
    if (!this.isActive()) { this.showStaleBoundary(); return; }
    if (!this.submitting && this.isActive()) this.setData({ creating: false });
    if (this.reloadOnShow && this.isActive()) { this.reloadOnShow = false; this.bootstrap(); }
  },
  onHide(): void { this.visible = false; this.reloadOnShow = true; },

  onUnload(): void {
    try { if (this.dirty && !this.discarding) this.persistDraft(); } catch { /* operation receipt was saved before dispatch */ }
    finally {
      this.releaseDraftGuard();
      this.disposed = true;
      this.bootstrapSequence += 1;
    }
  },

  /** 依据当前输入判断是否有未保存草稿，并同步登记与原生返回确认。 */
  updateDirtyState(): void {
    if (!this.isActive()) return;
    const data = this.data as PlanCreatePageData;
    const dirty = data.medicineName.trim() !== "" || data.dosageText.trim() !== "" ||
      data.timeSlots.length > 0 || data.endDate !== "" || data.selectedWeekdays.length > 0 || !data.everyDay;
    if (dirty && !this.data.draftAvailable) this.persistDraft();
    if (dirty === this.dirty) return;
    this.dirty = dirty;
    if (dirty) {
      this.ownedDraftGuard = { label: "创建用药计划表单有未保存内容。", save: () => this.submitPlan() };
      registerDirtyDraft(this.ownedDraftGuard);
      try { wx.enableAlertBeforeUnload({ message: LEAVE_WARNING }); } catch { /* 老版本无此能力，忽略 */ }
    } else {
      this.releaseDraftGuard();
    }
  },

  releaseDraftGuard(): void {
    this.dirty = false;
    if (this.ownedDraftGuard) clearDirtyDraft(this.ownedDraftGuard);
    this.ownedDraftGuard = null;
    try { wx.disableAlertBeforeUnload(); } catch { /* 老版本无此能力，忽略 */ }
  },

  /**
   * 载入照护对象；第一位使用者还没有任何照护对象时，
   * 先为“我自己”建立（本人计划默认私有），再打开表单。
   */
  async bootstrap(): Promise<void> {
    this.bindPageIdentity();
    if (!this.isActive()) return;
    const sequence = ++this.bootstrapSequence;
    const active = () => this.isActive() && sequence === this.bootstrapSequence;
    this.setData({ loading: true, errorMessage: "" });
    try {
      await ensureLoggedIn({ allowInteractive: false });
      if (!active()) return;
      this.bindPageIdentity();
      this.readOperation();
      let careProfiles = (await api.listCareProfiles()).careProfiles;
      if (!active()) return;
      if (careProfiles.length === 0) {
        await api.ensureSelfCareProfile("我自己");
        if (!active()) return;
        careProfiles = (await api.listCareProfiles()).careProfiles;
      }
      if (!active()) return;
      this.draftKey = scopedStorageKey("plan-create-draft", this.draftEntity);
      if (!this.dirty) this.checkStoredDraft();
      this.setData({ careProfiles, careProfileIndex: 0, loading: false });
      if (api.listMedicines) {
        const inventory = await api.listMedicines();
        if (!active()) return;
        this.setData({ inventoryMedicines: inventory.medicines });
      }
    } catch (error) {
      if (!active()) return;
      const message = error instanceof Error || error instanceof ApiError ? error.message : "加载照护对象失败，请重试";
      this.setData({ loading: false, errorMessage: message });
    }
  },

  onFormInput(event: { currentTarget: { dataset: { field?: string } }; detail: { value: string } }): void {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [field]: event.detail.value, ...(field === "medicineName" ? { medicineId: "" } : {}) });
    this.updateDirtyState();
  },

  onFormDateChange(event: { currentTarget: { dataset: { field?: string } }; detail: { value: string } }): void {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [field]: event.detail.value });
    this.updateDirtyState();
  },

  onCareProfileChange(event: { detail: { value: string | number } }): void {
    this.setData({ careProfileIndex: Number(event.detail.value) });
    this.updateDirtyState();
  },

  onEveryDayChange(event: { detail: { value: boolean } }): void {
    this.setData({ everyDay: event.detail.value, selectedWeekdays: [], weekdayOptions: weekdayOptionsFor([]) });
    this.updateDirtyState();
  },

  onToggleWeekday(event: { currentTarget: { dataset: { value?: string } } }): void {
    const value = event.currentTarget.dataset.value;
    if (!value) return;
    const current = (this.data as PlanCreatePageData).selectedWeekdays;
    const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
    this.setData({ selectedWeekdays: next, everyDay: next.length === 7, weekdayOptions: weekdayOptionsFor(next) });
    this.updateDirtyState();
  },

  onAddTimeSlot(): void {
    const data = this.data as PlanCreatePageData;
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
    const time = event.currentTarget.dataset.time;
    if (!time) return;
    this.setData({ timeSlots: (this.data as PlanCreatePageData).timeSlots.filter((item) => item !== time) });
    this.updateDirtyState();
  },

  /**
   * 校验并保存计划；不导航、不弹提示，失败即抛错。
   * 既供页面按钮调用，也供更新重启前的"保存并重启"复用（R14）。
   */
  async submitPlan(retryOriginal = false): Promise<void> {
    if (this.submitting) return this.submitting;
    const pending = this.performSubmit(retryOriginal);
    this.submitting = pending;
    try { await pending; } finally { this.submitting = null; }
  },

  async performSubmit(retryOriginal: boolean): Promise<void> {
    this.requireActive();
    await ensureLoggedIn({ allowInteractive: false });
    this.requireActive();
    const scope = readSessionScope();
    const previous = this.readOperation();
    if (retryOriginal && !previous) throw new Error("没有待重试的提交，请重新打开页面");
    if (previous?.acknowledged) { this.finishAcknowledged(previous); return; }
    const data = this.data as PlanCreatePageData;
    const profile = data.careProfiles[data.careProfileIndex];
    const payload: MedicationPlanPayload = retryOriginal && previous ? previous.payload : {
      careProfileId: profile?.id ?? "", medicineId: data.medicineId || null,
      medicineName: data.medicineName.trim(), dosageText: data.dosageText.trim(),
      timeSlots: [...data.timeSlots].sort(),
      weekdays: data.everyDay ? undefined : [...data.selectedWeekdays].sort(),
      startDate: data.startDate, endDate: data.endDate || null,
    };
    if (previous && !samePayload(previous.payload, payload)) throw new Error("上次提交结果待核对；请重试原提交，不能直接保存修改后的内容");
    const target = data.careProfiles.find((p) => p.id === payload.careProfileId);
    if (!target) throw new Error("请选择照护对象");
    if (!target.canManage) throw new Error("没有管理该照护对象的权限");
    if (!payload.medicineName) throw new Error("请填写药品名称");
    if (!payload.dosageText) throw new Error("请填写剂量说明，例如每次 1 片");
    if (payload.timeSlots.length === 0) throw new Error("请至少添加一个每日时间点");
    if (payload.weekdays?.length === 0) throw new Error("指定星期需至少选择一天，或改回每天");
    if (payload.endDate && payload.endDate < payload.startDate) throw new Error("结束日期不能早于开始日期");
    if (!scope || !this.operationKey) throw new Error("请先登录并选择家庭");
    const operation: CreateOperation = previous ?? { ownerUserId: scope.userId, ownerFamilyId: scope.familyId,
      payload: { ...payload, idempotencyKey: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}` }, acknowledged: false, draftEntity: this.draftEntity, draftWriterId: this.draftWriterId };
    // Persist before dispatch. A full/unavailable store must never lose an uncertain write's identity.
    wx.setStorageSync(this.operationKey, operation);
    this.operation = operation;
    this.setData({ pendingCreation: true, pendingMedicineName: operation.payload.medicineName });
    this.requireActive();
    let result: Awaited<ReturnType<typeof api.createMedicationPlan>>;
    try {
      result = await api.createMedicationPlan(operation.payload);
    } catch (error) {
      this.requireActive();
      // Only a first, definitive rejection proves that this intent was not committed.
      if (!previous && error instanceof ApiError && [400, 403, 404, 422].includes(error.statusCode)) {
        try { if (this.ownsStoredOperation(operation)) wx.removeStorageSync(this.operationKey); this.operation = null; this.setData({ pendingCreation: false }); } catch { /* keep the original intent */ }
      }
      throw error;
    }
    this.requireActive();
    if (!result || typeof result.planId !== "string" || !result.planId || result.careProfileId !== payload.careProfileId || result.status !== "active" || result.version !== 1) {
      throw new Error("未收到完整保存回执，请重试原提交以核对结果");
    }
    this.finishAcknowledged(operation);
  },

  finishAcknowledged(operation: CreateOperation): void {
    operation.acknowledged = true;
    this.setData({ creationAcknowledged: true });
    this.discarding = true;
    // Keep the ACK until its ordinary draft is cleaned. Deleting the receipt
    // first could leave a saved form to be restored with a fresh request key.
    try {
      if (this.ownsStoredOperation(operation)) {
        wx.setStorageSync(this.operationKey!, operation);
        const draftKey = scopedStorageKey("plan-create-draft", operation.draftEntity);
        if (draftKey) {
          const stored = wx.getStorageSync(draftKey) as { writerId?: string; operationKey?: string } | undefined;
          if (stored?.writerId === operation.draftWriterId || stored?.operationKey === operation.payload.idempotencyKey) wx.removeStorageSync(draftKey);
        }
        if (this.ownsStoredOperation(operation)) wx.removeStorageSync(this.operationKey!);
      }
    } catch { /* ACK/old key survives cleanup failure; never turn success into a second POST */ }
    this.setData({ draftAvailable: false });
    this.releaseDraftGuard();
  },

  async onSubmitPlan(): Promise<void> { await this.showSubmitResult(false); },
  async onRetryPlan(): Promise<void> { await this.showSubmitResult(true); },
  async showSubmitResult(retryOriginal: boolean): Promise<void> {
    if (!this.isActive()) { this.showStaleBoundary(); return; }
    if (this.data.creating) return;
    this.setData({ creating: true });
    try {
      await this.submitPlan(retryOriginal);
      if (!this.isActive()) { this.showStaleBoundary(); return; }
      wx.showToast({ title: "计划已保存", icon: "success" });
      wx.switchTab({ url: "/pages/medication-plans/medication-plans" });
    } catch (error) {
      if (!this.isActive()) { this.showStaleBoundary(); return; }
      const message = error instanceof Error || error instanceof ApiError ? error.message : "保存失败，请重试原提交";
      wx.showToast({ title: message, icon: "none", duration: 2800 });
      this.setData({ creating: false });
    }
  },

  checkStoredDraft(): void {
    const scope = readSessionScope();
    if (!scope || !this.draftKey) return;
    const stored = wx.getStorageSync(this.draftKey) as { ownerUserId?: string; ownerFamilyId?: string } | undefined;
    this.setData({ draftAvailable: stored?.ownerUserId === scope.userId && stored?.ownerFamilyId === scope.familyId });
  },
  persistDraft(): void {
    const scope = readSessionScope();
    if (!this.isActive() || !scope || !this.draftKey || this.discarding || this.draftKey !== scopedStorageKey("plan-create-draft", this.draftEntity)) return;
    const { medicineId, medicineName, dosageText, startDate, endDate, timeInput, timeSlots, everyDay, selectedWeekdays, careProfileIndex } = this.data as PlanCreatePageData;
    wx.setStorageSync(this.draftKey, { ownerUserId: scope.userId, ownerFamilyId: scope.familyId, writerId: this.draftWriterId, operationKey: this.operation?.payload.idempotencyKey,
      fields: { medicineId, medicineName, dosageText, startDate, endDate, timeInput, timeSlots, everyDay, selectedWeekdays, careProfileIndex } });
  },
  onRestoreDraft(): void {
    if (!this.isActive()) return;
    this.readOperation();
    this.checkStoredDraft();
    if (!this.data.draftAvailable || !this.draftKey) return;
    const stored = wx.getStorageSync(this.draftKey) as { fields: Partial<PlanCreatePageData> };
    this.setData({ ...stored.fields, weekdayOptions: weekdayOptionsFor(stored.fields.selectedWeekdays ?? []), draftAvailable: false });
    this.updateDirtyState();
  },
  removeDraft(): void {
    if (this.draftKey) {
      const stored = wx.getStorageSync(this.draftKey) as { writerId?: string } | undefined;
      if (stored?.writerId === this.draftWriterId) wx.removeStorageSync(this.draftKey);
    }
    this.setData({ draftAvailable: false });
  },
  onInventoryMedicineChange(event: { detail: { value: string | number } }): void {
    const medicine = (this.data as PlanCreatePageData).inventoryMedicines[Number(event.detail.value)];
    if (!medicine) return;
    this.setData({ medicineId: medicine.id, medicineName: medicine.name });
    this.updateDirtyState();
  },
  onCancel(): void {
    if (this.dirty) { this.setData({ leaveSheetVisible: true }); return; }
    this.navigateFromForm();
  },
  onLeaveChoice(event: { currentTarget: { dataset: { choice?: string } } }): void {
    const choice = event.currentTarget.dataset.choice;
    this.setData({ leaveSheetVisible: false });
    if (choice === "continue") return;
    if (choice === "keep") this.persistDraft();
    else if (choice === "discard") { this.discarding = true; this.removeDraft(); }
    else return;
    this.releaseDraftGuard();
    this.navigateFromForm();
  },
  navigateFromForm(): void {
    wx.navigateBack({ fail: () => wx.switchTab({ url: "/pages/medication-plans/medication-plans" }) });
  },
});
