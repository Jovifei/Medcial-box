// 与后端 packages/contracts 对齐的接口类型（小程序端独立声明，避免运行时依赖）。
// 字段命名与 contracts 保持一致；后端变更时需同步本文件。

export type ExpiryPrecision = "day" | "month" | "unknown";

/** 计件单位：数量必须是非负整数。 */
export type CountQuantityUnit = "tablet" | "capsule" | "sachet" | "bottle" | "box" | "blister" | "other";
/** 计量单位：毫升，最多 3 位小数。 */
export type MeasuredQuantityUnit = "ml";
export type QuantityUnit = CountQuantityUnit | MeasuredQuantityUnit;

export type OpenedState = "unknown" | "unopened" | "opened";
export type OpenedExpiryUnit = "day" | "month";
export type StockStatus = "ok" | "low" | "unknown" | "exhausted";
export type StocktakeInterval = "weekly" | "monthly" | "disabled";
export type RestockStatus = "needed" | "purchased" | "dismissed";
export type AfterOpeningLimitInput =
  | { value: number; unit: OpenedExpiryUnit; source?: string | null }
  | { date: string; source?: string | null };

export interface LowStockThresholdInput {
  quantity: number;
  unit: QuantityUnit;
}

export type ExpiryState = "expired" | "due_this_month" | "expiring_soon" | "ok" | "unknown";

export interface ExpiryValue {
  value: string | null;
  precision: ExpiryPrecision;
}

export interface ExpiryStateInfo {
  state: ExpiryState;
  label: string;
}

export type LeafletReviewStatus = "unverified" | "matched" | "user_confirmed";

export type NoteVisibility = "private" | "family";

export interface MedicationBatchSummary {
  id: string;
  lotNumber: string | null;
  expiry: ExpiryValue;
  expiryState: ExpiryStateInfo;
  quantity: number | null;
  unit: QuantityUnit;
  confirmedUnitsPerPackage: number | null;
  storageLocation: string | null;
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
  id: string;
  name: string;
  /** 人群整理标签（可多选）；空数组 = 未标注。 */
  populationTags?: Array<"adult" | "child">;
  /** 用途整理标签（可多选）。 */
  purposeTags?: string[];
  /** 标签来源：人工填写 / 资料候选 / 导入。 */
  tagSource?: "manual" | "catalog" | "imported";
  /** 药盒封面照片 id；null 表示没有照片。 */
  coverPhotoId?: string | null;
  specification: string | null;
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
  expiryState?: ExpiryStateInfo;
  isArchived?: boolean;
  version: number;
}

export interface MedicineListResponse {
  medicines: MedicationSummary[];
}

export interface BatchExpiryInput {
  value: string | null;
  precision: ExpiryPrecision;
}

export interface BatchPayload {
  lotNumber?: string | null;
  expiry?: BatchExpiryInput | null;
  quantity?: number | null;
  unit?: QuantityUnit;
  confirmedUnitsPerPackage?: number | null;
  storageLocation?: string | null;
  openedState?: OpenedState;
  openedAt?: string | null;
  afterOpeningLimit?: AfterOpeningLimitInput | null;
  version?: number;
}

export interface SplitBatchPayload {
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

export interface MedicinePayload {
  name: string;
  specification?: string | null;
  manufacturer?: string | null;
  approvalNumber?: string | null;
  barcodeValue?: string | null;
  activeIngredients?: string[];
  purposeCategory?: string | null;
  leaflet?: {
    purposeSummary?: string | null;
    packageUsageSummary?: string | null;
    contraindicationsSummary?: string | null;
    precautionsSummary?: string | null;
    source?: string | null;
    reviewStatus?: LeafletReviewStatus;
  };
  batches?: BatchPayload[];
  lowStockThreshold?: LowStockThresholdInput | null;
  version?: number;
}

export interface MedicineCandidate {
  name: string;
  specification: string | null;
  manufacturer: string | null;
  approvalNumber: string | null;
  barcodeValue?: string | null;
  activeIngredients: string[];
  leaflet: NonNullable<MedicinePayload["leaflet"]> | null;
  source: string;
  sourceUpdatedAt: string | null;
  matchReasons: string[];
}

export interface MedicineCandidatesResponse {
  candidates: MedicineCandidate[];
  warnings: string[];
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

export interface StocktakeSession {
  id: string;
  status: "open" | "completed";
  startedAt: string;
  completedAt?: string | null;
  items: Array<{
    batchId: string;
    medicineId: string;
    medicineName: string;
    quantity: number | null;
    unit: QuantityUnit;
    expiry: ExpiryValue;
    openedState: OpenedState;
    openedAt: string | null;
    managementExpiryDate: string | null;
    version: number;
    result: "pending" | "saved" | "conflict" | "not_found";
  }>;
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

export interface TrashItemSummary {
  type: "medicine" | "batch";
  id: string;
  medicineId?: string;
  name: string;
  deletedAt: string;
  expiresAt: string;
  quantity?: number | null;
  unit?: QuantityUnit;
}

export interface AuditEventSummary {
  id: string;
  actorId: string | null;
  actorName: string | null;
  entityType: string;
  entityId: string;
  action: string;
  changes: Record<string, unknown>;
  createdAt: string;
}

export interface PendingNotificationSummary {
  id: string;
  type: "expired" | "expiry_due" | "low_stock" | "needs_check" | "stocktake_due" | "leaflet_missing";
  medicineId: string | null;
  batchId: string | null;
  medicineName: string;
  message: string;
  dueDate: string | null;
  action: "edit_batch" | "restock" | "stocktake" | "review_leaflet";
}

export interface NotificationTemplateSummary {
  templateId: string;
  title: string;
  available: boolean;
}

export interface NotificationPendingResponse {
  items: PendingNotificationSummary[];
}

export interface NotificationTemplatesResponse {
  available: boolean;
  templates: NotificationTemplateSummary[];
  reason?: string;
}

export interface DosageNoteSummary {
  id: string;
  medicineId: string;
  userId: string;
  isMine: boolean;
  content: string;
  visibility: NoteVisibility;
  version: number;
}

export interface DosageNoteListResponse {
  notes: DosageNoteSummary[];
}

export interface FamilyMemberSummary {
  id: string;
  /** 成员账号标识：照护授权按它指定被授权人。 */
  userId: string;
  role: "owner" | "member";
  /** 展示名：昵称或按加入顺序生成的稳定标签（成员 1…）。 */
  displayName: string;
  /** 是否为当前会话用户本人。 */
  isSelf: boolean;
  joinedAt: string;
}

export interface FamilySummary {
  id: string;
  name: string;
  role: "owner" | "member";
  members: FamilyMemberSummary[];
}

export interface GetCurrentFamilyResponse {
  family: FamilySummary;
}

export interface CreateInvitationResponse {
  invitationCode: string;
  expiresAt: string;
}

export interface AcceptInvitationResponse {
  family: { id: string; name: string };
  membership: FamilyMemberSummary;
}

export interface TransferOwnershipResponse {
  membership: FamilyMemberSummary;
}

export interface CreateFamilyResponse {
  family: { id: string; name: string };
  membership: FamilyMemberSummary;
}

export interface AuthSessionResponse {
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
    role: "owner" | "member";
  } | null;
}

export interface DeviceSessionSummary {
  id: string;
  clientKind: "miniprogram" | "android";
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

export interface AuthDevicesResponse { devices: DeviceSessionSummary[] }

export interface UpdateProfileResponse {
  user: {
    id: string;
    nickname: string | null;
  };
}

export interface InvitationPreviewResponse {
  family: { id: string; name: string };
  expiresAt: string;
}

export interface MarkdownExportResponse {
  markdown: string;
  generatedAt: string;
}

export interface AppDeviceLinkApproveResponse { approved: true }
export interface FamilyMedicineBackup {
  schemaVersion: 1;
  backupId: string;
  exportedAt: string;
  familyName: string;
  medicines: MedicinePayload[];
  inventorySettings: FamilyInventorySettings;
}
export type CreateJsonBackupResponse = FamilyMedicineBackup;
export interface PreviewJsonBackupResponse {
  valid: boolean;
  duplicateBackup: boolean;
  confirmationToken?: string;
  inventorySettings?: FamilyInventorySettings;
  medicineCount: number;
  likelyMatches: Array<{ importedName: string; existingMedicineId: string; existingName: string }>;
  errors: string[];
}
export interface RestoreJsonBackupResponse { restoredCount: number; backupId: string }

export interface MedicineRecognitionResponse {
  draft: {
    name: string | null;
    specification: string | null;
    manufacturer: string | null;
    approvalNumber: string | null;
    purposeCategory: string | null;
    lotNumber: string | null;
    expiryValue: string | null;
    expiryPrecision: ExpiryPrecision | null;
  };
  warnings: string[];
  requiresConfirmation: true;
}

export interface LeafletPhotoSummary {
  id: string;
  medicineId: string;
  contentType: "image/jpeg" | "image/png";
  sizeBytes: number;
  source: string;
  createdAt: string;
  url: string;
}

// —— 用药计划（R3）——

export interface CareProfileSummary {
  id: string;
  displayName: string;
  linkedUserId: string | null;
  canManage?: boolean;
  isPrivate: boolean;
}

export interface MedicationPlanPayload {
  careProfileId: string;
  medicineId?: string | null;
  medicineName: string;
  dosageText: string;
  timeSlots: string[];
  weekdays?: string[];
  startDate: string;
  endDate?: string | null;
}

export interface MedicationPlanSummary {
  id: string;
  careProfileId: string;
  careProfileName: string;
  medicineId: string | null;
  medicineName: string;
  dosageText: string;
  weekdays: string[];
  startDate: string;
  endDate: string | null;
  status: "active" | "paused" | "ended";
  version: number;
  timeSlots: string[];
}

export interface ScheduleEntry {
  occurrenceId: string;
  planId: string;
  careProfileId: string;
  careProfileName: string;
  medicineName: string;
  dosageText: string;
  time: string;
  status: "pending" | "taken" | "skipped";
}

export interface ScheduleResponse {
  date: string;
  entries: ScheduleEntry[];
}

export interface MedicationPlanUpdatePayload {
  medicineName?: string;
  dosageText?: string;
  timeSlots?: string[];
  weekdays?: string[];
  startDate?: string;
  endDate?: string | null;
}

export interface MedicationPlanUpdateResponse {
  planId: string;
  version: number;
  timeSlots: string[];
  note: string;
}

export interface MedicationPlanDetailResponse {
  plan: MedicationPlanSummary;
  canManage: boolean;
}

export interface PlanHistoryEvent {
  action: "taken" | "skipped";
  actor: string | null;
  at: string;
}

export interface PlanHistoryRecord {
  occurrenceId: string;
  date: string;
  time: string;
  status: "pending" | "taken" | "skipped";
  corrected: boolean;
  events: PlanHistoryEvent[];
}

export interface PlanHistoryResponse {
  planId: string;
  medicineName: string;
  history: PlanHistoryRecord[];
}

export interface CareGrantSummary {
  memberUserId: string;
  displayName: string;
  canView: boolean;
  canManage: boolean;
}

export interface DoseReminderDelivery {
  date: string;
  time: string;
  status: "queued" | "sending" | "sent" | "failed" | "blocked" | "cancelled";
  statusLabel: string;
  sentAt: string | null;
}

export interface DoseReminderStatusResponse {
  available: boolean;
  reason: string | null;
  templateId: string;
  deliveries: DoseReminderDelivery[];
}

export interface CareGrantListResponse {
  careProfileId: string;
  displayName: string;
  grants: CareGrantSummary[];
}
