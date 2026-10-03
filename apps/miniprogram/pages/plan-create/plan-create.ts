import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import { clearDirtyDraft, registerDirtyDraft } from "../../services/draft-guard";
import { scopedStorageKey, readSessionScope } from "../../services/session-scope";
import type { CareProfileSummary, MedicationSummary } from "../../services/api-types";

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
  } as PlanCreatePageData,

  /** 是否有未保存草稿（非渲染字段），用于更新重启前登记与原生返回确认。 */
  dirty: false,
  discarding: false,
  draftKey: null as string | null,
  draftEntity: "new",
  restoring: false,

  onLoad(options: { medicineId?: string; medicineName?: string }): void {
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

  onUnload(): void {
    if (this.dirty && !this.discarding) this.persistDraft();
    // 离开本页时释放草稿登记与原生返回确认，避免影响其它页面。
    this.releaseDraftGuard();
  },

  /** 依据当前输入判断是否有未保存草稿，并同步登记与原生返回确认。 */
  updateDirtyState(): void {
    const data = this.data as PlanCreatePageData;
    const dirty = data.medicineName.trim() !== "" || data.dosageText.trim() !== "" ||
      data.timeSlots.length > 0 || data.endDate !== "" || data.selectedWeekdays.length > 0 || !data.everyDay;
    if (dirty && !this.data.draftAvailable) this.persistDraft();
    if (dirty === this.dirty) return;
    this.dirty = dirty;
    if (dirty) {
      registerDirtyDraft({ label: "创建用药计划表单有未保存内容。", save: () => this.submitPlan() });
      try { wx.enableAlertBeforeUnload({ message: LEAVE_WARNING }); } catch { /* 老版本无此能力，忽略 */ }
    } else {
      this.releaseDraftGuard();
    }
  },

  releaseDraftGuard(): void {
    this.dirty = false;
    clearDirtyDraft();
    try { wx.disableAlertBeforeUnload(); } catch { /* 老版本无此能力，忽略 */ }
  },

  /**
   * 载入照护对象；第一位使用者还没有任何照护对象时，
   * 先为“我自己”建立（本人计划默认私有），再打开表单。
   */
  async bootstrap(): Promise<void> {
    this.setData({ loading: true, errorMessage: "" });
    try {
      await ensureLoggedIn();
      let careProfiles = (await api.listCareProfiles()).careProfiles;
      if (careProfiles.length === 0) {
        await api.ensureSelfCareProfile("我自己");
        careProfiles = (await api.listCareProfiles()).careProfiles;
      }
      this.draftKey = scopedStorageKey("plan-create-draft", this.draftEntity);
      if (!this.dirty) this.checkStoredDraft();
      this.setData({ careProfiles, careProfileIndex: 0, loading: false });
      if (api.listMedicines) {
        const inventory = await api.listMedicines();
        this.setData({ inventoryMedicines: inventory.medicines });
      }
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "加载照护对象失败，请重试";
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
  async submitPlan(): Promise<void> {
    const data = this.data as PlanCreatePageData;
    const profile = data.careProfiles[data.careProfileIndex];
    if (!profile) throw new Error("请选择照护对象");
    const medicineName = data.medicineName.trim();
    const dosageText = data.dosageText.trim();
    if (medicineName === "") throw new Error("请填写药品名称");
    if (dosageText === "") throw new Error("请填写剂量说明，例如每次 1 片");
    if (data.timeSlots.length === 0) throw new Error("请至少添加一个每日时间点");
    if (!data.everyDay && data.selectedWeekdays.length === 0) throw new Error("指定星期需至少选择一天，或改回每天");
    if (data.endDate !== "" && data.endDate < data.startDate) throw new Error("结束日期不能早于开始日期");
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
  },

  async onSubmitPlan(): Promise<void> {
    const data = this.data as PlanCreatePageData;
    if (data.creating) return;
    this.setData({ creating: true });
    try {
      await this.submitPlan();
      this.discarding = true;
      this.removeDraft();
      this.releaseDraftGuard();
      wx.showToast({ title: "计划已保存", icon: "success" });
      // 用药计划是 tabBar 页，只能用 switchTab 返回；返回后其 onShow 会合并刷新。
      wx.switchTab({ url: "/pages/medication-plans/medication-plans" });
    } catch (error) {
      const message = error instanceof Error && error.message !== "" ? error.message : "保存失败，请重试";
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
    if (!scope || !this.draftKey || this.discarding || this.draftKey !== scopedStorageKey("plan-create-draft", this.draftEntity)) return;
    const { medicineId, medicineName, dosageText, startDate, endDate, timeInput, timeSlots, everyDay, selectedWeekdays, careProfileIndex } = this.data as PlanCreatePageData;
    wx.setStorageSync(this.draftKey, { ownerUserId: scope.userId, ownerFamilyId: scope.familyId,
      fields: { medicineId, medicineName, dosageText, startDate, endDate, timeInput, timeSlots, everyDay, selectedWeekdays, careProfileIndex } });
  },
  onRestoreDraft(): void {
    this.checkStoredDraft();
    if (!this.data.draftAvailable || !this.draftKey) return;
    const stored = wx.getStorageSync(this.draftKey) as { fields: Partial<PlanCreatePageData> };
    this.setData({ ...stored.fields, weekdayOptions: weekdayOptionsFor(stored.fields.selectedWeekdays ?? []), draftAvailable: false });
    this.updateDirtyState();
  },
  removeDraft(): void {
    if (this.draftKey) wx.removeStorageSync(this.draftKey);
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
