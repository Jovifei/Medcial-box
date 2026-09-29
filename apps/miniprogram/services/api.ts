// 统一网络层：Bearer 令牌注入、统一错误 shape 解析（{ error: { code, message } }）、
// 401 自动清除本地令牌。所有页面经由本模块访问后端，不直接调用 wx.request。
import { API_BASE } from "./config";
import type {
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
  FamilyMedicineBackup,
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
  ) {
    super(message);
  }
}

const TOKEN_STORAGE_KEY = "home_medicine_session_token";

export function readToken(): string {
  try {
    return (wx.getStorageSync(TOKEN_STORAGE_KEY) as string) || "";
  } catch {
    return "";
  }
}

export function storeToken(token: string): void {
  try {
    wx.setStorageSync(TOKEN_STORAGE_KEY, token);
  } catch {
    // 本地存储不可用时忽略：会话仅本次启动内有效。
  }
}

export function clearToken(): void {
  try {
    wx.removeStorageSync(TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
}

interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
  /** 匿名请求（登录本身）不附带 Authorization。 */
  anonymous?: boolean;
}

function parseErrorBody(raw: unknown, statusCode: number): ApiError {
  if (typeof raw === "object" && raw !== null) {
    const body = raw as { error?: { code?: unknown; message?: unknown } };
    if (
      typeof body.error === "object" &&
      body.error !== null &&
      typeof body.error.code === "string"
    ) {
      const message =
        typeof body.error.message === "string" ? body.error.message : `请求失败（${statusCode}）`;
      return new ApiError(body.error.code, message, statusCode);
    }
  }
  return new ApiError("REQUEST_FAILED", `请求失败（${statusCode}）`, statusCode);
}

export function request<T>(options: RequestOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const header: Record<string, string> = { "content-type": "application/json" };
    if (options.anonymous !== true) {
      const token = readToken();
      if (token !== "") header.authorization = `Bearer ${token}`;
    }
    wx.request({
      url: `${API_BASE}${options.path}`,
      method: options.method as unknown as WechatMiniprogram.RequestOption["method"],
      data: options.payload,
      header,
      timeout: options.timeoutMs ?? 10000,
      success: (response) => {
        const status = response.statusCode;
        if (status >= 200 && status < 300) {
          resolve(response.data as T);
          return;
        }
        if (status === 401) clearToken();
        reject(parseErrorBody(response.data as unknown, status));
      },
      fail: () => {
        reject(new ApiError("NETWORK_ERROR", "网络不可用，请确认家庭药箱服务已启动", 0));
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
  ): Promise<{ photo: LeafletPhotoSummary }> {
    return request({
      method: "POST",
      path: `/api/v1/medicines/${encodeURIComponent(medicineId)}/leaflet-photos`,
      payload: { imageBase64, mimeType, source },
      timeoutMs: 60000,
    });
  },

  downloadLeafletPhoto(medicineId: string, photoId: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const token = readToken();
      wx.downloadFile({
        url: `${API_BASE}/api/v1/medicines/${encodeURIComponent(medicineId)}/leaflet-photos/${encodeURIComponent(photoId)}`,
        header: token === "" ? {} : { authorization: `Bearer ${token}` },
        success: (response) => {
          if (response.statusCode >= 200 && response.statusCode < 300 && response.tempFilePath) {
            resolve(response.tempFilePath);
            return;
          }
          if (response.statusCode === 401) clearToken();
          reject(new ApiError(response.statusCode === 401 ? "UNAUTHORIZED" : "PHOTO_DOWNLOAD_FAILED",
            response.statusCode === 401 ? "登录已过期，请重新登录后查看图片" : `说明书图片读取失败（${response.statusCode}）`, response.statusCode));
        },
        fail: () => reject(new ApiError("NETWORK_ERROR", "说明书图片下载失败，请检查网络后重试", 0)),
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
    return request<null>({ method: "POST", path: "/api/v1/families/leave" });
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

  archiveMedicine(medicineId: string): Promise<null> {
    return request<null>({ method: "DELETE", path: `/api/v1/medicines/${medicineId}` });
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

  exportMarkdown(payload: {
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
};
