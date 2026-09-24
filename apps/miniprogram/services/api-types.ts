// 与后端 packages/contracts 对齐的接口类型（小程序端独立声明，避免运行时依赖）。
// 字段命名与 contracts 保持一致；后端变更时需同步本文件。

export type ExpiryPrecision = "day" | "month" | "unknown";

export type QuantityUnit = "tablet" | "capsule" | "sachet" | "bottle" | "box" | "other";

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
  version?: number;
}

export interface MedicinePayload {
  name: string;
  specification?: string | null;
  manufacturer?: string | null;
  approvalNumber?: string | null;
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
  version?: number;
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

export interface MarkdownExportResponse {
  markdown: string;
  generatedAt: string;
}
