export type ExpiryPrecision = "day" | "month" | "unknown";

/** 计件单位：数量必须是非负整数。 */
export type CountQuantityUnit = "tablet" | "capsule" | "sachet" | "bottle" | "tube" | "box" | "blister" | "other";
/** 计量单位：毫升，最多 3 位小数。 */
export type MeasuredQuantityUnit = "ml";
export type QuantityUnit = CountQuantityUnit | MeasuredQuantityUnit;

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

export type OpenedState = "unknown" | "unopened" | "opened";
export type OpenedExpiryUnit = "day" | "month";
export type StockStatus = "ok" | "low" | "unknown" | "exhausted";
export type StocktakeInterval = "weekly" | "monthly" | "disabled";
export type RestockStatus = "needed" | "purchased" | "dismissed";
export type DispositionStatus = "active" | "handled";

/** 人群整理标签：空数组表示"未标注"；成人可与儿童同时标记。 */
export type PopulationTag = "adult" | "child";

/** 用途整理标签：家庭整理用，不代表适应症判断。 */
export type PurposeTag =
  | "fever"
  | "cough"
  | "throat"
  | "nasal"
  | "gastro"
  | "pain"
  | "topical"
  | "allergy"
  | "itch"
  | "eye"
  | "oral"
  | "constipation"
  | "diarrhea"
  | "other";

/**
 * 照片用途：
 * - box_front 药盒正面（识别药品用，可设为封面）
 * - expiry    包装有效期（绑定具体库存批次）
 * - leaflet   说明书（单独展示，不充当封面）
 */
export type PhotoPurpose = "box_front" | "expiry" | "leaflet";

/** 标签来源：人工填写 / 资料候选 / 导入。 */
export type TagSource = "manual" | "catalog" | "imported";

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
  | "PLAN_ENDED"
  | "CARE_HANDOVER_REQUIRED"
  | "OCCURRENCE_SUPERSEDED"
  | "ALREADY_IN_FAMILY"
  | "INVITATION_EXPIRED"
  | "INVITATION_USED"
  | "OWNER_CANNOT_LEAVE"
  | "WECHAT_EXCHANGE_FAILED"
  | "WECHAT_GATEWAY_ERROR"
  | "RATE_LIMITED"
  | "RECOGNITION_UNAVAILABLE"
  | "PHOTO_UPLOAD_PENDING"
  | "MEDICINE_CATALOG_UNAVAILABLE"
  | "MEDICINE_CATALOG_NOT_CONFIGURED"
  | "NOTIFICATION_UNAVAILABLE"
  | "BACKUP_ALREADY_IMPORTED"
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

/** Photo recognition is a draft only; the user must check it before saving. */
export interface MedicineRecognitionDraft {
  brand?: string | null;
  populationTags?: PopulationTag[];
  leaflet?: { text: string | null; purposeSummary: string | null; packageUsageSummary: string | null; contraindicationsSummary: string | null; precautionsSummary: string | null };
  name: string | null;
  specification: string | null;
  manufacturer: string | null;
  approvalNumber: string | null;
  purposeCategory: string | null;
  lotNumber: string | null;
  expiryValue: string | null;
  expiryPrecision: ExpiryPrecision | null;
  purposeTags?: PurposeTag[];
}

export interface MedicineRecognitionResponse {
  draft: MedicineRecognitionDraft;
  warnings: string[];
  requiresConfirmation: true;
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

export interface AuthMeResponse {
  user: {
    id: string;
    nickname: string | null;
    hasFamily: boolean;
  };
  family: {
    id: string;
    name: string;
    role: MemberRole;
  } | null;
}

export interface LogoutResponse {
  revoked: true;
}

export interface UpdateCurrentUserRequest {
  /** Empty string or null clears the optional display name. */
  nickname: string | null;
}

export interface UpdateCurrentUserResponse {
  user: {
    id: string;
    nickname: string | null;
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

export interface PreviewInvitationRequest {
  invitationCode: string;
}

export interface PreviewInvitationResponse {
  family: FamilyCore;
  expiresAt: string;
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

export type AfterOpeningLimitInput =
  | { value: number; unit: OpenedExpiryUnit; source?: string | null }
  | { date: string; source?: string | null };

export interface LowStockThresholdInput {
  quantity: number;
  unit: QuantityUnit;
}

export interface CreateBatchInput {
  lotNumber?: string | null;
  expiry?: BatchExpiryInput | null;
  quantity?: number | null;
  unit?: QuantityUnit;
  confirmedUnitsPerPackage?: number | null;
  conversionUnit?: QuantityUnit | null;
  storageLocation?: string | null;
  openedState?: OpenedState;
  openedAt?: string | null;
  afterOpeningLimit?: AfterOpeningLimitInput | null;
}

export interface UpdateBatchInput extends CreateBatchInput {
  version: number;
}

export interface SplitBatchInput {
  version: number;
  openedQuantity: number;
  openedAt: string;
  afterOpeningLimit?: AfterOpeningLimitInput | null;
  confirmed: true;
}

export interface SplitBatchResponse {
  openedBatch: MedicationBatchSummary;
  remainingBatch: MedicationBatchSummary;
}

export interface CreateMedicineInput {
  idempotencyKey?: string;
  name: string;
  populationTags?: PopulationTag[];
  purposeTags?: PurposeTag[];
  specification?: string | null;
  brand?: string | null;
  manufacturer?: string | null;
  approvalNumber?: string | null;
  barcodeValue?: string | null;
  activeIngredients?: string[];
  purposeCategory?: string | null;
  leaflet?: LeafletInput;
  batches?: CreateBatchInput[];
  lowStockThreshold?: LowStockThresholdInput | null;
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
  conversionUnit?: QuantityUnit | null;
  storageLocation: string | null;
  dispositionStatus?: DispositionStatus;
  openedState?: OpenedState;
  openedAt?: string | null;
  afterOpeningLimit?: AfterOpeningLimitInput | null;
  openedExpiryDate?: string | null;
  managementExpiryDate?: string | null;
  managementExpirySource?: "package" | "opened" | null;
  managementExpiryState?: ExpiryStateInfo;
  version: number;
}

export interface MedicationSummary {
  createdAt?: string;
  id: string;
  name: string;
  /** 人群整理标签（可多选）；空数组 = 未标注。 */
  populationTags?: PopulationTag[];
  /** 用途整理标签（可多选）。 */
  purposeTags?: PurposeTag[];
  /** 标签来源，便于区分人工填写与资料候选。 */
  tagSource?: TagSource;
  /** 药盒封面照片 id；null 表示没有照片。 */
  coverPhotoId?: string | null;
  specification: string | null;
  brand?: string | null;
  manufacturer: string | null;
  approvalNumber: string | null;
  barcodeValue?: string | null;
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
  lowStockThreshold?: LowStockThresholdInput | null;
  stockStatus?: { state: StockStatus; quantity: number | null; unit: QuantityUnit | null };
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

export interface FamilyInventorySettings {
  stocktakeInterval: StocktakeInterval;
  lastStocktakeAt: string | null;
  nextStocktakeAt: string | null;
}

export interface StocktakeItemInput {
  batchId: string;
  version: number;
  outcome: "unchanged" | "adjusted" | "empty" | "handled" | "deferred";
  quantity?: number | null;
}

export interface StocktakeItemResult {
  batchId: string;
  outcome: "saved" | "conflict" | "not_found";
  currentVersion?: number;
}

export interface RestockItemSummary {
  id: string;
  medicineId: string;
  medicineName: string;
  desiredQuantity: number | null;
  unit: QuantityUnit;
  status: RestockStatus;
  createdAt: string;
  version: number;
}

export interface MedicineCandidate {
  name: string;
  specification: string | null;
  brand?: string | null;
  manufacturer: string | null;
  approvalNumber: string | null;
  barcodeValue?: string | null;
  activeIngredients: string[];
  leaflet: LeafletInput | null;
  source: string;
  sourceUpdatedAt: string | null;
  matchReasons: string[];
}

export interface MedicineCandidatesResponse {
  candidates: MedicineCandidate[];
  warnings: string[];
}

export interface AppDeviceLinkStartResponse {
  code: string;
  pollToken: string;
  expiresAt: string;
}

export interface AuthDeviceSummary {
  id: string;
  clientKind: "miniprogram" | "android";
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

export interface AuthDevicesResponse {
  devices: AuthDeviceSummary[];
}

export interface AppDeviceLinkExchangeResponse {
  state: "pending" | "approved" | "expired";
  token?: string;
  expiresAt?: string;
  user?: { id: string; hasFamily: boolean };
}

export interface MedicineCatalogCandidateRequest {
  name?: string;
  specification?: string;
  manufacturer?: string;
  approvalNumber?: string;
  barcode?: string;
  consentToShare: true;
}

export interface MedicineLeafletPhotoSummary {
  id: string;
  medicineId: string;
  contentType: "image/jpeg" | "image/png";
  sizeBytes: number;
  source: string;
  createdAt: string;
  url: string;
}

export interface WechatReminderTemplate {
  templateId: string;
  title: string;
  available: boolean;
}

export interface WechatReminderTemplatesResponse {
  available: boolean;
  templates: WechatReminderTemplate[];
  reason?: string;
}

export interface WechatReminderSubscribeRequest {
  acceptedTemplateIds: string[];
}

export interface WechatReminderSubscribeResponse {
  acceptedTemplateIds: string[];
}

export interface PendingReminderItem {
  id: string;
  type: "expired" | "expiry_due" | "low_stock" | "needs_check" | "stocktake_due" | "leaflet_missing";
  medicineId: string | null;
  batchId: string | null;
  medicineName: string;
  message: string;
  dueDate: string | null;
  action: "edit_batch" | "restock" | "stocktake" | "review_leaflet";
}

/** 备份中的批次输入：允许携带处置状态（正常创建/编辑请求不允许直接写入）。 */
export interface BackupBatchInput extends CreateBatchInput {
  /** 缺省视为 active（旧版备份兼容）；handled 批次恢复后不参与正常库存。 */
  dispositionStatus?: DispositionStatus;
}

export interface BackupMedicineInput extends Omit<CreateMedicineInput, "batches"> {
  isArchived?: boolean;
  batches?: BackupBatchInput[];
}

export interface FamilyMedicineBackup {
  /** v1：整数数量与旧单位；v2：定点数量（ml 三位小数）与 ml/blister 单位。 */
  schemaVersion: 1 | 2;
  backupId: string;
  exportedAt: string;
  familyName: string;
  medicines: BackupMedicineInput[];
  inventorySettings: FamilyInventorySettings;
}

export interface BackupPreviewResponse {
  valid: boolean;
  duplicateBackup: boolean;
  confirmationToken?: string;
  inventorySettings?: FamilyInventorySettings;
  /** 备份中将恢复为已处理（不参与正常库存与提醒）的批次数；缺省视为 0。 */
  handledBatchCount?: number;
  /** 恢复范围提示：当前固定仅恢复库存记录，不覆盖家庭盘点设置。 */
  settingsPolicy?: "inventory_only";
  medicineCount: number;
  likelyMatches: Array<{ importedName: string; existingMedicineId: string; existingName: string }>;
  errors: string[];
}

export interface BackupRestoreResponse {
  restoredCount: number;
  backupId: string;
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
  snapshotId?: string;
  includePersonalDosage?: boolean;
  includeArchived?: boolean;
  includeStorageLocation?: boolean;
}

export interface MarkdownExportResponse {
  snapshotId?: string;
  markdown: string;
  generatedAt: string;
}

export type NotificationChannel = "wechat" | "android";
export interface NotificationPreferences { stockReminderTime: string; timezone: "Asia/Shanghai"; channels: NotificationChannel[] }
export interface NotificationPreferencesResponse { preferences: NotificationPreferences }
export interface UpdateNotificationPreferencesRequest { stockReminderTime: string; channels: NotificationChannel[] }
export interface CareGrantRequest { memberUserId: string; canView?: boolean; canManage: boolean; receiveDoseReminders?: boolean }
export interface CareGrantSummary { memberUserId: string; displayName: string; canView: boolean; canManage: boolean; receiveDoseReminders: boolean }
export interface CareGrantsResponse { careProfileId: string; displayName: string; grants: CareGrantSummary[] }
export interface TransferCareManagementRequest { memberUserId: string }
export interface CareProfileLifecycleResponse { careProfileId: string; transferred?: true; archived?: true }

export interface DoseScheduleEntry {
 occurrenceId: string; planId: string; careProfileId: string; careProfileName: string;
 medicineName: string; dosageText: string; time: string; status: "pending" | "taken" | "skipped";
 snapshotComplete: boolean; receiveDoseReminders: boolean;
}
export interface DoseScheduleResponse { date: string; entries: DoseScheduleEntry[] }

export interface InventoryExportOptions { includePersonalDosage: boolean; includeArchived: boolean; includeStorageLocation: boolean }
export interface InventoryExportMedicine extends MedicationSummary { dosageNotes?: Array<{userId:string;isMine:boolean;content:string}> }
export interface InventoryExportSnapshotResponse { snapshotId:string; generatedAt:string; expiresAt:string; options:InventoryExportOptions; medicines:InventoryExportMedicine[] }
export interface CsvExportResponse { content:string; fileName:string; mimeType:"text/csv; charset=utf-8"; generatedAt:string; snapshotId:string }
export interface PdfExportResponse { contentBase64:string; fileName:string; mimeType:"application/pdf"; generatedAt:string; snapshotId:string }

/** Least-privilege Android projection: no plan/profile/drug/dose/history metadata. */
export interface DoseReminderScheduleEntry {
  occurrenceId: string;
  date: string;
  time: string;
  label: "有一项用药安排待确认";
}
export interface DoseReminderScheduleResponse {
  startDate: string;
  endDate: string;
  timezone: "Asia/Shanghai";
  entries: DoseReminderScheduleEntry[];
}
