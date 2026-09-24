// medicines 表仓储：所有查询按 family_id 过滤，跨家庭访问自然得到空结果（404）。
import type {
  LeafletReviewStatus,
  MedicationSummary,
} from "@home-medicine/contracts";
import type { QueryRunner } from "../types.js";
import { parseJsonArray } from "../types.js";
import { mostSevereState, summarizeExpiryState } from "../domain/expiry.js";
import type { ValidatedMedicineFields } from "../inputs.js";
import type { MedicationBatchSummary } from "@home-medicine/contracts";

export interface MedicineRow {
  id: string;
  name: string;
  specification: string | null;
  manufacturer: string | null;
  approval_number: string | null;
  active_ingredients: unknown;
  purpose_category: string | null;
  leaflet_purpose_summary: string | null;
  leaflet_package_usage_summary: string | null;
  leaflet_contraindications_summary: string | null;
  leaflet_precautions_summary: string | null;
  leaflet_source: string | null;
  leaflet_review_status: string;
  is_archived: boolean;
  version: number;
}

const MEDICINE_COLUMNS =
  "id, name, specification, manufacturer, approval_number, active_ingredients, purpose_category, leaflet_purpose_summary, leaflet_package_usage_summary, leaflet_contraindications_summary, leaflet_precautions_summary, leaflet_source, leaflet_review_status, is_archived, version";

export function toMedicineSummary(
  row: MedicineRow,
  batches: MedicationBatchSummary[],
): MedicationSummary {
  const state =
    batches.length > 0
      ? mostSevereState(batches.map((batch) => batch.expiryState.state))
      : "unknown";
  return {
    id: row.id,
    name: row.name,
    specification: row.specification ?? null,
    manufacturer: row.manufacturer ?? null,
    approvalNumber: row.approval_number ?? null,
    activeIngredients: parseJsonArray(row.active_ingredients),
    purposeCategory: row.purpose_category ?? null,
    leaflet: {
      purposeSummary: row.leaflet_purpose_summary ?? null,
      packageUsageSummary: row.leaflet_package_usage_summary ?? null,
      contraindicationsSummary: row.leaflet_contraindications_summary ?? null,
      precautionsSummary: row.leaflet_precautions_summary ?? null,
      source: row.leaflet_source ?? null,
      reviewStatus: row.leaflet_review_status as LeafletReviewStatus,
    },
    batches,
    expiryState: { state, label: summarizeExpiryState(state) },
    isArchived: row.is_archived,
    version: row.version,
  };
}

export async function listMedicines(
  database: QueryRunner,
  familyId: string,
  includeArchived: boolean,
): Promise<MedicineRow[]> {
  const archivedFilter = includeArchived ? "" : " AND is_archived = FALSE";
  const result = await database.query<MedicineRow>(
    `SELECT ${MEDICINE_COLUMNS} FROM medicines WHERE family_id = $1${archivedFilter} ORDER BY created_at, id`,
    [familyId],
  );
  return result.rows;
}

export async function findMedicineInFamily(
  database: QueryRunner,
  medicineId: string,
  familyId: string,
): Promise<MedicineRow | null> {
  const result = await database.query<MedicineRow>(
    `SELECT ${MEDICINE_COLUMNS} FROM medicines WHERE id = $1 AND family_id = $2`,
    [medicineId, familyId],
  );
  return result.rows[0] ?? null;
}

export async function insertMedicine(
  database: QueryRunner,
  familyId: string,
  fields: ValidatedMedicineFields,
  userId: string,
): Promise<MedicineRow> {
  const result = await database.query<MedicineRow>(
    `INSERT INTO medicines (family_id, name, specification, manufacturer, approval_number, active_ingredients, purpose_category, leaflet_purpose_summary, leaflet_package_usage_summary, leaflet_contraindications_summary, leaflet_precautions_summary, leaflet_source, leaflet_review_status, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING ${MEDICINE_COLUMNS}`,
    [
      familyId,
      fields.name,
      fields.specification,
      fields.manufacturer,
      fields.approvalNumber,
      JSON.stringify(fields.activeIngredients),
      fields.purposeCategory,
      fields.leafletPurposeSummary,
      fields.leafletPackageUsageSummary,
      fields.leafletContraindicationsSummary,
      fields.leafletPrecautionsSummary,
      fields.leafletSource,
      fields.leafletReviewStatus,
      userId,
      userId,
    ],
  );
  return result.rows[0];
}

/**
 * Version-guarded update. rowCount = 0 means version conflict (existence is
 * confirmed by the caller beforehand) → the route maps it to 409.
 */
export async function updateMedicine(
  database: QueryRunner,
  medicineId: string,
  familyId: string,
  fields: ValidatedMedicineFields,
  userId: string,
  expectedVersion: number,
): Promise<MedicineRow | null> {
  const result = await database.query<MedicineRow>(
    `UPDATE medicines SET
       name = $3, specification = $4, manufacturer = $5, approval_number = $6,
       active_ingredients = $7, purpose_category = $8,
       leaflet_purpose_summary = $9, leaflet_package_usage_summary = $10,
       leaflet_contraindications_summary = $11, leaflet_precautions_summary = $12,
       leaflet_source = $13, leaflet_review_status = $14,
       updated_by = $15, version = version + 1, updated_at = now()
     WHERE id = $1 AND family_id = $2 AND version = $16
     RETURNING ${MEDICINE_COLUMNS}`,
    [
      medicineId,
      familyId,
      fields.name,
      fields.specification,
      fields.manufacturer,
      fields.approvalNumber,
      JSON.stringify(fields.activeIngredients),
      fields.purposeCategory,
      fields.leafletPurposeSummary,
      fields.leafletPackageUsageSummary,
      fields.leafletContraindicationsSummary,
      fields.leafletPrecautionsSummary,
      fields.leafletSource,
      fields.leafletReviewStatus,
      userId,
      expectedVersion,
    ],
  );
  return result.rows[0] ?? null;
}

/** Archive (soft delete). Returns false when the row is missing or archived. */
export async function archiveMedicine(
  database: QueryRunner,
  medicineId: string,
  familyId: string,
  userId: string,
): Promise<boolean> {
  const result = await database.query<{ id: string }>(
    "UPDATE medicines SET is_archived = TRUE, updated_by = $3, version = version + 1, updated_at = now() WHERE id = $1 AND family_id = $2 AND is_archived = FALSE RETURNING id",
    [medicineId, familyId, userId],
  );
  return result.rowCount !== 0;
}
