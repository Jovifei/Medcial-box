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
