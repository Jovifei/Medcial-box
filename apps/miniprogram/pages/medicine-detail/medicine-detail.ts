import { PURPOSE_TAG_OPTIONS, purposeCategoryLabel } from "../../services/medicine-tags";
import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import {
  isStrictPositiveInteger,
  isValidExpiryValue,
  parseQuantityByUnit,
  unitAllowsDecimals,
  UNIT_VALUES,
  UNIT_LABELS as UNIT_PICKER_LABELS,
} from "../../services/input-validation";
import type {
  AfterOpeningLimitInput,
  DosageNoteSummary,
  LeafletPhotoSummary,
  MedicationBatchSummary,
  MedicationSummary,
  QuantityUnit,
  SplitBatchPayload,
} from "../../services/api-types";

const UNIT_LABELS: Record<QuantityUnit, string> = {
  tablet: "片",
  capsule: "粒",
  sachet: "袋",
  bottle: "瓶",
  tube: "支",
  box: "盒",
  blister: "板",
  ml: "毫升",
  other: "个单位",
};

interface BatchView {
  id: string;
  quantity: number | null;
  unit: QuantityUnit;
  canSplitOpen: boolean;
  maxOpenQuantity: number;
  unitShort: string;
  title: string;
  quantityText: string;
  expiryText: string;
  storageText: string;
  confirmedText: string;
  state: string;
  openingText: string;
  needsOpeningInfo: boolean;
  canMarkOpened: boolean;
}

interface NoteView {
  id: string;
  ownerLabel: string;
  content: string;
  isMine: boolean;
}

interface LeafletPhotoView extends LeafletPhotoSummary {
  sourceLabel: string;
  sizeText: string;
  typeLabel: string;
}

interface MedicineDetailPageData {
  quantityPanelId: string;
  quantityPanelInput: string;
  quantityPanelBusy: boolean;
  medicineId: string;
  medicineSummary: MedicationSummary | null;
  loading: boolean;
  name: string;
  specText: string;
  /** 人群/用途整理标签（R2-d）：kind 决定配色，蓝=成人、绿=儿童、紫=用途。 */
  displayTags: Array<{ kind: string; label: string }>;
  metaText: string;
  leafletText: string;
  leafletBadge: string;
  leafletPhotos: LeafletPhotoView[];
  /** 药盒封面（R2-d 剩余）：私有图片需带鉴权下载，不能直接给 <image> 远程地址。 */
  coverPhotoPath: string;
  coverPhotoLoading: boolean;
  coverPhotoError: string;
  /** 折叠区域（方案 §5.6）：说明书与来源、个人备注、低库存设置。 */
  sections: { leaflet: boolean; notes: boolean; stock: boolean };
  photoLoading: boolean;
  photoUploading: boolean;
  photoBusyId: string;
  photoError: string;
  photoStatus: string;
  batches: BatchView[];
  notes: NoteView[];
  noteInput: string;
  noteVisibilityLabels: string[];
  noteVisibilityIndex: number;
  thresholdEnabled: boolean;
  thresholdQuantity: string;
  thresholdUnitIndex: number;
  thresholdUnitLabels: string[];
  thresholdUnitValues: QuantityUnit[];
  stockStatusText: string;
  savingThreshold: boolean;
  restockBusy: boolean;
  busyBatchId: string;
  batchRecords: MedicationBatchSummary[];
  openingSplitBatchId: string;
  openingSplitQuantity: string;
  openingSplitDate: string;
  openingSplitMode: "none" | "day" | "month" | "date";
  openingSplitModeIndex: number;
  openingSplitModeLabels: string[];
  openingSplitValue: string;
  openingSplitSource: string;
  openingSplitPreview: string;
  openingSplitError: string;
  openingSplitBusy: boolean;
}

function quantityText(batch: MedicationBatchSummary): string {
  if (batch.quantity === null) return "数量未知";
  if (batch.quantity === 0) return "已耗尽";
  return `${batch.quantity} ${UNIT_LABELS[batch.unit] ?? "个单位"}`;
}

function toBatchView(batch: MedicationBatchSummary): BatchView {
  const opened = batch.openedState === "opened";
  const openingText = !opened ? "开封状态未记录" : batch.openedAt === null || batch.openedAt === undefined
    ? "已开封 · 日期待补充"
    : `已开封 · ${batch.openedAt}${batch.openedExpiryDate ? ` · 开封期限至 ${batch.openedExpiryDate}` : ""}`;
  return {
    id: batch.id,
    quantity: batch.quantity,
    unit: batch.unit,
    canSplitOpen: batch.quantity !== null && batch.quantity > 1,
    maxOpenQuantity: batch.quantity === null ? 0 : Math.max(0, batch.quantity - 1),
    unitShort: UNIT_LABELS[batch.unit] ?? "个单位",
    title: batch.lotNumber === null ? "批次号未记录" : `批次号 ${batch.lotNumber}`,
    quantityText: quantityText(batch),
    expiryText: batch.managementExpiryState?.label ?? batch.expiryState.label,
    storageText: batch.storageLocation === null ? "存放位置未记录" : `存放位置：${batch.storageLocation}`,
    confirmedText:
      batch.confirmedUnitsPerPackage === null
        ? ""
        : `每包装含 ${batch.confirmedUnitsPerPackage} 个最小单位（本人已确认）`,
    state: (batch.managementExpiryState?.state ?? batch.expiryState.state) === "expiring_soon"
      ? "soon"
      : (batch.managementExpiryState?.state ?? batch.expiryState.state) === "due_this_month"
        ? "due"
        : batch.managementExpiryState?.state ?? batch.expiryState.state,
    openingText,
    needsOpeningInfo: opened && (batch.openedAt === null || batch.openedAt === undefined ||
      ((batch.afterOpeningLimit === null || batch.afterOpeningLimit === undefined) &&
        (batch.openedExpiryDate === null || batch.openedExpiryDate === undefined))),
    canMarkOpened: !opened,
  };
}

function leafletDescription(medicine: MedicationSummary): { text: string; badge: string } {
  const leaflet = medicine.leaflet;
  if (leaflet.reviewStatus === "unverified") {
    return { text: "说明书摘要未核验：未对照包装内说明书前，不作为用药依据。", badge: "未核验" };
  }
  const parts: string[] = [];
  const push = (title: string, value: string | null): void => {
    if (value !== null && value !== "") parts.push(`${title}：${value}`);
  };
  push("用途", leaflet.purposeSummary);
  push("用法用量", leaflet.packageUsageSummary);
  push("禁忌", leaflet.contraindicationsSummary);
  push("注意事项", leaflet.precautionsSummary);
  const source = leaflet.source === null ? "" : `（来源：${leaflet.source}）`;
  const status = leaflet.reviewStatus === "user_confirmed" ? "本人已核对" : "资料匹配";
  const text = parts.length === 0 ? "已核对，暂无摘要内容。" : `${status}${source}：${parts.join("；")}`;
  return { text, badge: status };
}

function toNoteView(note: DosageNoteSummary): NoteView {
  return {
    id: note.id,
    ownerLabel: note.isMine ? "本人" : "家庭成员",
    content: note.content,
    isMine: note.isMine,
  };
}

const PURPOSE_TAG_LABELS: Record<string, string> = Object.fromEntries(PURPOSE_TAG_OPTIONS.map((item) => [item.kind, item.label]));

/** 详情页标签行：蓝=成人、绿=儿童、紫=用途；不作为适龄或适应症判断。 */
function buildDisplayTags(medicine: MedicationSummary): Array<{ kind: string; label: string }> {
  return [
    ...(medicine.populationTags ?? []).map((tag) => ({ kind: tag === "adult" ? "pop-adult" : "pop-child", label: tag === "adult" ? "成人" : "儿童" })),
    ...(medicine.purposeTags ?? []).map((tag) => ({ kind: "purpose", label: PURPOSE_TAG_LABELS[tag] ?? tag })),
  ];
}

function toLeafletPhotoView(photo: LeafletPhotoSummary): LeafletPhotoView {
  const sourceLabels: Record<string, string> = { package_leaflet: "包装内说明书" };
  const size = photo.sizeBytes < 1024 * 1024
    ? `${Math.max(1, Math.round(photo.sizeBytes / 1024))} KB`
    : `${(photo.sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  return {
    ...photo,
    sourceLabel: sourceLabels[photo.source] ?? "家庭成员补拍",
    sizeText: size,
    typeLabel: photo.contentType === "image/png" ? "PNG" : "JPEG",
  };
}

function isUserCancelled(error: unknown): boolean {
  return typeof error === "object" && error !== null && "errMsg" in error &&
    String((error as { errMsg: unknown }).errMsg).includes("cancel");
}

function showError(error: unknown): void {
  const message = error instanceof ApiError ? error.message : "操作失败，请稍后重试";
  wx.showToast({ title: message, icon: "none", duration: 2800 });
}

function shanghaiToday(): string {
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
}

Page({
  data: {
    quantityPanelId: "",
    quantityPanelInput: "",
    quantityPanelBusy: false,
    medicineId: "",
    medicineSummary: null as MedicationSummary | null,
    loading: true,
    name: "",
    specText: "",
    displayTags: [] as Array<{ kind: string; label: string }>,
    metaText: "",
    leafletText: "",
    leafletBadge: "",
    leafletPhotos: [] as LeafletPhotoView[],
    coverPhotoPath: "",
    coverPhotoLoading: false,
    coverPhotoError: "",
    sections: { leaflet: false, notes: false, stock: false },
    photoLoading: false,
    photoUploading: false,
    photoBusyId: "",
    photoError: "",
    photoStatus: "",
    batches: [] as BatchView[],
    notes: [] as NoteView[],
    noteInput: "",
    noteVisibilityLabels: ["仅本人可见", "全家可见"],
    noteVisibilityIndex: 0,
    thresholdEnabled: false,
    thresholdQuantity: "",
    thresholdUnitIndex: 4,
    // R07：阈值单位复用共享单位表（含板/毫升），与整体录入、批次编辑同一处维护，
    // 避免详情阈值把 10ml 误回读成 index0“片”、保存后变 10 tablet。
    thresholdUnitLabels: UNIT_PICKER_LABELS,
    thresholdUnitValues: UNIT_VALUES,
    stockStatusText: "库存待核对",
    savingThreshold: false,
    restockBusy: false,
    busyBatchId: "",
    batchRecords: [] as MedicationBatchSummary[],
    openingSplitBatchId: "",
    openingSplitQuantity: "1",
    openingSplitDate: "",
    openingSplitMode: "none" as MedicineDetailPageData["openingSplitMode"],
    openingSplitModeIndex: 0,
    openingSplitModeLabels: ["不记录", "开封后天数", "开封后月数", "指定截止日期"],
    openingSplitValue: "",
    openingSplitSource: "",
    openingSplitPreview: "",
    openingSplitError: "",
    openingSplitBusy: false,
  },

  onLoad(options: { id?: string }): void {
    if (!options.id) {
      wx.showToast({ title: "缺少药品参数", icon: "none" });
      setTimeout(() => wx.navigateBack(), 900);
      return;
    }
    this.setData({ medicineId: options.id });
  },

  onShow(): void {
    if ((this.data as MedicineDetailPageData).medicineId !== "") {
      this.refresh();
    }
  },

  async refresh(): Promise<void> {
    const medicineId = (this.data as MedicineDetailPageData).medicineId;
    this.setData({ loading: true });
    try {
      await ensureLoggedIn();
      const medicine = await api.getMedicine(medicineId);
      const notes = await api.listDosageNotes(medicineId);
      this.applyData(medicine, notes.notes);
      await Promise.all([this.refreshLeafletPhotos(), this.refreshCoverPhoto()]);
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ loading: false });
    }
  },

  applyData(medicine: MedicationSummary, notes: DosageNoteSummary[]): void {
    const metaParts: string[] = [];
    if (medicine.brand) metaParts.push(`品牌：${medicine.brand}`);
    if (medicine.manufacturer !== null) metaParts.push(`厂家：${medicine.manufacturer}`);
    if (medicine.approvalNumber !== null) metaParts.push(`批准文号：${medicine.approvalNumber}`);
    if (medicine.activeIngredients.length > 0) {
      metaParts.push(`成分：${medicine.activeIngredients.join("、")}`);
    }
    if (medicine.purposeCategory !== null) metaParts.push(`用途分类：${purposeCategoryLabel(medicine.purposeCategory)}`);
    const leaflet = leafletDescription(medicine);
    const threshold = medicine.lowStockThreshold ?? null;
    const stockLabel: Record<string, string> = {
      ok: "库存充足",
      low: "库存不足",
      unknown: "库存待核对",
      exhausted: "已耗尽",
    };
    this.setData({
      medicineSummary: medicine,
      name: medicine.name,
      specText: medicine.specification ?? "规格未记录",
      displayTags: buildDisplayTags(medicine),
      metaText: metaParts.length === 0 ? "暂无补充资料" : metaParts.join("；"),
      leafletText: leaflet.text,
      leafletBadge: leaflet.badge,
      batches: medicine.batches.map(toBatchView),
      batchRecords: medicine.batches,
      notes: notes.map(toNoteView),
      thresholdEnabled: threshold !== null,
      thresholdQuantity: threshold === null ? "" : String(threshold.quantity),
      thresholdUnitIndex: threshold === null ? 4 : Math.max(0, UNIT_VALUES.indexOf(threshold.unit)),
      stockStatusText: stockLabel[medicine.stockStatus?.state ?? "unknown"] ?? "库存待核对",
    });
  },

  async refreshLeafletPhotos(): Promise<void> {
    const medicineId = (this.data as MedicineDetailPageData).medicineId;
    if (medicineId === "") return;
    this.setData({ photoLoading: true, photoError: "" });
    try {
      await ensureLoggedIn();
      const result = await api.listLeafletPhotos(medicineId);
      this.setData({ leafletPhotos: result.photos.map(toLeafletPhotoView) });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "暂时无法读取说明书照片";
      this.setData({ leafletPhotos: [], photoError: message });
    } finally {
      this.setData({ photoLoading: false });
    }
  },

  /**
   * 药盒封面：私有图片接口需要 Bearer 鉴权，<image> 无法直接带 header，
   * 因此用 wx.downloadFile 带授权头下载到本地临时文件再展示；
   * 失败时只提示，不影响详情其余内容。
   */
  async refreshCoverPhoto(): Promise<void> {
    const data = this.data as MedicineDetailPageData;
    const coverId = data.medicineSummary?.coverPhotoId ?? null;
    if (data.medicineId === "" || coverId === null || coverId === undefined || coverId === "") {
      this.setData({ coverPhotoPath: "", coverPhotoError: "" });
      return;
    }
    this.setData({ coverPhotoLoading: true, coverPhotoError: "" });
    try {
      await ensureLoggedIn();
      const tempFilePath = await api.downloadLeafletPhoto(data.medicineId, coverId);
      this.setData({ coverPhotoPath: tempFilePath, coverPhotoLoading: false });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "封面图片读取失败";
      this.setData({ coverPhotoPath: "", coverPhotoError: message, coverPhotoLoading: false });
    }
  },

  async onAddLeafletPhoto(): Promise<void> {
    const data = this.data as MedicineDetailPageData;
    if (data.medicineId === "" || data.photoUploading || data.photoBusyId !== "") return;
    const mediaApi = wx as unknown as {
      showActionSheet?: (options: { itemList: string[]; success: (result: { tapIndex: number }) => void; fail: (error: unknown) => void }) => void;
      chooseMedia?: (options: { count: number; mediaType: string[]; sourceType: string[]; sizeType: string[]; success: (result: { tempFiles: Array<{ tempFilePath: string; size: number }> }) => void; fail: (error: unknown) => void }) => void;
    };
    if (typeof mediaApi.showActionSheet !== "function" || typeof mediaApi.chooseMedia !== "function") {
      this.setData({ photoError: "当前微信版本不支持拍摄或选择照片，请升级微信后重试。" });
      return;
    }
    this.setData({ photoUploading: true, photoError: "", photoStatus: "正在选择照片…" });
    try {
      const sourceIndex = await new Promise<number | null>((resolve) => mediaApi.showActionSheet?.({
        itemList: ["拍摄说明书", "从相册选择"],
        success: (result) => resolve(result.tapIndex),
        fail: () => resolve(null),
      }));
      if (sourceIndex === null) return;
      if (sourceIndex !== 0 && sourceIndex !== 1) return;
      const source = sourceIndex === 0 ? "camera" : "album";
      const selection = await new Promise<{ tempFiles: Array<{ tempFilePath: string; size: number }> }>((resolve, reject) => mediaApi.chooseMedia?.({
        count: 1,
        mediaType: ["image"],
        sourceType: [source],
        sizeType: ["compressed"],
        success: resolve,
        fail: reject,
      }));
      const file = selection.tempFiles[0];
      if (!file) {
        this.setData({ photoStatus: "没有选择照片；图片未上传。" });
        return;
      }
      if (!Number.isFinite(file.size) || file.size <= 0 || file.size > 6 * 1024 * 1024) {
        this.setData({ photoError: "照片需为 6 MB 以内的有效 JPEG 或 PNG，请压缩后重试。", photoStatus: "" });
        return;
      }
      const imageBase64 = await new Promise<string>((resolve, reject) => wx.getFileSystemManager().readFile({
        filePath: file.tempFilePath,
        encoding: "base64",
        success: (result) => resolve(String(result.data)),
        fail: reject,
      }));
      const mimeType = imageBase64.startsWith("/9j/") ? "image/jpeg" :
        imageBase64.startsWith("iVBORw0KGgo") ? "image/png" : null;
      if (mimeType === null) {
        this.setData({ photoError: "这张照片不是支持的 JPEG 或 PNG 格式，图片未上传。", photoStatus: "" });
        return;
      }
      this.setData({ photoStatus: "请确认是否上传这张照片。" });
      const confirmed = await new Promise<boolean>((resolve) => wx.showModal({
        title: "上传说明书照片",
        content: "所选照片将保存到当前家庭药箱的私有图片空间，家庭成员可查看；不会自动发送给识别模型或联网资料服务。是否上传？",
        confirmText: "上传照片",
        cancelText: "暂不上传",
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      }));
      if (!confirmed) {
        this.setData({ photoStatus: "已取消上传；照片仍只在本机，未上传。" });
        return;
      }
      this.setData({ photoStatus: "正在上传说明书照片到家庭私有图片空间…" });
      await ensureLoggedIn();
      await api.uploadLeafletPhoto(data.medicineId, imageBase64, mimeType, "package_leaflet");
      this.setData({ photoStatus: "说明书照片已保存到家庭私有图片空间。" });
      await this.refreshLeafletPhotos();
    } catch (error) {
      if (isUserCancelled(error)) {
        this.setData({ photoStatus: "已取消选择；照片未上传。" });
        return;
      }
      const message = error instanceof ApiError ? error.message : "说明书照片上传失败，请稍后重试。";
      this.setData({ photoError: message, photoStatus: "" });
    } finally {
      this.setData({ photoUploading: false });
    }
  },

  async onPreviewLeafletPhoto(event: { currentTarget: { dataset: { id?: string } } }): Promise<void> {
    const photoId = event.currentTarget.dataset.id;
    const data = this.data as MedicineDetailPageData;
    if (!photoId || data.photoBusyId !== "" || data.photoUploading) return;
    this.setData({ photoBusyId: photoId, photoError: "" });
    try {
      await ensureLoggedIn();
      const localPath = await api.downloadLeafletPhoto(data.medicineId, photoId);
      await new Promise<void>((resolve, reject) => wx.previewImage({
        current: localPath,
        urls: [localPath],
        success: () => resolve(),
        fail: reject,
      }));
    } catch (error) {
      if (isUserCancelled(error)) return;
      this.setData({ photoError: error instanceof ApiError ? error.message : "说明书照片预览失败，请重试。" });
    } finally {
      this.setData({ photoBusyId: "" });
    }
  },

  async onDeleteLeafletPhoto(event: { currentTarget: { dataset: { id?: string } } }): Promise<void> {
    const photoId = event.currentTarget.dataset.id;
    const data = this.data as MedicineDetailPageData;
    const photo = data.leafletPhotos.find((item) => item.id === photoId);
    if (!photoId || photo === undefined || data.photoBusyId !== "" || data.photoUploading) return;
    const confirmed = await new Promise<boolean>((resolve) => wx.showModal({
      title: "移除说明书照片",
      content: "照片将从家庭可见列表中移除，不会删除药品或库存记录。确定移除？",
      success: (result) => resolve(result.confirm),
      fail: () => resolve(false),
    }));
    if (!confirmed) return;
    this.setData({ photoBusyId: photoId, photoError: "" });
    try {
      await ensureLoggedIn();
      await api.deleteLeafletPhoto(data.medicineId, photoId);
      this.setData({ photoStatus: "说明书照片已移除。" });
      await this.refreshLeafletPhotos();
    } catch (error) {
      this.setData({ photoError: error instanceof ApiError ? error.message : "说明书照片移除失败，请重试。" });
    } finally {
      this.setData({ photoBusyId: "" });
    }
  },

  onThresholdToggle(event: { detail: { value: boolean } }): void {
    this.setData({ thresholdEnabled: event.detail.value });
  },

  onThresholdQuantityInput(event: { detail: { value: string } }): void {
    this.setData({ thresholdQuantity: event.detail.value });
  },

  onThresholdUnitChange(event: { detail: { value: string | number } }): void {
    const data = this.data as MedicineDetailPageData;
    const nextIndex = Number(event.detail.value);
    const nextUnit = UNIT_VALUES[nextIndex];
    const currentUnit = UNIT_VALUES[data.thresholdUnitIndex];
    if (nextUnit === undefined || nextUnit === currentUnit) return;
    // 切单位守卫（与整体录入/批次编辑一致）：数字不自动换算，已填值时由用户确认。
    if (data.thresholdQuantity.trim() === "") {
      this.setData({ thresholdUnitIndex: nextIndex });
      return;
    }
    wx.showModal({
      title: "切换单位",
      content: "单位不会自动换算已填的数字。例如把 10 毫升改成 10 片，保存后仍是 10。请核对后再保存。",
      confirmText: "仍要切换",
      cancelText: "保持原单位",
      success: (result) => {
        if (result.confirm) this.setData({ thresholdUnitIndex: nextIndex });
      },
    });
  },

  async onSaveThreshold(): Promise<void> {
    const data = this.data as MedicineDetailPageData;
    const medicine = data.medicineSummary;
    if (medicine === null || data.savingThreshold) return;
    let lowStockThreshold: { quantity: number; unit: QuantityUnit } | null = null;
    if (data.thresholdEnabled) {
      // R07：按所选单位解析——毫升允许最多 3 位小数，计件单位仍要求非负整数；
      // 关闭开关＝未知（null），开启且填 0＝阈值为 0，两者语义分开。
      const unit = data.thresholdUnitValues[data.thresholdUnitIndex] ?? "box";
      const parsed = parseQuantityByUnit(data.thresholdQuantity, unit);
      if (parsed === null) {
        wx.showToast({
          title: unitAllowsDecimals(unit) ? "阈值需填写不小于 0 的数字（最多 3 位小数）" : "阈值需填写不小于 0 的整数",
          icon: "none",
        });
        return;
      }
      lowStockThreshold = { quantity: parsed, unit };
    }
    this.setData({ savingThreshold: true });
    try {
      await ensureLoggedIn();
      await api.updateMedicine(medicine.id, {
        name: medicine.name,
        specification: medicine.specification,
        manufacturer: medicine.manufacturer,
        approvalNumber: medicine.approvalNumber,
        activeIngredients: medicine.activeIngredients,
        purposeCategory: medicine.purposeCategory,
        leaflet: medicine.leaflet,
        lowStockThreshold,
        version: medicine.version,
      });
      wx.showToast({ title: "库存提醒已保存", icon: "success" });
      await this.refresh();
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ savingThreshold: false });
    }
  },

  async onAddToRestock(): Promise<void> {
    const data = this.data as MedicineDetailPageData;
    const medicine = data.medicineSummary;
    if (medicine === null || data.restockBusy) return;
    const threshold = medicine.lowStockThreshold ?? null;
    const unit = threshold?.unit ?? medicine.batches[0]?.unit ?? "box";
    this.setData({ restockBusy: true });
    try {
      await ensureLoggedIn();
      await api.createRestockItem({
        medicineId: medicine.id,
        desiredQuantity: threshold?.quantity ?? null,
        unit,
      });
      wx.showToast({ title: "已加入补货清单", icon: "success" });
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ restockBusy: false });
    }
  },

  updateOpeningSplitPreview(quantityText: string, batchId: string): void {
    const batch = (this.data as MedicineDetailPageData).batchRecords.find((item) => item.id === batchId);
    const measured = batch !== undefined && unitAllowsDecimals(batch.unit);
    // 计件单位至少要有 2 个才能拆出 1 个；毫升只要余量为正即可继续拆分。
    if (batch === undefined || batch.quantity === null || batch.quantity <= (measured ? 0 : 1)) {
      this.setData({ openingSplitPreview: "", openingSplitError: "此批次数量不足以拆分。" });
      return;
    }
    const unitLabel = UNIT_LABELS[batch.unit] ?? "个单位";
    const openedQuantity = parseQuantityByUnit(quantityText, batch.unit);
    if (openedQuantity === null || openedQuantity <= 0) {
      this.setData({
        openingSplitPreview: "",
        openingSplitError: measured
          ? "开封数量需为大于 0 的毫升数（最多 3 位小数）。"
          : "开封数量必须是 1 到 " + (batch.quantity - 1) + " 之间的整数。",
      });
      return;
    }
    if (openedQuantity >= batch.quantity) {
      this.setData({ openingSplitPreview: "", openingSplitError: "开封数量需小于当前余量 " + batch.quantity + unitLabel + "，须保留正余量。" });
      return;
    }
    const remaining = Math.round((batch.quantity - openedQuantity) * 1000) / 1000;
    this.setData({
      openingSplitPreview: "本次开封 " + openedQuantity + unitLabel + "；未开封余量 " + remaining + unitLabel,
      openingSplitError: "",
    });
  },

  onSplitQuantityInput(event: { detail: { value: string } }): void {
    const data = this.data as MedicineDetailPageData;
    if (data.openingSplitBusy) return;
    const value = event.detail.value;
    this.setData({ openingSplitQuantity: value });
    this.updateOpeningSplitPreview(value, data.openingSplitBatchId);
  },

  onSplitDateChange(event: { detail: { value: string } }): void {
    if ((this.data as MedicineDetailPageData).openingSplitBusy) return;
    this.setData({ openingSplitDate: event.detail.value });
  },

  onSplitLimitModeChange(event: { detail: { value: string | number } }): void {
    if ((this.data as MedicineDetailPageData).openingSplitBusy) return;
    const index = Number(event.detail.value);
    const mode = (["none", "day", "month", "date"] as const)[index] ?? "none";
    this.setData({
      openingSplitMode: mode,
      openingSplitModeIndex: index,
      openingSplitValue: mode === "none" ? "" : this.data.openingSplitValue,
      openingSplitError: "",
    });
  },

  onSplitLimitValueInput(event: { detail: { value: string } }): void {
    if ((this.data as MedicineDetailPageData).openingSplitBusy) return;
    this.setData({ openingSplitValue: event.detail.value, openingSplitError: "" });
  },

  onSplitLimitSourceInput(event: { detail: { value: string } }): void {
    if ((this.data as MedicineDetailPageData).openingSplitBusy) return;
    this.setData({ openingSplitSource: event.detail.value });
  },

  onCancelOpenSplit(): void {
    if ((this.data as MedicineDetailPageData).openingSplitBusy) return;
    this.setData({ openingSplitBatchId: "", openingSplitError: "", openingSplitPreview: "" });
  },

  async onConfirmOpenSplit(): Promise<void> {
    const data = this.data as MedicineDetailPageData;
    if (data.openingSplitBusy || data.openingSplitBatchId === "") return;
    const batch = data.batchRecords.find((item) => item.id === data.openingSplitBatchId);
    const measured = batch !== undefined && unitAllowsDecimals(batch.unit);
    if (batch === undefined || batch.quantity === null || batch.quantity <= (measured ? 0 : 1) || batch.openedState !== "unopened") {
      this.setData({ openingSplitError: "批次信息已变化或未确认未开封，请刷新后重新核对。" });
      return;
    }
    const openedQuantity = parseQuantityByUnit(data.openingSplitQuantity, batch.unit);
    if (openedQuantity === null || openedQuantity <= 0 || openedQuantity >= batch.quantity) {
      this.setData({
        openingSplitError: measured
          ? "开封数量需为大于 0 且小于当前余量 " + batch.quantity + " 的毫升数（最多 3 位小数）。"
          : "开封数量需为 1 到 " + (batch.quantity - 1) + " 之间的整数，至少保留 1 个未开封单位。",
      });
      wx.showToast({ title: "请核对开封数量", icon: "none" });
      return;
    }
    if (!isValidExpiryValue(data.openingSplitDate, "day")) {
      this.setData({ openingSplitError: "请选择有效的开封日期。" });
      wx.showToast({ title: "请选择有效开封日期", icon: "none" });
      return;
    }

    let afterOpeningLimit: AfterOpeningLimitInput | undefined;
    const source = data.openingSplitSource.trim() === "" ? null : data.openingSplitSource.trim();
    if (data.openingSplitMode === "day" || data.openingSplitMode === "month") {
      if (!isStrictPositiveInteger(data.openingSplitValue)) {
        this.setData({ openingSplitError: "开封后期限需填写正整数；不清楚时可选择“不记录”。" });
        wx.showToast({ title: "请核对开封后期限", icon: "none" });
        return;
      }
      afterOpeningLimit = { value: Number(data.openingSplitValue), unit: data.openingSplitMode, source };
    } else if (data.openingSplitMode === "date") {
      if (!isValidExpiryValue(data.openingSplitValue, "day")) {
        this.setData({ openingSplitError: "开封后截止日期需为真实日期 YYYY-MM-DD。" });
        wx.showToast({ title: "请核对开封后截止日期", icon: "none" });
        return;
      }
      afterOpeningLimit = { date: data.openingSplitValue, source };
    }

    const payload: SplitBatchPayload = {
      version: batch.version,
      openedQuantity,
      openedAt: data.openingSplitDate,
      ...(afterOpeningLimit !== undefined ? { afterOpeningLimit } : {}),
      confirmed: true,
    };
    this.setData({ openingSplitBusy: true, openingSplitError: "" });
    try {
      await ensureLoggedIn();
      const result = await api.openSplitBatch(data.medicineId, batch.id, payload);
      const unit = UNIT_LABELS[result.openedBatch.unit] ?? "个单位";
      wx.showToast({
        title: "已开封 " + result.openedBatch.quantity + unit + "，余量 " + (result.remainingBatch?.quantity ?? 0) + unit,
        icon: "success",
      });
      this.setData({ openingSplitBatchId: "", openingSplitPreview: "" });
      await this.refresh();
    } catch (error) {
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        this.setData({ openingSplitBatchId: "", openingSplitPreview: "" });
        await new Promise<void>((resolve) => wx.showModal({
          title: "库存已被修改",
          content: "拆分未完成，库存没有改变。正在重新读取最新批次，请核对数量后再试。",
          showCancel: false,
          success: () => resolve(),
          fail: () => resolve(),
        }));
        await this.refresh();
      } else {
        const message = error instanceof ApiError ? error.message : "批次拆分失败，请稍后重试。";
        this.setData({ openingSplitError: message });
        showError(error);
      }
    } finally {
      this.setData({ openingSplitBusy: false });
    }
  },

  async onMarkOpened(event: { currentTarget: { dataset: { id?: string } } }): Promise<void> {
    const data = this.data as MedicineDetailPageData;
    const batchId = event.currentTarget.dataset.id;
    const batch = data.batchRecords.find((item) => item.id === batchId);
    if (batch === undefined || batch.openedState === "opened" || data.busyBatchId !== "" || data.openingSplitBusy || data.openingSplitBatchId !== "") return;
    if (batch.quantity === 0) {
      wx.showToast({ title: "此批次数量为 0，请先核对库存。", icon: "none" });
      return;
    }
    if (batch.quantity !== null && batch.quantity > 1 && batch.openedState === "unopened") {
      const splitDate = shanghaiToday();
      this.setData({
        openingSplitBatchId: batch.id,
        openingSplitQuantity: "1",
        openingSplitDate: splitDate,
        openingSplitMode: "none",
        openingSplitModeIndex: 0,
        openingSplitValue: "",
        openingSplitSource: "",
        openingSplitError: "",
        openingSplitPreview: "",
      });
      this.updateOpeningSplitPreview("1", batch.id);
      return;
    }
    const openedAt = shanghaiToday();
    const confirmed = await new Promise<boolean>((resolve) => wx.showModal({
      title: "标记为已开封",
      content: batch.quantity !== null && batch.quantity > 1
        ? "当前开封状态未确认是未开封，将整条库存记录标记为今天（" + openedAt + "）开封，不会自动拆分数量。"
        : "将批次记录为今天（" + openedAt + "）开封。开封后的期限需根据说明书或包装自行核对。",
      success: (result) => resolve(result.confirm),
      fail: () => resolve(false),
    }));
    if (!confirmed) return;
    this.setData({ busyBatchId: batch.id });
    try {
      await ensureLoggedIn();
      await api.updateBatch(data.medicineId, batch.id, {
        lotNumber: batch.lotNumber,
        expiry: batch.expiry,
        quantity: batch.quantity,
        unit: batch.unit,
        confirmedUnitsPerPackage: batch.confirmedUnitsPerPackage,
        storageLocation: batch.storageLocation,
        openedState: "opened",
        openedAt,
        afterOpeningLimit: batch.afterOpeningLimit ?? null,
        version: batch.version,
      });
      wx.showToast({ title: "已记录开封日期", icon: "success" });
      await this.refresh();
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ busyBatchId: "" });
    }
  },

  onTapEditMedicine(): void {
    const id = (this.data as MedicineDetailPageData).medicineId;
    wx.navigateTo({ url: `/pages/medicine-edit/medicine-edit?id=${id}` });
  },

  onTapAddBatch(): void {
    const id = (this.data as MedicineDetailPageData).medicineId;
    wx.navigateTo({ url: `/pages/batch-edit/batch-edit?medicineId=${id}` });
  },

  onAdjustQuantity(event: { currentTarget: { dataset: { id?: string } } }): void {
    const batch = this.data.medicineSummary?.batches.find((item) => item.id === event.currentTarget.dataset.id);
    if (batch) this.setData({ quantityPanelId: batch.id, quantityPanelInput: batch.quantity === null ? "" : String(batch.quantity) });
  },
  onQuantityPanelInput(event: { detail: { value: string } }): void { this.setData({ quantityPanelInput: event.detail.value }); },
  onCancelQuantityPanel(): void { if (!this.data.quantityPanelBusy) this.setData({ quantityPanelId: "", quantityPanelInput: "" }); },
  async onSaveQuantityPanel(): Promise<void> {
    if (this.data.quantityPanelBusy) return;
    const batch = this.data.medicineSummary?.batches.find((item) => item.id === this.data.quantityPanelId);
    if (!batch) return;
    const raw = this.data.quantityPanelInput.trim();
    const quantity = raw === "" ? null : parseQuantityByUnit(raw, batch.unit);
    if (raw !== "" && quantity === null) { wx.showToast({ title: batch.unit === "ml" ? "毫升允许最多3位小数" : "计件数量需为非负整数", icon: "none" }); return; }
    this.setData({ quantityPanelBusy: true });
    try { await ensureLoggedIn(); await api.updateBatch(this.data.medicineId, batch.id, { quantity, version: batch.version }); this.setData({ quantityPanelId: "", quantityPanelInput: "" }); await this.refresh(); }
    catch (error) { wx.showToast({ title: error instanceof ApiError ? error.message : "余量未保存，请重试", icon: "none" }); }
    finally { this.setData({ quantityPanelBusy: false }); }
  },
  onTapEditBatch(event: { currentTarget: { dataset: { id?: string } } }): void {
    const batchId = event.currentTarget.dataset.id;
    const medicineId = (this.data as MedicineDetailPageData).medicineId;
    if (!batchId) return;
    wx.navigateTo({ url: `/pages/batch-edit/batch-edit?medicineId=${medicineId}&batchId=${batchId}` });
  },

  onTapExport(): void {
    wx.navigateTo({ url: "/pages/export-preview/export-preview" });
  },

  /**
   * 只带入药品身份（ID 与名称）：剂量和时间必须由用户自己填写，
   * 不做任何自动推导。
   * “用药计划”是 tabBar 页，navigateTo 无法打开；创建流程走独立非 tab 页。
   */
  onTapCreatePlan(): void {
    const data = this.data as MedicineDetailPageData;
    const id = data.medicineId;
    if (id === "") return;
    const name = encodeURIComponent(data.medicineSummary?.name ?? data.name);
    wx.navigateTo({ url: `/pages/plan-create/plan-create?medicineId=${id}&medicineName=${name}` });
  },

  onToggleSection(event: { currentTarget: { dataset: { section?: string } } }): void {
    const section = event.currentTarget.dataset.section;
    if (section !== "leaflet" && section !== "notes" && section !== "stock") return;
    const sections = (this.data as MedicineDetailPageData).sections;
    this.setData({ [`sections.${section}`]: !sections[section] });
  },

  async onDeleteMedicine(): Promise<void> {
    const medicineId = (this.data as MedicineDetailPageData).medicineId;
    const confirmation = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: "删除药品",
        content: "删除后进入最近删除，30 天内可在“我的 → 最近删除”恢复。确定删除？",
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmation) return;
    try {
      await ensureLoggedIn();
      await api.deleteMedicine(medicineId);
      wx.showToast({ title: "已删除", icon: "success" });
      setTimeout(() => wx.navigateBack(), 700);
    } catch (error) {
      showError(error);
    }
  },

  onTapAudit(): void {
    wx.navigateTo({ url: "/pages/audit/audit" });
  },

  onNoteInput(event: { detail: { value: string } }): void {
    this.setData({ noteInput: event.detail.value });
  },

  onNoteVisibilityChange(event: { detail: { value: string | number } }): void {
    this.setData({ noteVisibilityIndex: Number(event.detail.value) });
  },

  async onSubmitNote(): Promise<void> {
    const data = this.data as MedicineDetailPageData;
    const content = data.noteInput.trim();
    if (content === "") {
      wx.showToast({ title: "备注内容不能为空", icon: "none" });
      return;
    }
    try {
      await ensureLoggedIn();
      await api.createDosageNote(data.medicineId, {
        content,
        visibility: data.noteVisibilityIndex === 1 ? "family" : "private",
      });
      this.setData({ noteInput: "" });
      wx.showToast({ title: "备注已添加", icon: "success" });
      await this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  async onDeleteNote(event: { currentTarget: { dataset: { id?: string } } }): Promise<void> {
    const noteId = event.currentTarget.dataset.id;
    const medicineId = (this.data as MedicineDetailPageData).medicineId;
    if (!noteId) return;
    const confirmation = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: "删除备注",
        content: "确定删除这条个人剂量备注？",
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmation) return;
    try {
      await ensureLoggedIn();
      await api.deleteDosageNote(medicineId, noteId);
      wx.showToast({ title: "已删除", icon: "success" });
      await this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  async onArchiveMedicine(): Promise<void> {
    const medicineId = (this.data as MedicineDetailPageData).medicineId;
    const confirmation = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: "归档药品",
        content: "归档后药品不进入默认列表与导出（可在导出时显式包含）。确定归档？",
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmation) return;
    try {
      await ensureLoggedIn();
      await api.archiveMedicine(medicineId);
      wx.showToast({ title: "已归档", icon: "success" });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (error) {
      showError(error);
    }
  },
});
