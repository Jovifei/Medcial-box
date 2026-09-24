import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import type {
  BatchPayload,
  ExpiryPrecision,
  MedicationBatchSummary,
  QuantityUnit,
} from "../../services/api-types";

const UNIT_VALUES: QuantityUnit[] = ["tablet", "capsule", "sachet", "bottle", "box", "other"];
const UNIT_LABELS = ["片", "粒", "袋", "瓶", "盒", "其他"];
const PRECISION_VALUES: ExpiryPrecision[] = ["day", "month", "unknown"];
const PRECISION_LABELS = ["按日（YYYY-MM-DD）", "仅到月（YYYY-MM）", "未知"];

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;

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
  unitLabels: string[];
  precisionLabels: string[];
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
    unitLabels: UNIT_LABELS,
    precisionLabels: PRECISION_LABELS,
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

  buildPayload(): { payload: BatchPayload | null; error: string | null } {
    const data = this.data as BatchEditPageData;
    const precision = PRECISION_VALUES[data.precisionIndex] ?? "day";
    let expiryValue: string | null = data.expiryValue.trim();
    if (precision === "day" && expiryValue !== "" && !DAY_PATTERN.test(expiryValue)) {
      return { payload: null, error: "按日有效期需为 YYYY-MM-DD 格式" };
    }
    if (precision === "month" && expiryValue !== "" && !MONTH_PATTERN.test(expiryValue)) {
      return { payload: null, error: "按月有效期需为 YYYY-MM 格式" };
    }
    if (precision === "unknown") expiryValue = null;

    let quantity: number | null = null;
    if (!data.quantityUnknown) {
      const parsed = Number.parseInt(data.quantity.trim(), 10);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { payload: null, error: "数量需为不小于 0 的整数，或打开“数量未知”开关" };
      }
      quantity = parsed;
    }

    let confirmedUnits: number | null = null;
    if (data.confirmedUnits.trim() !== "") {
      const parsedUnits = Number.parseInt(data.confirmedUnits.trim(), 10);
      if (!Number.isInteger(parsedUnits) || parsedUnits <= 0) {
        return { payload: null, error: "每包装换算数需为正整数（仅在本人确认后填写）" };
      }
      confirmedUnits = parsedUnits;
    }

    return {
      payload: {
        lotNumber: data.lotNumber.trim() === "" ? null : data.lotNumber.trim(),
        expiry: expiryValue === null ? null : { value: expiryValue, precision },
        quantity,
        unit: UNIT_VALUES[data.unitIndex] ?? "other",
        confirmedUnitsPerPackage: confirmedUnits,
        storageLocation: data.storageLocation.trim() === "" ? null : data.storageLocation.trim(),
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
        content: "批次删除后不可恢复（物理删除），确定删除？",
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
