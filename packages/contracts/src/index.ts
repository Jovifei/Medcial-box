export type ExpiryPrecision = "day" | "month" | "unknown";

export type QuantityUnit = "tablet" | "capsule" | "sachet" | "bottle" | "box" | "other";

export type ExpiryState = "expired" | "due_this_month" | "expiring_soon" | "ok" | "unknown";

export interface ExpiryValue {
  /** Keep the value as printed; a month-only date stays YYYY-MM. */
  value: string | null;
  precision: ExpiryPrecision;
}

export interface ExpiryStateInfo {
  state: ExpiryState;
  label: string;
}

export type LeafletReviewStatus = "unverified" | "matched" | "user_confirmed";

export type NoteVisibility = "private" | "family";

export type MemberRole = "owner" | "member";

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "SESSION_EXPIRED"
  | "FORBIDDEN"
  | "OWNER_ONLY"
  | "NOT_FOUND"
  | "FAMILY_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "ALREADY_IN_FAMILY"
  | "INVITATION_EXPIRED"
  | "INVITATION_USED"
  | "OWNER_CANNOT_LEAVE"
  | "WECHAT_EXCHANGE_FAILED"
  | "WECHAT_GATEWAY_ERROR"
  | "INTERNAL_ERROR";

export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

export interface HealthStatus {
  status: "ok" | "unavailable";
  database?: "connected" | "disconnected";
}

// ---------------------------------------------------------------------------
// 认证与会话
// ---------------------------------------------------------------------------

export interface AuthWechatRequest {
  code: string;
}

export interface AuthWechatResponse {
  token: string;
  expiresAt: string;
  user: {
    id: string;
    hasFamily: boolean;
  };
}

// ---------------------------------------------------------------------------
// 家庭
// ---------------------------------------------------------------------------

export interface FamilyCore {
  id: string;
  name: string;
}

export interface FamilyMemberSummary {
  id: string;
  role: MemberRole;
  /** 展示名：用户昵称；未设置时按加入顺序生成（成员 1、成员 2…）。 */
  displayName: string;
  /** 是否为当前会话用户本人（界面标注"我"）。 */
  isSelf: boolean;
  joinedAt: string;
}

export interface CreateFamilyInput {
  name: string;
}

export interface CreateFamilyResponse {
  family: FamilyCore;
  membership: FamilyMemberSummary;
}

export interface FamilySummary {
  id: string;
  name: string;
  role: MemberRole;
  members: FamilyMemberSummary[];
}

export interface GetCurrentFamilyResponse {
  family: FamilySummary;
}

// ---------------------------------------------------------------------------
// P2 家庭共享：一次性邀请
// ---------------------------------------------------------------------------

export interface CreateInvitationResponse {
  /** 明文邀请码仅在本响应出现一次；服务端只存 SHA-256 哈希。 */
  invitationCode: string;
  expiresAt: string;
}

export interface AcceptInvitationRequest {
  code: string;
}

export interface AcceptInvitationResponse {
  family: FamilyCore;
  membership: FamilyMemberSummary;
}

export interface TransferOwnershipResponse {
  membership: FamilyMemberSummary;
}

// ---------------------------------------------------------------------------
// 药品与批次
// ---------------------------------------------------------------------------

export interface LeafletInput {
  purposeSummary?: string | null;
  packageUsageSummary?: string | null;
  contraindicationsSummary?: string | null;
  precautionsSummary?: string | null;
  source?: string | null;
  reviewStatus?: LeafletReviewStatus;
}

export interface BatchExpiryInput {
  value: string | null;
  precision: ExpiryPrecision;
}

export interface CreateBatchInput {
  lotNumber?: string | null;
  expiry?: BatchExpiryInput | null;
  quantity?: number | null;
  unit?: QuantityUnit;
  confirmedUnitsPerPackage?: number | null;
  storageLocation?: string | null;
}

export interface UpdateBatchInput extends CreateBatchInput {
  version: number;
}

export interface CreateMedicineInput {
  name: string;
  specification?: string | null;
  manufacturer?: string | null;
  approvalNumber?: string | null;
  activeIngredients?: string[];
  purposeCategory?: string | null;
  leaflet?: LeafletInput;
  batches?: CreateBatchInput[];
}

export interface UpdateMedicineInput
  extends Omit<CreateMedicineInput, "batches"> {
  version: number;
}

export interface MedicationBatchSummary {
  id: string;
  lotNumber: string | null;
  expiry: ExpiryValue;
  /** 派生有效期状态（读取时按当前时间计算，不落库）。 */
  expiryState: ExpiryStateInfo;
  quantity: number | null;
  unit: QuantityUnit;
  confirmedUnitsPerPackage: number | null;
  storageLocation: string | null;
  version: number;
}

export interface MedicationSummary {
  id: string;
  name: string;
  specification: string | null;
  manufacturer: string | null;
  approvalNumber: string | null;
  activeIngredients: string[];
  purposeCategory: string | null;
  leaflet: {
    purposeSummary: string | null;
    packageUsageSummary: string | null;
    contraindicationsSummary: string | null;
    precautionsSummary: string | null;
    source: string | null;
    reviewStatus: LeafletReviewStatus;
  };
  batches: MedicationBatchSummary[];
  /** 全部批次中最严重的有效期状态；无批次时为 unknown。 */
  expiryState?: ExpiryStateInfo;
  isArchived?: boolean;
  /** 并发控制版本号，PUT 携带的 version 不匹配时返回 409。 */
  version: number;
}

export interface MedicineListResponse {
  medicines: MedicationSummary[];
}

export interface BatchListResponse {
  batches: MedicationBatchSummary[];
}

// ---------------------------------------------------------------------------
// 个人剂量备注
// ---------------------------------------------------------------------------

export interface DosageNoteSummary {
  id: string;
  medicineId: string;
  userId: string;
  isMine: boolean;
  content: string;
  visibility: NoteVisibility;
  version: number;
}

export interface CreateDosageNoteInput {
  content: string;
  visibility?: NoteVisibility;
}

export interface UpdateDosageNoteInput {
  content?: string;
  visibility?: NoteVisibility;
  version: number;
}

export interface DosageNoteListResponse {
  notes: DosageNoteSummary[];
}

// ---------------------------------------------------------------------------
// Markdown 导出（接口约定先行，实现随 P1 后续批次）
// ---------------------------------------------------------------------------

export interface MarkdownExportRequest {
  includePersonalDosage?: boolean;
  includeArchived?: boolean;
  includeStorageLocation?: boolean;
}

export interface MarkdownExportResponse {
  markdown: string;
  generatedAt: string;
}
