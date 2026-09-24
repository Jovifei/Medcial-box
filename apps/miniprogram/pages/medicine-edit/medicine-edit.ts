import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import type {
  ExpiryPrecision,
  MedicationSummary,
  MedicinePayload,
  QuantityUnit,
} from "../../services/api-types";

const UNIT_VALUES: QuantityUnit[] = ["tablet", "capsule", "sachet", "bottle", "box", "other"];
const UNIT_LABELS = ["片", "粒", "袋", "瓶", "盒", "其他"];
const PRECISION_VALUES: ExpiryPrecision[] = ["day", "month", "unknown"];
const PRECISION_LABELS = ["按日（YYYY-MM-DD）", "仅到月（YYYY-MM）", "未知"];

interface BatchForm {
  lotNumber: string;
  expiryValue: string;
  precisionIndex: number;
  quantity: string;
  quantityUnknown: boolean;
  unitIndex: number;
  confirmedUnits: string;
  storageLocation: string;
}

interface MedicineEditPageData {
  isEdit: boolean;
  medicineId: string;
  version: number;
  submitting: boolean;
  name: string;
  specification: string;
  manufacturer: string;
  approvalNumber: string;
  ingredients: string;
  purposeCategory: string;
  leafletPurpose: string;
  leafletUsage: string;
  leafletContraindications: string;
  leafletPrecautions: string;
  leafletSource: string;
  verified: boolean;
  batches: BatchForm[];
  unitLabels: string[];
  precisionLabels: string[];
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;

function emptyBatch(): BatchForm {
  return {
    lotNumber: "",
    expiryValue: "",
    precisionIndex: 0,
    quantity: "",
    quantityUnknown: false,
    unitIndex: 4,
    confirmedUnits: "",
    storageLocation: "",
  };
}

function batchFromSummary(summary: MedicationSummary): BatchForm[] {
  return summary.batches.map((batch) => ({
    lotNumber: batch.lotNumber ?? "",
    expiryValue: batch.expiry.value ?? "",
    precisionIndex: Math.max(0, PRECISION_VALUES.indexOf(batch.expiry.precision)),
    quantity: batch.quantity === null ? "" : String(batch.quantity),
    quantityUnknown: batch.quantity === null,
    unitIndex: Math.max(0, UNIT_VALUES.indexOf(batch.unit)),
    confirmedUnits:
      batch.confirmedUnitsPerPackage === null ? "" : String(batch.confirmedUnitsPerPackage),
    storageLocation: batch.storageLocation ?? "",
  }));
}

function buildBatchPayloads(batches: BatchForm[]): { payloads: object[]; error: string | null } {
  const payloads: object[] = [];
  for (const batch of batches) {
    const precision = PRECISION_VALUES[batch.precisionIndex] ?? "day";
    let expiryValue: string | null = batch.expiryValue.trim();
    if (precision === "day" && expiryValue !== "" && !DAY_PATTERN.test(expiryValue)) {
      return { payloads: [], error: "按日有效期需为 YYYY-MM-DD 格式" };
    }
    if (precision === "month" && expiryValue !== "" && !MONTH_PATTERN.test(expiryValue)) {
      return { payloads: [], error: "按月有效期需为 YYYY-MM 格式" };
    }
    if (precision === "unknown") expiryValue = null;

    let quantity: number | null = null;
    if (!batch.quantityUnknown) {
      const parsed = Number.parseInt(batch.quantity.trim(), 10);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { payloads: [], error: "数量需为不小于 0 的整数，或打开“数量未知”开关" };
      }
      quantity = parsed;
    }

    let confirmedUnits: number | null = null;
    if (batch.confirmedUnits.trim() !== "") {
      const parsedUnits = Number.parseInt(batch.confirmedUnits.trim(), 10);
      if (!Number.isInteger(parsedUnits) || parsedUnits <= 0) {
        return { payloads: [], error: "每包装换算数需为正整数（仅在本人确认后填写）" };
      }
      confirmedUnits = parsedUnits;
    }

    payloads.push({
      lotNumber: batch.lotNumber.trim() === "" ? null : batch.lotNumber.trim(),
      expiry: expiryValue === null ? null : { value: expiryValue, precision },
      quantity,
      unit: UNIT_VALUES[batch.unitIndex] ?? "other",
      confirmedUnitsPerPackage: confirmedUnits,
      storageLocation: batch.storageLocation.trim() === "" ? null : batch.storageLocation.trim(),
    });
  }
  return { payloads, error: null };
}

function showError(error: unknown): void {
  const message = error instanceof ApiError ? error.message : "操作失败，请稍后重试";
  wx.showToast({ title: message, icon: "none", duration: 2800 });
}

Page({
  data: {
    isEdit: false,
    medicineId: "",
    version: 1,
    submitting: false,
    name: "",
    specification: "",
    manufacturer: "",
    approvalNumber: "",
    ingredients: "",
    purposeCategory: "",
    leafletPurpose: "",
    leafletUsage: "",
    leafletContraindications: "",
    leafletPrecautions: "",
    leafletSource: "",
    verified: false,
    batches: [emptyBatch()],
    unitLabels: UNIT_LABELS,
    precisionLabels: PRECISION_LABELS,
  },

  onLoad(options: { id?: string }): void {
    if (options.id) {
      this.setData({ isEdit: true, medicineId: options.id });
      this.loadMedicine(options.id);
    }
  },

  async loadMedicine(medicineId: string): Promise<void> {
    try {
      await ensureLoggedIn();
      const medicine = await api.getMedicine(medicineId);
      this.setData({
        name: medicine.name,
        specification: medicine.specification ?? "",
        manufacturer: medicine.manufacturer ?? "",
        approvalNumber: medicine.approvalNumber ?? "",
        ingredients: medicine.activeIngredients.join("、"),
        purposeCategory: medicine.purposeCategory ?? "",
        leafletPurpose: medicine.leaflet.purposeSummary ?? "",
        leafletUsage: medicine.leaflet.packageUsageSummary ?? "",
        leafletContraindications: medicine.leaflet.contraindicationsSummary ?? "",
        leafletPrecautions: medicine.leaflet.precautionsSummary ?? "",
        leafletSource: medicine.leaflet.source ?? "",
        verified: medicine.leaflet.reviewStatus === "user_confirmed",
        batches: batchFromSummary(medicine).length > 0 ? batchFromSummary(medicine) : [emptyBatch()],
        version: medicine.version,
      });
    } catch (error) {
      showError(error);
    }
  },

  onFieldInput(event: { currentTarget: { dataset: { field?: string } }; detail: { value: string } }): void {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [field]: event.detail.value });
  },

  onVerifiedChange(event: { detail: { value: boolean } }): void {
    this.setData({ verified: event.detail.value });
  },

  onBatchFieldInput(event: {
    currentTarget: { dataset: { index?: string; field?: string } };
    detail: { value: string };
  }): void {
    const index = event.currentTarget.dataset.index;
    const field = event.currentTarget.dataset.field;
    if (index === undefined || field === undefined || field === "") return;
    this.setData({ [`batches[${index}].${field}`]: event.detail.value });
  },

  onBatchPrecisionChange(event: { currentTarget: { dataset: { index?: string } }; detail: { value: string | number } }): void {
    const index = event.currentTarget.dataset.index;
    if (index === undefined) return;
    this.setData({ [`batches[${index}].precisionIndex`]: Number(event.detail.value) });
  },

  onBatchUnitChange(event: { currentTarget: { dataset: { index?: string } }; detail: { value: string | number } }): void {
    const index = event.currentTarget.dataset.index;
    if (index === undefined) return;
    this.setData({ [`batches[${index}].unitIndex`]: Number(event.detail.value) });
  },

  onBatchUnknownChange(event: { currentTarget: { dataset: { index?: string } }; detail: { value: boolean } }): void {
    const index = event.currentTarget.dataset.index;
    if (index === undefined) return;
    this.setData({ [`batches[${index}].quantityUnknown`]: event.detail.value });
  },

  onAddBatch(): void {
    const batches = (this.data as MedicineEditPageData).batches;
    this.setData({ batches: [...batches, emptyBatch()] });
  },

  onRemoveBatch(event: { currentTarget: { dataset: { index?: string } } }): void {
    const index = event.currentTarget.dataset.index;
    if (index === undefined) return;
    const batches = (this.data as MedicineEditPageData).batches;
    const next = batches.filter((_, position) => position !== Number(index));
    this.setData({ batches: next.length > 0 ? next : [emptyBatch()] });
  },

  async onSubmit(): Promise<void> {
    const data = this.data as MedicineEditPageData;
    if (data.submitting) return;
    const name = data.name.trim();
    if (name === "") {
      wx.showToast({ title: "药品名称不能为空", icon: "none" });
      return;
    }
    const built = buildBatchPayloads(data.batches);
    if (built.error !== null) {
      wx.showToast({ title: built.error, icon: "none", duration: 2800 });
      return;
    }

    const ingredients = data.ingredients
      .split(/[、,，;；\s]+/)
      .map((item) => item.trim())
      .filter((item) => item !== "");

    const payload: MedicinePayload = {
      name,
      specification: data.specification.trim() === "" ? null : data.specification.trim(),
      manufacturer: data.manufacturer.trim() === "" ? null : data.manufacturer.trim(),
      approvalNumber: data.approvalNumber.trim() === "" ? null : data.approvalNumber.trim(),
      activeIngredients: ingredients,
      purposeCategory: data.purposeCategory.trim() === "" ? null : data.purposeCategory.trim(),
      leaflet: {
        purposeSummary: data.leafletPurpose.trim() === "" ? null : data.leafletPurpose.trim(),
        packageUsageSummary: data.leafletUsage.trim() === "" ? null : data.leafletUsage.trim(),
        contraindicationsSummary:
          data.leafletContraindications.trim() === "" ? null : data.leafletContraindications.trim(),
        precautionsSummary:
          data.leafletPrecautions.trim() === "" ? null : data.leafletPrecautions.trim(),
        source: data.leafletSource.trim() === "" ? null : data.leafletSource.trim(),
        reviewStatus: data.verified ? "user_confirmed" : "unverified",
      },
      batches: built.payloads,
    };

    this.setData({ submitting: true });
    try {
      await ensureLoggedIn();
      if (data.isEdit) {
        await api.updateMedicine(data.medicineId, { ...payload, version: data.version });
        wx.showToast({ title: "已保存", icon: "success" });
      } else {
        await api.createMedicine(payload);
        wx.showToast({ title: "已录入", icon: "success" });
      }
      setTimeout(() => wx.navigateBack(), 800);
    } catch (error) {
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        wx.showModal({
          title: "保存冲突",
          content: "记录已被他人修改，请返回后刷新查看最新内容再重试。",
          showCancel: false,
        });
      } else {
        showError(error);
      }
    } finally {
      this.setData({ submitting: false });
    }
  },
});
