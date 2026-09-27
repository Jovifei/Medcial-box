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
const PURPOSE_OPTIONS = ["未分类", "解热镇痛", "感冒咳嗽", "胃肠消化", "过敏", "外用", "其他"];

interface BatchForm {
  /** 已有批次标识（编辑时从详情带入，保存时随 payload 回传）；null = 新增。 */
  id: string | null;
  /** 已有批次版本（后端乐观锁门）。 */
  version: number | null;
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
  recognizing: boolean;
  optionalExpanded: boolean;
  recognitionHint: string;
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
  purposeOptions: string[];
  purposeIndex: number;
  captureSource: "" | "camera" | "album";
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;

function validExpiryValue(value: string, precision: ExpiryPrecision): boolean {
  if (precision === "unknown") return value === "";
  if (precision === "day" && !DAY_PATTERN.test(value)) return false;
  if (precision === "month" && !MONTH_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12) return false;
  if (precision === "month") return true;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

function emptyBatch(): BatchForm {
  return {
    id: null,
    version: null,
    lotNumber: "",
    expiryValue: "",
    precisionIndex: 2,
    quantity: "",
    quantityUnknown: true,
    unitIndex: 4,
    confirmedUnits: "",
    storageLocation: "",
  };
}

function batchFromSummary(summary: MedicationSummary): BatchForm[] {
  return summary.batches.map((batch) => ({
    id: batch.id,
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
  }));
}

function buildBatchPayloads(batches: BatchForm[]): { payloads: object[]; error: string | null } {
  const payloads: object[] = [];
  for (const batch of batches) {
    const precision = PRECISION_VALUES[batch.precisionIndex] ?? "unknown";
    let expiryValue: string | null = batch.expiryValue.trim();
    if (precision === "day" && expiryValue !== "" && !validExpiryValue(expiryValue, precision)) {
      return { payloads: [], error: "按日有效期需为真实日期 YYYY-MM-DD" };
    }
    if (precision === "month" && expiryValue !== "" && !validExpiryValue(expiryValue, precision)) {
      return { payloads: [], error: "按月有效期需为真实月份 YYYY-MM" };
    }
    if (precision === "unknown" || expiryValue === "") expiryValue = null;

    let quantity: number | null = null;
    if (!batch.quantityUnknown) {
      const raw = batch.quantity.trim();
      const parsed = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed)) {
        return { payloads: [], error: "数量需为不小于 0 的整数，或打开“数量未知”开关" };
      }
      quantity = parsed;
    }

    let confirmedUnits: number | null = null;
    if (batch.confirmedUnits.trim() !== "") {
      const rawUnits = batch.confirmedUnits.trim();
      const parsedUnits = Number(rawUnits);
      if (!/^\d+$/.test(rawUnits) || !Number.isSafeInteger(parsedUnits) || parsedUnits <= 0) {
        return { payloads: [], error: "每包装换算数需为正整数（仅在本人确认后填写）" };
      }
      confirmedUnits = parsedUnits;
    }

    payloads.push({
      // 已有批次携带 id/version（后端按版本乐观锁同步）；新增批次缺省即插入。
      ...(batch.id !== null ? { id: batch.id, version: batch.version } : {}),
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
    recognizing: false,
    optionalExpanded: false,
    recognitionHint: "",
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
    purposeOptions: PURPOSE_OPTIONS,
    purposeIndex: 0,
    captureSource: "",
  },

  /** 编辑已有药品时，识别必须等待资料加载完成，避免后返回的请求覆盖识别草稿。 */
  medicineLoadPromise: null as Promise<void> | null,

  onLoad(options: { id?: string; capture?: string }): void {
    const captureSource = options.capture === "camera" || options.capture === "album" ? options.capture : "";
    if (captureSource !== "") {
      this.setData({ captureSource });
      setTimeout(() => this.onRecognizePhoto(captureSource), 260);
    }
    if (options.id) {
      this.setData({ isEdit: true, medicineId: options.id });
      this.medicineLoadPromise = this.loadMedicine(options.id);
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
        purposeIndex: Math.max(0, PURPOSE_OPTIONS.indexOf(medicine.purposeCategory ?? "")),
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

  onToggleOptional(): void {
    this.setData({ optionalExpanded: !(this.data as MedicineEditPageData).optionalExpanded });
  },

  onPurposeChange(event: { detail: { value: string | number } }): void {
    const purposeIndex = Number(event.detail.value);
    const selected = PURPOSE_OPTIONS[purposeIndex] ?? "未分类";
    this.setData({ purposeIndex, purposeCategory: selected === "未分类" ? "" : selected });
  },

  async onRecognizePhoto(
    sourceOverride?:
      | "camera"
      | "album"
      | { currentTarget?: { dataset?: { source?: string } } },
  ): Promise<void> {
    const initialData = this.data as MedicineEditPageData;
    if (initialData.recognizing || initialData.submitting) return;
    this.setData({ recognizing: true });
    try {
      if (this.medicineLoadPromise !== null) await this.medicineLoadPromise;
      const eventSource = typeof sourceOverride === "object" ? sourceOverride.currentTarget?.dataset?.source : sourceOverride;
      const source = eventSource === "album" ? "album" : "camera";
      const selection = await wx.chooseMedia({ count: 1, mediaType: ["image"], sourceType: [source], sizeType: ["compressed"] });
      const file = selection.tempFiles[0];
      if (!file) return;
      if (file.size > 4 * 1024 * 1024) {
        wx.showToast({ title: "图片超过 4MB，请压缩后重试", icon: "none" });
        return;
      }
      const imageBase64 = await new Promise<string>((resolve, reject) => {
        wx.getFileSystemManager().readFile({
          filePath: file.tempFilePath,
          encoding: "base64",
          success: (result) => resolve(result.data as string),
          fail: reject,
        });
      });
      let mimeType: "image/jpeg" | "image/png";
      if (imageBase64.startsWith("/9j/")) mimeType = "image/jpeg";
      else if (imageBase64.startsWith("iVBORw0KGgo")) mimeType = "image/png";
      else {
        wx.showToast({ title: "请选择 JPEG 或 PNG 照片", icon: "none" });
        return;
      }
      this.setData({ recognitionHint: "正在识别药盒，请稍候…" });
      await ensureLoggedIn();
      const result = await api.recognizeMedicine(imageBase64, mimeType);
      const draft = result.draft;
      const current = this.data as MedicineEditPageData;
      const first = current.batches[0];
      const fields: Record<string, unknown> = {
        recognitionHint: result.warnings.length > 0
          ? `识别完成，请逐项核对。${result.warnings.join("；")}`
          : "识别完成，请对照包装核对后保存。有效期在另一面时可再拍一次。",
      };
      for (const key of ["name", "specification", "manufacturer", "approvalNumber", "purposeCategory"] as const) {
        if (current[key].trim() === "" && draft[key] !== null && draft[key] !== "") {
          fields[key] = draft[key];
          if (key === "purposeCategory") {
            const optionIndex = PURPOSE_OPTIONS.indexOf(draft[key]);
            if (optionIndex >= 0) fields.purposeIndex = optionIndex;
          }
        }
      }
      if (draft.specification || draft.manufacturer || draft.approvalNumber) {
        fields.optionalExpanded = true;
      }
      if (first) {
        if (first.lotNumber.trim() === "" && draft.lotNumber) {
          fields["batches[0].lotNumber"] = draft.lotNumber;
        }
        if ((first.precisionIndex === 2 || first.expiryValue.trim() === "") &&
          draft.expiryValue && draft.expiryPrecision && draft.expiryPrecision !== "unknown") {
          fields["batches[0].expiryValue"] = draft.expiryValue;
          fields["batches[0].precisionIndex"] = PRECISION_VALUES.indexOf(draft.expiryPrecision);
        }
      }
      this.setData(fields);
    } catch (error) {
      if (typeof error === "object" && error !== null && "errMsg" in error &&
        String((error as { errMsg: unknown }).errMsg).includes("cancel")) return;
      const code = error instanceof ApiError ? error.code : "";
      if (code === "RECOGNITION_UNAVAILABLE") {
        this.setData({ recognitionHint: "拍照识别暂不可用，请先填写药品名称保存。" });
      } else if (code !== "") {
        this.setData({ recognitionHint: `识别失败：${error instanceof ApiError ? error.message : "请重试或手动录入"}` });
        showError(error);
      } else {
        this.setData({ recognitionHint: "未识别图片；可重新拍照，或直接填写药名。" });
      }
    } finally {
      this.setData({ recognizing: false });
    }
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
    const initialData = this.data as MedicineEditPageData;
    if (initialData.submitting || initialData.recognizing) return;
    if (this.medicineLoadPromise !== null) await this.medicineLoadPromise;
    const data = this.data as MedicineEditPageData;
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
