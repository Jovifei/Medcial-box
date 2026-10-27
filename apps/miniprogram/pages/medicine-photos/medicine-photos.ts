import { api, captureSessionIdentity, isCurrentSession } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import { readSessionScope, subscribeSessionChanges } from "../../services/session-scope";
import { clearRecognitionEvidenceRecoveryProofs, confirmRecognitionEvidenceRecovery, getPendingRecognitionEvidence, prepareRecognitionEvidenceRecovery,
  retryRecognitionEvidence, type EvidenceSyncResult, type PendingRecognitionEvidence } from "../../services/recognition-evidence-sync";
import { REVIEW_LABELS } from "../../services/recognition-review";
import type { LeafletPhotoSummary, MedicationBatchSummary, MedicationSummary, RecognitionEvidence, RecognitionEvidenceFieldSource, RecognitionEvidenceSave } from "../../services/api-types";

interface FieldView { label: string; value: string }
interface PhotoView { id: string; numberLabel: string; statusLabel: string; available: boolean; fields: FieldView[]; warnings: string[] }
interface SourceView { label: string; detail: string }
interface PendingView { title: string; version: number; photos: PhotoView[]; sources: SourceView[] }

const labels: Record<string, string> = REVIEW_LABELS;
const statusLabels = { pending: "待读取", recognized: "识别内容待核对", failed: "识别失败" };

function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.filter(item => typeof item === "string").join("、");
  return typeof value === "string" ? value : value === null ? "未识别到" : "";
}

function sourceViews(evidence: RecognitionEvidence, batches: MedicationBatchSummary[] | null): SourceView[] {
  const photos = new Map(evidence.photos.map(photo => [photo.photoId, photo]));
  const view = (field: string, source: RecognitionEvidenceFieldSource, prefix = "", historical = false): SourceView => {
    const kind = { manual: "人工填写", recognized: "照片识别", catalog: "资料库", removed: "来源已移除" }[source.source] ?? "来源未说明";
    const references = (source.photoIds ?? []).map(id => {
      const photo = photos.get(id);
      return photo ? `图${photo.sequence}${photo.available ? "" : "（原图不可查看）"}` : "原图不可查看";
    }).join("、");
    const missingOriginal = source.source === "removed" || source.photoIds.some(id => !photos.get(id)?.available);
    const review = source.reviewed ? (historical ? "历史记录曾核对" : missingOriginal ? "曾核对，原图不可查看" : "已核对") : "待核对";
    return { label: `${prefix}${field === "expiry" ? "有效期" : labels[field] ?? field}`, detail: `${kind}${references ? ` · ${references}` : ""} · ${review}` };
  };
  const result = Object.entries(evidence.fieldSources ?? {}).map(([field, source]) => view(field, source));
  if (Array.isArray(evidence.batchSources)) {
    for (const source of evidence.batchSources) {
      if (typeof source.field === "string" && typeof source.source === "string" && Array.isArray(source.photoIds) && typeof source.reviewed === "boolean") {
        const historical = source.batchId === null || source.batchAvailable !== true;
        const index = batches?.findIndex(batch => batch.id === source.batchId) ?? -1;
        const batch = index >= 0 ? batches?.[index] : undefined;
        const description = batch?.lotNumber ? `批号 ${batch.lotNumber}` : batch?.expiry.value ? `有效期 ${batch.expiry.value}` : "无批号和有效期";
        const prefix = historical ? "库存（原库存已移除或未绑定） · " :
          batch ? `第${index + 1}份库存（${description}） · ` : "库存（明细暂不可用） · ";
        result.push(view(source.field, source, prefix, historical));
      }
    }
  }
  return result;
}

function photoViews(evidence: RecognitionEvidence | null, originals: LeafletPhotoSummary[], listLoaded: boolean): PhotoView[] {
  const originalIds = new Set(originals.map(photo => photo.id));
  const photos = (evidence?.photos ?? []).map(photo => ({
    id: photo.photoId,
    numberLabel: `图${photo.sequence}`,
    statusLabel: statusLabels[photo.status] ?? "状态未知",
    available: photo.available === true && (!listLoaded || originalIds.has(photo.photoId)),
    fields: Object.entries(photo.fields ?? {}).map(([field, value]) => ({ label: labels[field] ?? field, value: displayValue(value) })),
    warnings: Array.isArray(photo.warnings) ? photo.warnings.filter(item => typeof item === "string") : [],
  })).sort((a, b) => Number(a.numberLabel.slice(1)) - Number(b.numberLabel.slice(1)));
  const matched = new Set(photos.map(photo => photo.id));
  for (const photo of originals) {
    if (!matched.has(photo.id)) photos.push({ id: photo.id, numberLabel: "历史照片（未记录图号）", statusLabel: "没有逐图识别记录", available: true, fields: [], warnings: [] });
  }
  return photos;
}

function syncMessage(result: EvidenceSyncResult): string {
  if (result.status === "synced" && result.reason === "stale") return "来源已保存，但部分历史资料已过期或不可查看，仍需核对。";
  if (result.status === "synced") return "来源资料已同步。";
  if (result.status === "identity_changed") return "家庭或登录状态已变化，原家庭的待同步资料仍保留。";
  if (result.reason === "conflict") return "药品或来源已变化，暂不能同步；请先重新核对。";
  if (result.reason === "unsupported" || result.reason === "capability_unconfirmed") return "当前服务暂不支持确认来源同步，待同步资料仍保留。";
  if (result.acknowledged) return "此前请求已提交，但药品或来源后来发生变化；本机原始内容仍保留供核对。";
  if (result.reason === "stale" || result.reason === "receipt_mismatch") return "同步结果无法确认与当前资料一致，待同步记录仍保留。";
  if (result.reason === "storage_error") return "本机待同步记录暂时不可读取，请稍后重试。";
  if (result.reason === "rejected") return "服务暂未接受来源资料，请重新核对后重试。";
  if (result.reason === "source_changed") return "来源已被其他操作修改，无法自动合并；本机记录仍保留。";
  if (result.reason === "photo_unavailable") return "部分原图不可查看，无法自动重建；本机记录仍保留。";
  if (result.reason === "batch_unavailable") return "库存或照片关联已变化，无法自动重建；本机记录仍保留。";
  if (result.reason === "version_changed") return "药品资料在核对期间发生变化，请重新读取后核对。";
  if (result.reason === "current_unavailable") return "部分当前资料无法读取，无法安全核对；本机记录仍保留。";
  return "来源资料暂未同步，药品和照片的保存结果不受影响。";
}

function pendingViews(record: PendingRecognitionEvidence, originals: LeafletPhotoSummary[], batches: MedicationBatchSummary[] | null): PendingView[] {
  const available = new Set(originals.map(photo => photo.id));
  return [...(record.previousPayloads ?? []), record.payload].map((payload, index, all) => {
    const evidence: RecognitionEvidence = { schemaVersion: 1, revision: payload.revision, medicineVersion: payload.medicineVersion,
      currentMedicineVersion: payload.medicineVersion, stale: true,
      photos: payload.photos.map(photo => ({ ...photo, available: available.has(photo.photoId) })), fieldSources: payload.fieldSources,
      ...(payload.batchSources === undefined ? {} : { batchSources: payload.batchSources.map(source => ({ ...source,
        batchAvailable: source.batchId !== null && (batches?.some(batch => batch.id === source.batchId) ?? false) })) }) };
    return { title: index === all.length - 1 ? "当前待同步内容" : `之前的请求 ${index + 1}（本机备份）`, version: payload.medicineVersion,
      photos: photoViews(evidence, [], false), sources: sourceViews(evidence, batches) };
  });
}

function recoveryValues(payload: RecognitionEvidenceSave, medicine: MedicationSummary): FieldView[] {
  const actual: Record<string, unknown> = { name: medicine.name, brand: medicine.brand, specification: medicine.specification,
    manufacturer: medicine.manufacturer, approvalNumber: medicine.approvalNumber, barcodeValue: medicine.barcodeValue,
    activeIngredients: medicine.activeIngredients, purposeCategory: medicine.purposeCategory, populationTags: medicine.populationTags,
    purposeTags: medicine.purposeTags, purposeSummary: medicine.leaflet?.purposeSummary, packageUsageSummary: medicine.leaflet?.packageUsageSummary,
    contraindicationsSummary: medicine.leaflet?.contraindicationsSummary, precautionsSummary: medicine.leaflet?.precautionsSummary };
  const view = Object.keys(payload.fieldSources).map(field => ({ label: labels[field] ?? field,
    value: actual[field] === undefined ? "当前值不可读取" : actual[field] === null ? "未记录" : displayValue(actual[field]) || "未记录" }));
  for (const source of payload.batchSources ?? []) {
    const index = medicine.batches.findIndex(batch => batch.id === source.batchId);
    const batch = medicine.batches[index];
    const value = source.field === "expiry" ? batch?.expiry.value : batch?.lotNumber;
    const precision = source.field === "expiry" && batch?.expiry ?
      ({ day: "按日", month: "按月", unknown: "精度未知" }[batch.expiry.precision] ?? "精度未知") : "";
    view.push({ label: `第${index + 1}份库存 · ${source.field === "expiry" ? "有效期" : "批号"}`,
      value: `${value === undefined ? "当前值不可读取" : value ?? "未记录"}${precision ? `（${precision}）` : ""}` });
  }
  return view;
}

Page({
  data: {
    medicineId: "", loading: false, photos: [] as PhotoView[], sources: [] as SourceView[], evidenceNotice: "",
    photoNotice: "", pendingSync: false, syncNotice: "", syncBusy: false, photoBusyId: "",
    pendingIntents: [] as PendingView[], pendingAcknowledged: false, recoveryReady: false, recoveryVersion: "", recoveryValues: [] as FieldView[],
  },
  operation: 0,
  identity: null as ReturnType<typeof captureSessionIdentity> | null,
  scope: null as ReturnType<typeof readSessionScope>,
  visible: false,
  unsubscribeSession: null as (() => void) | null,
  onLoad(options: { id?: string }): void {
    this.setData({ medicineId: options.id ?? "" });
    this.unsubscribeSession?.();
    this.unsubscribeSession = subscribeSessionChanges(() => {
      if (!this.visible || !this.identity || this.current(this.operation)) return;
      ++this.operation;
    });
  },
  onHide(): void { this.visible = false; ++this.operation; this.clearPrivateView(); },
  onUnload(): void { this.unsubscribeSession?.(); this.unsubscribeSession = null; this.visible = false; ++this.operation; this.clearPrivateView(); },
  clearPrivateView(): void {
    clearRecognitionEvidenceRecoveryProofs();
    this.identity = null; this.scope = null;
    this.setData({ loading: false, photos: [], sources: [], evidenceNotice: "", photoNotice: "", pendingSync: false, syncNotice: "", syncBusy: false, photoBusyId: "",
      pendingIntents: [], pendingAcknowledged: false, recoveryReady: false, recoveryVersion: "", recoveryValues: [] });
  },
  current(seq: number): boolean {
    const scope = readSessionScope();
    const valid = this.visible && seq === this.operation && this.identity !== null && isCurrentSession(this.identity) &&
      this.scope !== null && scope !== null && scope.userId === this.scope.userId && scope.familyId === this.scope.familyId;
    // An identity can change while this page remains visible, for example after a 401.
    // Never leave the old household's fields on screen once that change is observed.
    if (!valid && this.visible && seq === this.operation && this.identity !== null) {
      this.clearPrivateView();
      this.setData({ evidenceNotice: "家庭或登录状态已变化，请返回药箱重新打开。" });
    }
    return valid;
  },
  async onShow(): Promise<void> {
    this.visible = true;
    const seq = ++this.operation;
    this.clearPrivateView();
    const medicineId = this.data.medicineId;
    if (!medicineId) { this.setData({ evidenceNotice: "缺少药品信息，请返回药箱重新打开。" }); return; }
    const identity = captureSessionIdentity();
    this.setData({ loading: true });
    try {
      await ensureLoggedIn({ allowInteractive: false, rejectScopeChange: true });
      if (!this.visible || seq !== this.operation) return;
      if (!isCurrentSession(identity)) {
        this.clearPrivateView(); this.setData({ evidenceNotice: "家庭或登录状态已变化，请返回药箱重新打开。" }); return;
      }
      this.identity = identity; this.scope = readSessionScope();
      if (!this.scope?.familyId || !this.scope.userId) {
        this.clearPrivateView(); this.setData({ evidenceNotice: "请先选择家庭，再从药箱打开照片与资料。" }); return;
      }
      if (!this.current(seq)) return;
      let pending: PendingRecognitionEvidence | null = null;
      try { pending = getPendingRecognitionEvidence(medicineId); this.setData({ pendingSync: pending !== null, pendingAcknowledged: !!pending?.acknowledgement }); }
      catch { this.setData({ syncNotice: "本机待同步记录暂时不可读取。" }); }
      const [evidenceResult, photoResult, medicineResult] = await Promise.allSettled([
        api.getRecognitionEvidence(medicineId), api.listLeafletPhotos(medicineId), api.getMedicine(medicineId),
      ]);
      if (!this.current(seq)) return;
      let evidence: RecognitionEvidence | null = null;
      let evidenceNotice = "";
      if (evidenceResult.status === "fulfilled") {
        evidence = evidenceResult.value.evidence;
        if (evidence && evidence.schemaVersion !== 1) {
          evidence = null;
          evidenceNotice = "当前版本无法读取这些逐图来源；已有照片仍可查看原图。";
        } else if (evidence?.stale) evidenceNotice = "药品或原图已有变化，以下来源可能与当前资料不同步，请重新核对。";
        else if (!evidence) evidenceNotice = "没有保存逐图识别记录；已有照片仍可查看原图。";
      } else {
        const status = (evidenceResult.reason as { statusCode?: number } | null)?.statusCode;
        evidenceNotice = status === 404 ? "当前服务不支持或无法读取逐图来源，已有照片仍可查看原图。" : "逐图来源暂时无法读取，请检查网络和家庭权限后重试。";
      }
      if (evidence && medicineResult.status === "fulfilled" && evidence.currentMedicineVersion !== medicineResult.value.version) {
        evidenceNotice = "药品资料在读取期间发生变化，以下来源可能不同步，请重新核对。";
      } else if (evidence?.batchSources?.length && medicineResult.status === "rejected") {
        evidenceNotice = `${evidenceNotice}${evidenceNotice ? " " : ""}库存明细暂时不可用。`;
      }
      const originals = photoResult.status === "fulfilled" ? photoResult.value.photos : [];
      this.setData({ photos: photoViews(evidence, originals, photoResult.status === "fulfilled"),
        sources: evidence ? sourceViews(evidence, medicineResult.status === "fulfilled" ? medicineResult.value.batches : null) : [], evidenceNotice,
        pendingIntents: pending ? pendingViews(pending, originals, medicineResult.status === "fulfilled" ? medicineResult.value.batches : null) : [],
        photoNotice: photoResult.status === "rejected" ? "照片列表暂时无法读取，请检查网络和家庭权限后重试。" : "",
        loading: false });
    } catch {
      if (this.visible && seq === this.operation) {
        const sameIdentity = isCurrentSession(identity);
        this.clearPrivateView();
        this.setData({ evidenceNotice: sameIdentity ? "无法读取当前家庭资料，请确认登录状态和网络后重试。" : "家庭或登录状态已变化，请返回药箱重新打开。" });
      }
    }
  },
  async onPreviewPhoto(event: { currentTarget: { dataset: { id?: string } } }): Promise<void> {
    const id = event.currentTarget.dataset.id;
    const photo = [...this.data.photos, ...this.data.pendingIntents.flatMap(intent => intent.photos)].find(item => item.id === id && item.available);
    const seq = this.operation;
    if (!id || !photo?.available || this.data.photoBusyId || !this.current(seq)) return;
    this.setData({ photoBusyId: id, photoNotice: "" });
    try {
      const path = await api.downloadLeafletPhoto(this.data.medicineId, id);
      if (this.current(seq)) wx.previewImage({ current: path, urls: [path] });
    } catch {
      if (this.current(seq)) this.setData({ photoNotice: "原图暂时无法查看，请检查网络或确认照片是否已移除。" });
    } finally { if (this.current(seq)) this.setData({ photoBusyId: "" }); }
  },
  async onRetrySync(): Promise<void> {
    const seq = this.operation;
    if (!this.data.pendingSync || this.data.syncBusy || !this.current(seq)) return;
    this.setData({ syncBusy: true, recoveryReady: false, recoveryValues: [] });
    const result = await retryRecognitionEvidence(this.data.medicineId);
    if (!this.current(seq)) return;
    let pendingSync = result.status !== "synced", pendingAcknowledged = !!result.acknowledged;
    try { const record = getPendingRecognitionEvidence(this.data.medicineId); pendingSync = record !== null; pendingAcknowledged = !!record?.acknowledgement; }
    catch { /* Keep the retry visible when local storage cannot be inspected. */ }
    this.setData({ syncBusy: false, syncNotice: syncMessage(result), pendingSync, pendingAcknowledged });
    if (result.status === "synced") {
      wx.showToast({ title: result.reason === "stale" ? "已保存，历史待核对" : "来源资料已同步", icon: "success" });
      await this.onShow();
    }
  },
  async onReviewRecovery(): Promise<void> {
    const seq = this.operation;
    if (!this.data.pendingSync || this.data.syncBusy || !this.current(seq)) return;
    this.setData({ syncBusy: true, recoveryReady: false, recoveryValues: [] });
    const result = await prepareRecognitionEvidenceRecovery(this.data.medicineId);
    if (!this.current(seq)) return;
    if (result.status === "synced") {
      wx.showToast({ title: result.reason === "stale" ? "已保存，历史待核对" : "来源资料已同步", icon: "success" });
      await this.onShow(); return;
    }
    if (result.status === "acknowledged") {
      this.setData({ syncBusy: false, pendingAcknowledged: true,
        syncNotice: "此前请求已提交，但当前来源已发生变化。本机旧内容仍保留，请逐项核对。" }); return;
    }
    if (result.status !== "ready") {
      this.setData({ syncBusy: false, syncNotice: syncMessage({ status: result.status === "identity_changed" ? "identity_changed" : "pending",
        reason: result.status === "blocked" ? result.reason : "identity_changed" }) }); return;
    }
    let pending: PendingRecognitionEvidence | null;
    try { pending = getPendingRecognitionEvidence(this.data.medicineId); }
    catch { this.setData({ syncBusy: false, syncNotice: "本机待同步记录暂时不可读取。" }); return; }
    if (!pending) { this.setData({ syncBusy: false, syncNotice: "待同步记录已变化，请重新读取。" }); return; }
    this.setData({ syncBusy: false, recoveryReady: true,
      recoveryVersion: `原药品版本 ${result.oldMedicineVersion} → 当前版本 ${result.currentMedicineVersion}`,
      recoveryValues: recoveryValues(pending.payload, result.medicine),
      syncNotice: "请对照下面的当前资料和本机待同步内容；确认后会保留旧请求并尝试重新同步。" });
  },
  async onConfirmRecovery(): Promise<void> {
    const seq = this.operation;
    if (!this.data.recoveryReady || this.data.syncBusy || !this.current(seq)) return;
    const confirmed = await new Promise<boolean>(resolve => wx.showModal({ title: "确认重新同步来源",
      content: "请确认已核对当前药品和库存与本机照片资料。旧请求会保留备份，再以当前药品版本提交相同来源内容。",
      success: result => resolve(result.confirm), fail: () => resolve(false) }));
    if (!confirmed || !this.current(seq)) return;
    this.setData({ syncBusy: true, recoveryReady: false });
    const result = await confirmRecognitionEvidenceRecovery(this.data.medicineId);
    if (!this.current(seq)) return;
    if (result.status === "synced") {
      wx.showToast({ title: result.reason === "stale" ? "已保存，历史待核对" : "来源资料已同步", icon: "success" });
      await this.onShow(); return;
    }
    const notice = syncMessage(result);
    await this.onShow();
    if (this.current(this.operation)) this.setData({ syncNotice: notice });
  },
  onBack(): void {
    try {
      if (getCurrentPages().length > 1) { wx.navigateBack(); return; }
    } catch { /* no page stack */ }
    wx.switchTab({ url: "/pages/index/index" });
  },
});
