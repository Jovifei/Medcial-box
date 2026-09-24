import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import type {
  DosageNoteSummary,
  MedicationBatchSummary,
  MedicationSummary,
  QuantityUnit,
} from "../../services/api-types";

const UNIT_LABELS: Record<QuantityUnit, string> = {
  tablet: "片",
  capsule: "粒",
  sachet: "袋",
  bottle: "瓶",
  box: "盒",
  other: "个单位",
};

interface BatchView {
  id: string;
  title: string;
  quantityText: string;
  expiryText: string;
  storageText: string;
  confirmedText: string;
  state: string;
}

interface NoteView {
  id: string;
  ownerLabel: string;
  content: string;
  isMine: boolean;
}

interface MedicineDetailPageData {
  medicineId: string;
  loading: boolean;
  name: string;
  specText: string;
  metaText: string;
  leafletText: string;
  leafletBadge: string;
  batches: BatchView[];
  notes: NoteView[];
  noteInput: string;
  noteVisibilityLabels: string[];
  noteVisibilityIndex: number;
}

function quantityText(batch: MedicationBatchSummary): string {
  if (batch.quantity === null) return "数量未知";
  if (batch.quantity === 0) return "已耗尽";
  return `${batch.quantity} ${UNIT_LABELS[batch.unit] ?? "个单位"}`;
}

function toBatchView(batch: MedicationBatchSummary): BatchView {
  return {
    id: batch.id,
    title: batch.lotNumber === null ? "批次号未记录" : `批次号 ${batch.lotNumber}`,
    quantityText: quantityText(batch),
    expiryText: batch.expiryState.label,
    storageText: batch.storageLocation === null ? "存放位置未记录" : `存放位置：${batch.storageLocation}`,
    confirmedText:
      batch.confirmedUnitsPerPackage === null
        ? ""
        : `每包装含 ${batch.confirmedUnitsPerPackage} 个最小单位（本人已确认）`,
    state: batch.expiryState.state,
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

function showError(error: unknown): void {
  const message = error instanceof ApiError ? error.message : "操作失败，请稍后重试";
  wx.showToast({ title: message, icon: "none", duration: 2800 });
}

Page({
  data: {
    medicineId: "",
    loading: true,
    name: "",
    specText: "",
    metaText: "",
    leafletText: "",
    leafletBadge: "",
    batches: [] as BatchView[],
    notes: [] as NoteView[],
    noteInput: "",
    noteVisibilityLabels: ["仅本人可见", "全家可见"],
    noteVisibilityIndex: 0,
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
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ loading: false });
    }
  },

  applyData(medicine: MedicationSummary, notes: DosageNoteSummary[]): void {
    const metaParts: string[] = [];
    if (medicine.manufacturer !== null) metaParts.push(`厂家：${medicine.manufacturer}`);
    if (medicine.approvalNumber !== null) metaParts.push(`批准文号：${medicine.approvalNumber}`);
    if (medicine.activeIngredients.length > 0) {
      metaParts.push(`成分：${medicine.activeIngredients.join("、")}`);
    }
    if (medicine.purposeCategory !== null) metaParts.push(`用途分类：${medicine.purposeCategory}`);
    const leaflet = leafletDescription(medicine);
    this.setData({
      name: medicine.name,
      specText: medicine.specification ?? "规格未记录",
      metaText: metaParts.length === 0 ? "暂无补充资料" : metaParts.join("；"),
      leafletText: leaflet.text,
      leafletBadge: leaflet.badge,
      batches: medicine.batches.map(toBatchView),
      notes: notes.map(toNoteView),
    });
  },

  onTapEditMedicine(): void {
    const id = (this.data as MedicineDetailPageData).medicineId;
    wx.navigateTo({ url: `/pages/medicine-edit/medicine-edit?id=${id}` });
  },

  onTapAddBatch(): void {
    const id = (this.data as MedicineDetailPageData).medicineId;
    wx.navigateTo({ url: `/pages/batch-edit/batch-edit?medicineId=${id}` });
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
