import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import {
  isStrictNonNegativeInteger,
  isStrictPositiveInteger,
  isValidExpiryValue,
} from "../../services/input-validation";
import type {
  AfterOpeningLimitInput,
  BatchPayload,
  ExpiryPrecision,
  MedicationBatchSummary,
  QuantityUnit,
} from "../../services/api-types";

const UNIT_VALUES: QuantityUnit[] = ["tablet", "capsule", "sachet", "bottle", "box", "other"];
const UNIT_LABELS = ["片", "粒", "袋", "瓶", "盒", "其他"];
const PRECISION_VALUES: ExpiryPrecision[] = ["day", "month", "unknown"];
const PRECISION_LABELS = ["按日（YYYY-MM-DD）", "仅到月（YYYY-MM）", "未知"];

interface BatchEditPageData {
  medicineId: string;
  batchId: string;
  isEdit: boolean;
  version: number;
  submitting: boolean;
  lotNumber: string;
  expiryValue: string;
  precisionIndex: number;
  quantity: string;
  quantityUnknown: boolean;
  unitIndex: number;
  confirmedUnits: string;
  storageLocation: string;
  openedState: "unknown" | "unopened" | "opened";
  openedAt: string;
  openingLimitMode: "none" | "day" | "month" | "date";
  openingLimitValue: string;
  openingLimitSource: string;
  openingExpanded: boolean;
  unitLabels: string[];
  precisionLabels: string[];
  openedStateLabels: string[];
  openingLimitModeLabels: string[];
  openedStateIndex: number;
  openingLimitModeIndex: number;
}

function fillFromBatch(batch: MedicationBatchSummary): Partial<BatchEditPageData> {
  return {
    batchId: batch.id,
    isEdit: true,
    version: batch.version,
    lotNumber: batch.lotNumber ?? "",
    expiryValue: batch.expiry.value ?? "",
    precisionIndex: Math.max(0, PRECISION_VALUES.indexOf(batch.expiry.precision)),
    quantity: batch.quantity === null ? "" : String(batch.quantity),
    quantityUnknown: batch.quantity === null,
    unitIndex: Math.max(0, UNIT_VALUES.indexOf(batch.unit)),
    confirmedUnits:
      batch.confirmedUnitsPerPackage === null ? "" : String(batch.confirmedUnitsPerPackage),
    storageLocation: batch.storageLocation ?? "",
    openedState: batch.openedState ?? "unknown",
    openedAt: batch.openedAt ?? "",
    openingLimitMode: batch.afterOpeningLimit === null || batch.afterOpeningLimit === undefined
      ? "none"
      : "date" in batch.afterOpeningLimit ? "date" : batch.afterOpeningLimit.unit,
    openingLimitValue: batch.afterOpeningLimit === null || batch.afterOpeningLimit === undefined
      ? ""
      : "date" in batch.afterOpeningLimit ? batch.afterOpeningLimit.date : String(batch.afterOpeningLimit.value),
    openingLimitSource: batch.afterOpeningLimit?.source ?? "",
    openingExpanded: batch.openedState === "opened" || batch.afterOpeningLimit !== null && batch.afterOpeningLimit !== undefined,
    openedStateIndex: Math.max(0, ["unknown", "unopened", "opened"].indexOf(batch.openedState ?? "unknown")),
    openingLimitModeIndex: Math.max(0, ["none", "day", "month", "date"].indexOf(
      batch.afterOpeningLimit === null || batch.afterOpeningLimit === undefined
        ? "none"
        : "date" in batch.afterOpeningLimit ? "date" : batch.afterOpeningLimit.unit,
    )),
  };
}

function showError(error: unknown): void {
  const message = error instanceof ApiError ? error.message : "操作失败，请稍后重试";
  wx.showToast({ title: message, icon: "none", duration: 2800 });
}

Page({
  data: {
    medicineId: "",
    batchId: "",
    isEdit: false,
    version: 1,
    submitting: false,
    lotNumber: "",
    expiryValue: "",
    precisionIndex: 0,
    quantity: "",
    quantityUnknown: false,
    unitIndex: 4,
    confirmedUnits: "",
    storageLocation: "",
    openedState: "unknown" as BatchEditPageData["openedState"],
    openedAt: "",
    openingLimitMode: "none" as BatchEditPageData["openingLimitMode"],
    openingLimitValue: "",
    openingLimitSource: "",
    openingExpanded: false,
    unitLabels: UNIT_LABELS,
    precisionLabels: PRECISION_LABELS,
    openedStateLabels: ["未记录", "未开封", "已开封"],
    openingLimitModeLabels: ["不记录", "开封后天数", "开封后月数", "指定截止日期"],
    openedStateIndex: 0,
    openingLimitModeIndex: 0,
  },

  onLoad(options: { medicineId?: string; batchId?: string }): void {
    if (!options.medicineId) {
      wx.showToast({ title: "缺少药品参数", icon: "none" });
      setTimeout(() => wx.navigateBack(), 900);
      return;
    }
    this.setData({ medicineId: options.medicineId });
    if (options.batchId) this.loadBatch(options.medicineId, options.batchId);
  },

  async loadBatch(medicineId: string, batchId: string): Promise<void> {
    try {
      await ensureLoggedIn();
      const medicine = await api.getMedicine(medicineId);
      const batch = medicine.batches.find((item) => item.id === batchId);
      if (batch === undefined) {
        wx.showToast({ title: "批次不存在或不可见", icon: "none" });
        setTimeout(() => wx.navigateBack(), 900);
        return;
      }
      this.setData(fillFromBatch(batch));
    } catch (error) {
      showError(error);
    }
  },

  onFieldInput(event: { currentTarget: { dataset: { field?: string } }; detail: { value: string } }): void {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [field]: event.detail.value });
  },

  onPrecisionChange(event: { detail: { value: string | number } }): void {
    this.setData({ precisionIndex: Number(event.detail.value) });
  },

  onUnitChange(event: { detail: { value: string | number } }): void {
    this.setData({ unitIndex: Number(event.detail.value) });
  },

  onUnknownChange(event: { detail: { value: boolean } }): void {
    this.setData({ quantityUnknown: event.detail.value });
  },

  onOpenedStateChange(event: { detail: { value: string | number } }): void {
    const index = Number(event.detail.value);
    const openedState = (["unknown", "unopened", "opened"] as const)[index] ?? "unknown";
    const patch: Partial<BatchEditPageData> = { openedState, openedStateIndex: index };
    if (openedState !== "opened") {
      patch.openedAt = "";
      patch.openingLimitMode = "none";
      patch.openingLimitModeIndex = 0;
      patch.openingLimitValue = "";
    }
    this.setData(patch);
  },

  onOpeningLimitModeChange(event: { detail: { value: string | number } }): void {
    const index = Number(event.detail.value);
    const openingLimitMode = (["none", "day", "month", "date"] as const)[index] ?? "none";
    this.setData({ openingLimitMode, openingLimitModeIndex: index,
      ...(openingLimitMode === "none" ? { openingLimitValue: "" } : {}) });
  },

  onToggleOpeningInfo(): void {
    this.setData({ openingExpanded: !this.data.openingExpanded });
  },

  buildPayload(): { payload: BatchPayload | null; error: string | null } {
    const data = this.data as BatchEditPageData;
    const precision = PRECISION_VALUES[data.precisionIndex] ?? "day";
    let expiryValue: string | null = data.expiryValue.trim();
    if (precision === "day" && expiryValue !== "" && !isValidExpiryValue(expiryValue, precision)) {
      return { payload: null, error: "按日有效期需为真实日期 YYYY-MM-DD" };
    }
    if (precision === "month" && expiryValue !== "" && !isValidExpiryValue(expiryValue, precision)) {
      return { payload: null, error: "按月有效期需为真实月份 YYYY-MM" };
    }
    if (precision === "unknown") expiryValue = null;

    if (data.openedAt.trim() !== "" && !isValidExpiryValue(data.openedAt.trim(), "day")) {
      return { payload: null, error: "开封日期需为真实日期 YYYY-MM-DD" };
    }
    let afterOpeningLimit: AfterOpeningLimitInput | null = null;
    if (data.openedState === "opened") {
      const source = data.openingLimitSource.trim() === "" ? null : data.openingLimitSource.trim();
      if (data.openingLimitMode === "day" || data.openingLimitMode === "month") {
        const rawLimit = data.openingLimitValue.trim();
        if (!isStrictPositiveInteger(rawLimit)) {
          return { payload: null, error: "开封后期限需为正整数；不清楚时可保持不记录" };
        }
        afterOpeningLimit = { value: Number(rawLimit), unit: data.openingLimitMode, source };
      } else if (data.openingLimitMode === "date") {
        const date = data.openingLimitValue.trim();
        if (!isValidExpiryValue(date, "day")) {
          return { payload: null, error: "开封后截止日期需为真实日期 YYYY-MM-DD" };
        }
        afterOpeningLimit = { date, source };
      }
    }

    let quantity: number | null = null;
    if (!data.quantityUnknown) {
      const raw = data.quantity.trim();
      if (!isStrictNonNegativeInteger(raw)) {
        return { payload: null, error: "数量需为不小于 0 的整数，或打开“数量未知”开关" };
      }
      quantity = Number(raw);
    }

    let confirmedUnits: number | null = null;
    if (data.confirmedUnits.trim() !== "") {
      const rawUnits = data.confirmedUnits.trim();
      if (!isStrictPositiveInteger(rawUnits)) {
        return { payload: null, error: "每包装换算数需为正整数（仅在本人确认后填写）" };
      }
      confirmedUnits = Number(rawUnits);
    }

    return {
      payload: {
        lotNumber: data.lotNumber.trim() === "" ? null : data.lotNumber.trim(),
        expiry: expiryValue === null ? null : { value: expiryValue, precision },
        quantity,
        unit: UNIT_VALUES[data.unitIndex] ?? "other",
        confirmedUnitsPerPackage: confirmedUnits,
        storageLocation: data.storageLocation.trim() === "" ? null : data.storageLocation.trim(),
        openedState: data.openedState,
        openedAt: data.openedState === "opened" && data.openedAt.trim() !== "" ? data.openedAt.trim() : null,
        afterOpeningLimit,
      },
      error: null,
    };
  },

  async onSubmit(): Promise<void> {
    const data = this.data as BatchEditPageData;
    if (data.submitting) return;
    const built = this.buildPayload();
    if (built.payload === null) {
      wx.showToast({ title: built.error ?? "输入不合法", icon: "none", duration: 2800 });
      return;
    }
    this.setData({ submitting: true });
    try {
      await ensureLoggedIn();
      if (data.isEdit) {
        await api.updateBatch(data.medicineId, data.batchId, {
          ...built.payload,
          version: data.version,
        });
        wx.showToast({ title: "已保存", icon: "success" });
      } else {
        await api.createBatch(data.medicineId, built.payload);
        wx.showToast({ title: "已添加批次", icon: "success" });
      }
      setTimeout(() => wx.navigateBack(), 800);
    } catch (error) {
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        wx.showModal({
          title: "保存冲突",
          content: "批次已被他人修改，请返回后刷新查看最新值再重试。",
          showCancel: false,
        });
      } else {
        showError(error);
      }
    } finally {
      this.setData({ submitting: false });
    }
  },

  async onDelete(): Promise<void> {
    const data = this.data as BatchEditPageData;
    if (!data.isEdit) return;
    const confirmation = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: "删除批次",
        content: "该批次会移入最近删除，并可在 30 天内恢复。确认移入？",
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmation) return;
    try {
      await ensureLoggedIn();
      await api.deleteBatch(data.medicineId, data.batchId);
      wx.showToast({ title: "已删除", icon: "success" });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (error) {
      showError(error);
    }
  },
});
