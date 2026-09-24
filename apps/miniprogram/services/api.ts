// 统一网络层：Bearer 令牌注入、统一错误 shape 解析（{ error: { code, message } }）、
// 401 自动清除本地令牌。所有页面经由本模块访问后端，不直接调用 wx.request。
import { API_BASE } from "./config";
import type {
  AcceptInvitationResponse,
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
      method: options.method,
      data: options.payload,
      header,
      timeout: 10000,
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
  login(code: string): Promise<AuthSessionResponse> {
    return request<AuthSessionResponse>({
      method: "POST",
      path: "/api/v1/auth/wechat",
      payload: { code },
      anonymous: true,
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

  removeMember(memberId: string): Promise<null> {
    return request<null>({
      method: "DELETE",
      path: `/api/v1/families/members/${memberId}`,
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
};
