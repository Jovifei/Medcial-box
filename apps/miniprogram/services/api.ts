// 统一网络层：Bearer 令牌注入、统一错误 shape 解析（{ error: { code, message } }）、
// 401 自动清除本地令牌。所有页面经由本模块访问后端，不直接调用 wx.request。
import { API_BASE } from "./config";
import { clearSessionScope } from "./session-scope";
import type {
  NotificationPreferences,
  AcceptInvitationResponse,
  AppDeviceLinkApproveResponse,
  AuthDevicesResponse,
  AuditEventSummary,
  AuthMeResponse,
  AuthSessionResponse,
  BatchPayload,
  CreateFamilyResponse,
  CreateInvitationResponse,
  DosageNoteListResponse,
  GetCurrentFamilyResponse,
  MarkdownExportResponse,
  MedicationSummary,
  MedicineListResponse,
  MedicinePayload,
  MedicineRecognitionResponse,
  InvitationPreviewResponse,
  FamilyInventorySettings,
  CareProfileSummary,
  FamilyMedicineBackup,
  MedicationPlanPayload,
  MedicationPlanUpdatePayload,
  MedicationPlanUpdateResponse,
  MedicationPlanSummary,
  MedicationPlanDetailResponse,
  PlanHistoryResponse,
  DoseReminderStatusResponse,
  CareGrantListResponse,
  ScheduleResponse,
  MedicineCandidatesResponse,
  TransferOwnershipResponse,
  NotificationPendingResponse,
  NotificationTemplatesResponse,
  RestockItemSummary,
  StocktakeItemInput,
  StocktakeItemResult,
  StocktakeSession,
  TrashItemSummary,
  UpdateProfileResponse,
  CreateJsonBackupResponse,
  PreviewJsonBackupResponse,
  RestoreJsonBackupResponse,
  QuantityUnit,
  LeafletPhotoSummary,
  SplitBatchPayload,
  SplitBatchResponse,
} from "./api-types";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    /** Identity left behind by this request's own 401 cleanup, if any. */
    readonly invalidatedSession?: SessionIdentity,
  ) {
    super(message);
  }
}

const TOKEN_STORAGE_KEY = "home_medicine_session_token";

/**
 * 内存令牌镜像：本地存储读写可能因为配额已满或权限异常而抛错，
 * 令牌必须仍然在本次会话内生效，否则请求会静默丢失 Authorization 头。
 */
let memoryToken = "";
let tokenLoaded = false;
let sessionGeneration = 0;

export interface SessionIdentity {
  readonly token: string;
  readonly generation: number;
}

export function captureSessionIdentity(): SessionIdentity {
  return { token: readToken(), generation: sessionGeneration };
}

export function isCurrentSession(identity: SessionIdentity): boolean {
  return identity.generation === sessionGeneration && identity.token === readToken();
}

/** A new login/logout intent invalidates older callbacks before any async work. */
export function beginSessionTransition(): SessionIdentity {
  sessionGeneration += 1;
  return captureSessionIdentity();
}

export function staleSessionError(): ApiError {
  // This is not an expired current session: old pages must not trigger 401 redirects.
  return new ApiError("STALE_SESSION", "登录状态已变更，请重新打开当前页面", 0);
}

export function readToken(): string {
  if (tokenLoaded) return memoryToken;
  tokenLoaded = true;
  try {
    const stored = (wx.getStorageSync(TOKEN_STORAGE_KEY) as string) || "";
    memoryToken = stored;
    return stored;
  } catch {
    return "";
  }
}

export function storeToken(token: string): void {
  sessionGeneration += 1;
  memoryToken = token;
  tokenLoaded = true;
  clearSessionScope();
  try {
    if (token === "") {
      wx.removeStorageSync(TOKEN_STORAGE_KEY);
    } else {
      wx.setStorageSync(TOKEN_STORAGE_KEY, token);
    }
  } catch {
    // 存储不可用时保留内存副本，本次启动内请求仍然带令牌。
  }
}

export function clearToken(): void {
  storeToken("");
}

/** 仅供测试使用：重置内存与持久令牌，模拟冷启动。 */
export function __resetTokenMemoryForTest(): void {
  memoryToken = "";
  tokenLoaded = false;
  sessionGeneration += 1;
}

interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
  /** 匿名请求（登录本身）不附带 Authorization。 */
  anonymous?: boolean;
  /** Successful create/join/leave changes identity even when the bearer token stays the same. */
  changesFamily?: boolean;
}

function parseErrorBody(raw: unknown, statusCode: number, invalidatedSession?: SessionIdentity): ApiError {
  if (typeof raw === "object" && raw !== null) {
    const body = raw as { error?: { code?: unknown; message?: unknown } };
    if (
      typeof body.error === "object" &&
      body.error !== null &&
      typeof body.error.code === "string"
    ) {
      const message =
        typeof body.error.message === "string" ? body.error.message : `请求失败（${statusCode}）`;
      return new ApiError(body.error.code, message, statusCode, invalidatedSession);
    }
  }
  return new ApiError("REQUEST_FAILED", `请求失败（${statusCode}）`, statusCode, invalidatedSession);
}

export function networkFailureError(error?: { errMsg?: string }): ApiError {
  const detail = error?.errMsg ?? "";
  let reason = "连接失败";
  if (/url not in.*domain|domain list|合法域名/i.test(detail)) reason = "微信域名校验拒绝";
  else if (/ssl|tls|cert|handshake/i.test(detail)) reason = "HTTPS证书或TLS校验失败";
  else if (/timeout|timed out/i.test(detail)) reason = "连接超时";
  else {
    const code = detail.match(/ERR_[A-Z_]+/);
    if (code !== null) reason = code[0];
  }
  console.warn(`[medbox] network failure: ${reason}; base=${API_BASE}; detail=${detail}`);\n  return new ApiError("NETWORK_ERROR", "无法连接药箱服务，请检查网络后重试。", 0);
}

export function request<T>(options: RequestOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const identity = captureSessionIdentity();
    const authenticated = options.anonymous !== true;
    const header: Record<string, string> = { "content-type": "application/json" };
    if (authenticated && identity.token !== "") header.authorization = `Bearer ${identity.token}`;
    wx.request({
      url: `${API_BASE}${options.path}`,
      method: options.method as unknown as WechatMiniprogram.RequestOption["method"],
      data: options.payload,
      header,
      timeout: options.timeoutMs ?? 10000,
      success: (response) => {
        if (authenticated && !isCurrentSession(identity)) { reject(staleSessionError()); return; }
        const status = response.statusCode;
        if (status >= 200 && status < 300) {
          if (options.changesFamily) {
            beginSessionTransition();
            clearSessionScope();
          }
          resolve(response.data as T);
          return;
        }
        let invalidatedSession: SessionIdentity | undefined;
        if (status === 401 && authenticated) {
          clearToken();
          invalidatedSession = captureSessionIdentity();
        }
        reject(parseErrorBody(response.data as unknown, status, invalidatedSession));
      },
      fail: (error) => {
        if (authenticated && !isCurrentSession(identity)) { reject(staleSessionError()); return; }
        reject(networkFailureError(error));
      },
    });
  });
}

function toPayload(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

export const api = {
  recognizeMedicine(imageBase64: string, mimeType: "image/jpeg" | "image/png"): Promise<MedicineRecognitionResponse> {
    return request<MedicineRecognitionResponse>({
      method: "POST",
      path: "/api/v1/recognitions/medicine",
      payload: { imageBase64, mimeType },
      timeoutMs: 60000,
    });
  },
  listLeafletPhotos(medicineId: string): Promise<{ photos: LeafletPhotoSummary[] }> {
    return request({ method: "GET", path: `/api/v1/medicines/${encodeURIComponent(medicineId)}/leaflet-photos` });
  },

  uploadLeafletPhoto(
    medicineId: string,
    imageBase64: string,
    mimeType: "image/jpeg" | "image/png",
    source = "package_leaflet",
    association?: { purpose: "box_front" | "expiry" | "leaflet"; batchId?: string | null },
  ): Promise<{ photo: LeafletPhotoSummary }> {
    return request({
      method: "POST",
      path: `/api/v1/medicines/${encodeURIComponent(medicineId)}/leaflet-photos`,
      payload: { imageBase64, mimeType, source, ...association },
      timeoutMs: 60000,
    });
  },

  setMedicineCover(medicineId: string, photoId: string | null): Promise<{ coverPhotoId: string | null }> {
    return request({ method: "POST", path: `/api/v1/medicines/${encodeURIComponent(medicineId)}/cover-photo`, payload: { photoId } });
  },
  downloadLeafletPhoto(medicineId: string, photoId: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const identity = captureSessionIdentity();
      const token = identity.token;
      wx.downloadFile({
        url: `${API_BASE}/api/v1/medicines/${encodeURIComponent(medicineId)}/leaflet-photos/${encodeURIComponent(photoId)}`,
        header: token === "" ? {} : { authorization: `Bearer ${token}` },
        success: (response) => {
          if (!isCurrentSession(identity)) { reject(staleSessionError()); return; }
          if (response.statusCode >= 200 && response.statusCode < 300 && response.tempFilePath) {
            resolve(response.tempFilePath);
            return;
          }
          if (response.statusCode === 401) clearToken();
          reject(new ApiError(response.statusCode === 401 ? "UNAUTHORIZED" : "PHOTO_DOWNLOAD_FAILED",
            response.statusCode === 401 ? "登录已过期，请重新登录后查看图片" : `说明书图片读取失败（${response.statusCode}）`, response.statusCode));
        },
        fail: () => reject(isCurrentSession(identity) ? new ApiError("NETWORK_ERROR", "说明书图片下载失败，请检查网络后重试", 0) : staleSessionError()),
      });
    });
  },

  deleteLeafletPhoto(medicineId: string, photoId: string): Promise<null> {
    return request<null>({ method: "DELETE", path: `/api/v1/medicines/${encodeURIComponent(medicineId)}/leaflet-photos/${encodeURIComponent(photoId)}` });
  },
  login(code: string): Promise<AuthSessionResponse> {
    return request<AuthSessionResponse>({
      method: "POST",
      path: "/api/v1/auth/wechat",
      payload: { code },
      anonymous: true,
    });
  },

  getAuthMe(): Promise<AuthMeResponse> {
    return request<AuthMeResponse>({ method: "GET", path: "/api/v1/auth/me" });
  },

  getDevices(): Promise<AuthDevicesResponse> {
    return request<AuthDevicesResponse>({ method: "GET", path: "/api/v1/auth/devices" });
  },

  revokeAndroidDevice(sessionId: string): Promise<{ revoked: true }> {
    return request<{ revoked: true }>({
      method: "POST",
      path: `/api/v1/auth/devices/${encodeURIComponent(sessionId)}/revoke`,
      payload: {},
    });
  },

  logout(): Promise<{ revoked: boolean }> {
    return request<{ revoked: boolean }>({ method: "POST", path: "/api/v1/auth/logout", payload: {} });
  },

  updateProfile(nickname: string | null): Promise<UpdateProfileResponse> {
    return request<UpdateProfileResponse>({
      // 微信端使用 POST 兼容入口，避免不同基础库对方法支持不一致。
      method: "POST",
      path: "/api/v1/users/me/nickname",
      payload: { nickname },
    });
  },

  getCurrentFamily(): Promise<GetCurrentFamilyResponse> {
    return request<GetCurrentFamilyResponse>({ method: "GET", path: "/api/v1/families/current" });
  },

  createFamily(name: string): Promise<CreateFamilyResponse> {
    return request<CreateFamilyResponse>({
      method: "POST",
      path: "/api/v1/families",
      payload: { name },
      changesFamily: true,
    });
  },

  createInvitation(): Promise<CreateInvitationResponse> {
    return request<CreateInvitationResponse>({
      method: "POST",
      path: "/api/v1/families/invitations",
    });
  },

  acceptInvitation(code: string): Promise<AcceptInvitationResponse> {
    return request<AcceptInvitationResponse>({
      method: "POST",
      path: "/api/v1/families/invitations/accept",
      payload: { code },
      changesFamily: true,
    });
  },

  previewInvitation(code: string): Promise<InvitationPreviewResponse> {
    return request<InvitationPreviewResponse>({
      method: "POST",
      path: "/api/v1/families/invitations/preview",
      payload: { invitationCode: code },
    });
  },

  removeMember(memberId: string): Promise<null> {
    return request<null>({
      method: "DELETE",
      path: `/api/v1/families/members/${memberId}`,
    });
  },

  /** 成员自助退出家庭（owner 需先转让所有权，后端返回 409 OWNER_CANNOT_LEAVE）。 */
  leaveFamily(): Promise<null> {
    return request<null>({ method: "POST", path: "/api/v1/families/leave", changesFamily: true });
  },

  /** owner 把家庭所有权转让给一名普通成员。 */
  transferOwnership(memberId: string): Promise<TransferOwnershipResponse> {
    return request<TransferOwnershipResponse>({
      method: "POST",
      path: `/api/v1/families/members/${memberId}/transfer-ownership`,
    });
  },

  listMedicines(includeArchived = false): Promise<MedicineListResponse> {
    const suffix = includeArchived ? "?includeArchived=true" : "";
    return request<MedicineListResponse>({
      method: "GET",
      path: `/api/v1/medicines${suffix}`,
    });
  },

  getMedicine(medicineId: string): Promise<MedicationSummary> {
    return request<MedicationSummary>({
      method: "GET",
      path: `/api/v1/medicines/${medicineId}`,
    });
  },

  createMedicine(payload: MedicinePayload): Promise<MedicationSummary> {
    return request<MedicationSummary>({
      method: "POST",
      path: "/api/v1/medicines",
      payload: toPayload(payload),
    });
  },

  updateMedicine(medicineId: string, payload: MedicinePayload): Promise<MedicationSummary> {
    return request<MedicationSummary>({
      method: "PUT",
      path: `/api/v1/medicines/${medicineId}`,
      payload: toPayload(payload),
    });
  },

  /** 删除药品：进入回收站，30 天内可恢复；与“归档”是两条不同生命周期。 */
  deleteMedicine(medicineId: string): Promise<null> {
    return request({
      method: "POST",
      path: `/api/v1/medicines/${encodeURIComponent(medicineId)}/trash`,
      payload: {},
    });
  },

  archiveMedicine(medicineId: string): Promise<null> {
    return request<null>({
      method: "DELETE",
      path: `/api/v1/medicines/${encodeURIComponent(medicineId)}`,
    });
  },

  createBatch(medicineId: string, payload: BatchPayload): Promise<MedicationSummary["batches"][number]> {
    return request<MedicationSummary["batches"][number]>({
      method: "POST",
      path: `/api/v1/medicines/${medicineId}/batches`,
      payload: toPayload(payload),
    });
  },

  updateBatch(
    medicineId: string,
    batchId: string,
    payload: BatchPayload,
  ): Promise<MedicationSummary["batches"][number]> {
    return request<MedicationSummary["batches"][number]>({
      method: "PUT",
      path: `/api/v1/medicines/${medicineId}/batches/${batchId}`,
      payload: toPayload(payload),
    });
  },

  openSplitBatch(medicineId: string, batchId: string, payload: SplitBatchPayload): Promise<SplitBatchResponse> {
    return request<SplitBatchResponse>({
      method: "POST",
      path: `/api/v1/medicines/${encodeURIComponent(medicineId)}/batches/${encodeURIComponent(batchId)}/open-split`,
      payload: toPayload(payload),
    });
  },

  deleteBatch(medicineId: string, batchId: string): Promise<null> {
    return request<null>({
      method: "DELETE",
      path: `/api/v1/medicines/${medicineId}/batches/${batchId}`,
    });
  },

  listDosageNotes(medicineId: string): Promise<DosageNoteListResponse> {
    return request<DosageNoteListResponse>({
      method: "GET",
      path: `/api/v1/medicines/${medicineId}/dosage-notes`,
    });
  },

  createDosageNote(
    medicineId: string,
    payload: { content: string; visibility?: "private" | "family" },
  ): Promise<DosageNoteListResponse["notes"][number]> {
    return request<DosageNoteListResponse["notes"][number]>({
      method: "POST",
      path: `/api/v1/medicines/${medicineId}/dosage-notes`,
      payload: toPayload(payload),
    });
  },

  deleteDosageNote(medicineId: string, noteId: string): Promise<null> {
    return request<null>({
      method: "DELETE",
      path: `/api/v1/medicines/${medicineId}/dosage-notes/${noteId}`,
    });
  },

  createExportSnapshot(payload: { includePersonalDosage: boolean; includeArchived: boolean; includeStorageLocation: boolean }): Promise<{ snapshotId: string; generatedAt: string; expiresAt: string }> {
    return request({ method: "POST", path: "/api/v1/exports/snapshot", payload: { ...payload } });
  },
  exportCsv(payload: { snapshotId: string; includePersonalDosage: boolean; includeArchived: boolean; includeStorageLocation: boolean }): Promise<{ content: string; fileName: string; mimeType: string }> {
    return request({ method: "POST", path: "/api/v1/exports/csv", payload: { ...payload } });
  },
  exportPdf(payload: { snapshotId: string; includePersonalDosage: boolean; includeArchived: boolean; includeStorageLocation: boolean }): Promise<{ contentBase64: string; fileName: string; mimeType: string }> {
    return request({ method: "POST", path: "/api/v1/exports/pdf", payload: { ...payload } });
  },
  exportMarkdown(payload: {
    snapshotId?: string;
    includePersonalDosage?: boolean;
    includeArchived?: boolean;
    includeStorageLocation?: boolean;
  }): Promise<MarkdownExportResponse> {
    return request<MarkdownExportResponse>({
      method: "POST",
      path: "/api/v1/exports/markdown",
      payload: toPayload(payload),
    });
  },

  findMedicineCandidates(query: string, field: "barcode" | "name" = "barcode"): Promise<MedicineCandidatesResponse> {
    return request<MedicineCandidatesResponse>({
      method: "POST",
      path: "/api/v1/medicine-catalog/candidates",
      payload: { [field]: query, consentToShare: true },
    });
  },

  approveAppDeviceLink(code: string): Promise<AppDeviceLinkApproveResponse> {
    return request<AppDeviceLinkApproveResponse>({
      method: "POST",
      path: "/api/v1/auth/device-links/approve",
      payload: { code },
    });
  },

  getPendingNotifications(): Promise<NotificationPendingResponse> {
    return request<NotificationPendingResponse>({ method: "GET", path: "/api/v1/notifications/pending" });
  },

  getNotificationTemplates(): Promise<NotificationTemplatesResponse> {
    return request({ method: "GET", path: "/api/v1/notifications/templates" });
  },

  subscribeToNotifications(acceptedTemplateIds: string[]): Promise<{ acceptedTemplateIds: string[] }> {
    return request({
      method: "POST",
      path: "/api/v1/notifications/subscribe",
      payload: { acceptedTemplateIds },
    });
  },

  getFamilyInventorySettings(): Promise<{ settings: FamilyInventorySettings }> {
    return request({ method: "GET", path: "/api/v1/families/settings" });
  },

  updateFamilyInventorySettings(settings: FamilyInventorySettings): Promise<{ settings: FamilyInventorySettings }> {
    return request({
      method: "PUT",
      path: "/api/v1/families/settings",
      payload: { stocktakeInterval: settings.stocktakeInterval },
    });
  },

  getCurrentStocktake(): Promise<{ stocktake: StocktakeSession | null }> {
    return request({ method: "GET", path: "/api/v1/families/stocktakes/current" });
  },

  startStocktake(): Promise<{ stocktake: StocktakeSession }> {
    return request({ method: "POST", path: "/api/v1/families/stocktakes", payload: {} });
  },

  submitStocktakeItems(stocktakeId: string, items: StocktakeItemInput[]): Promise<{ results: StocktakeItemResult[] }> {
    return request({
      method: "POST",
      path: `/api/v1/families/stocktakes/${stocktakeId}/items`,
      payload: { items: items as unknown as unknown[] },
    });
  },

  completeStocktake(stocktakeId: string): Promise<{ completed: true; completedAt: string; nextStocktakeAt: string | null }> {
    return request({ method: "POST", path: `/api/v1/families/stocktakes/${stocktakeId}/complete`, payload: {} });
  },

  listRestockItems(): Promise<{ items: RestockItemSummary[] }> {
    return request({ method: "GET", path: "/api/v1/families/restock" });
  },

  createRestockItem(input: { medicineId: string; desiredQuantity?: number | null; unit: QuantityUnit }): Promise<RestockItemSummary> {
    return request({ method: "POST", path: "/api/v1/families/restock", payload: toPayload(input) });
  },

  updateRestockItem(itemId: string, status: "needed" | "purchased" | "dismissed", version: number): Promise<RestockItemSummary> {
    return request({ method: "PUT", path: `/api/v1/families/restock/${itemId}`, payload: { status, version } });
  },

  deleteRestockItem(itemId: string): Promise<null> {
    return request({ method: "DELETE", path: `/api/v1/families/restock/${itemId}` });
  },

  listTrash(): Promise<{ items: TrashItemSummary[] }> {
    return request({ method: "GET", path: "/api/v1/trash" });
  },

  restoreTrashItem(type: "medicine" | "batch", id: string): Promise<{ restored: true }> {
    return request({ method: "POST", path: `/api/v1/trash/${type}/${id}/restore`, payload: {} });
  },

  listAuditEvents(): Promise<{ events: AuditEventSummary[] }> {
    return request({ method: "GET", path: "/api/v1/families/audit" });
  },

  createJsonBackup(): Promise<CreateJsonBackupResponse> {
    return request({ method: "POST", path: "/api/v1/backups/json", payload: {} });
  },

  previewJsonBackup(backup: FamilyMedicineBackup): Promise<PreviewJsonBackupResponse> {
    return request({ method: "POST", path: "/api/v1/backups/preview", payload: { backup } });
  },

  restoreJsonBackup(backup: FamilyMedicineBackup, confirmationToken: string): Promise<RestoreJsonBackupResponse> {
    return request({ method: "POST", path: "/api/v1/backups/restore", payload: { backup, confirmationToken, confirmed: true } });
  },

  // —— 用药计划（R3）：后端接口见 routes/medication-plans.ts ——

  createCareProfile(payload: { displayName: string; linkedUserId?: string }): Promise<CareProfileSummary> {
    return request({ method: "POST", path: "/api/v1/care-profiles", payload });
  },

  /** B10：本人档案由服务端绑定当前身份（幂等），不再由客户端传 linkedUserId。 */
  ensureSelfCareProfile(displayName?: string): Promise<CareProfileSummary> {
    return request({ method: "POST", path: "/api/v1/care-profiles/self", ...(displayName ? { payload: { displayName } } : {}) });
  },

  listCareProfiles(): Promise<{ careProfiles: CareProfileSummary[] }> {
    return request({ method: "GET", path: "/api/v1/care-profiles" });
  },

  createCareGrant(careProfileId: string, payload: { memberUserId: string; canManage: boolean; receiveDoseReminders?: boolean }): Promise<{ careProfileId: string; memberUserId: string; canManage: boolean }> {
    return request({ method: "POST", path: `/api/v1/care-profiles/${careProfileId}/grants`, payload });
  },

  getNotificationPreferences(): Promise<{ preferences: NotificationPreferences }> {
    return request({ method: "GET", path: "/api/v1/notification-preferences" });
  },
  updateNotificationPreferences(preferences: NotificationPreferences): Promise<{ preferences: NotificationPreferences }> {
    return request({ method: "PUT", path: "/api/v1/notification-preferences", payload: { ...preferences } });
  },
  transferCareManagement(careProfileId: string, memberUserId: string): Promise<unknown> {
    return request({ method: "POST", path: `/api/v1/care-profiles/${encodeURIComponent(careProfileId)}/transfer-management`, payload: { memberUserId } });
  },
  archiveCareProfile(careProfileId: string): Promise<unknown> {
    return request({ method: "POST", path: `/api/v1/care-profiles/${encodeURIComponent(careProfileId)}/archive` });
  },
  listCareGrants(careProfileId: string): Promise<CareGrantListResponse> {
    return request({ method: "GET", path: `/api/v1/care-profiles/${careProfileId}/grants` });
  },

  revokeCareGrant(careProfileId: string, memberUserId: string): Promise<{ careProfileId: string; memberUserId: string; removed: boolean }> {
    return request({ method: "DELETE", path: `/api/v1/care-profiles/${careProfileId}/grants/${memberUserId}` });
  },

  /** status 缺省为未结束；传 "all" 或 "ended" 可查看已结束的计划。 */
  listMedicationPlans(status?: "all" | "ended"): Promise<{ plans: MedicationPlanSummary[] }> {
    const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
    return request({ method: "GET", path: `/api/v1/medication-plans${suffix}` });
  },

  getMedicationPlan(planId: string): Promise<MedicationPlanDetailResponse> {
    return request({ method: "GET", path: `/api/v1/medication-plans/${planId}` });
  },

  updateMedicationPlan(planId: string, payload: MedicationPlanUpdatePayload & { version: number }): Promise<MedicationPlanUpdateResponse> {
    return request({ method: "PUT", path: `/api/v1/medication-plans/${planId}`, payload: toPayload(payload) });
  },

  getMedicationPlanHistory(planId: string): Promise<PlanHistoryResponse> {
    return request({ method: "GET", path: `/api/v1/medication-plans/${planId}/history` });
  },

  /** 服药提醒状态：模板可用性与最近发送结果（R4）。 */
  getDoseReminderStatus(): Promise<DoseReminderStatusResponse> {
    return request({ method: "GET", path: "/api/v1/medication-plans/reminders/status" });
  },

  createMedicationPlan(payload: MedicationPlanPayload): Promise<{ planId: string; careProfileId: string; status: string; version: number }> {
    return request({ method: "POST", path: "/api/v1/medication-plans", payload: toPayload(payload) });
  },

  changeMedicationPlanStatus(planId: string, action: "pause" | "resume" | "end", version: number): Promise<{ planId: string; status: string; version: number }> {
    return request({ method: "POST", path: `/api/v1/medication-plans/${planId}/${action}`, payload: { version } });
  },

  getMedicationSchedule(date?: string): Promise<ScheduleResponse> {
    const suffix = date ? `?date=${encodeURIComponent(date)}` : "";
    return request({ method: "GET", path: `/api/v1/medication-plans/schedule${suffix}` });
  },

  confirmDoseOccurrence(occurrenceId: string, action: "taken" | "skipped", idempotencyKey: string): Promise<{ occurrenceId: string; status: "pending" | "taken" | "skipped"; replayed: boolean }> {
    return request({ method: "POST", path: `/api/v1/dose-occurrences/${occurrenceId}/confirm`, payload: { action, idempotencyKey } });
  },
};
