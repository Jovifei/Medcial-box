// medicines 表仓储：所有查询按 family_id 过滤，跨家庭访问自然得到空结果（404）。
import type {
  LowStockThresholdInput,
  LeafletReviewStatus,
  MedicationSummary,
} from "@home-medicine/contracts";
import type { QueryRunner } from "../types.js";
import { parseJsonArray } from "../types.js";
import { mostSevereState, summarizeExpiryState } from "../domain/expiry.js";
import { calculateStockStatus } from "../domain/medicine-inventory.js";
import type { ValidatedMedicineFields } from "../inputs.js";
import type { MedicationBatchSummary } from "@home-medicine/contracts";

export interface MedicineRow {
  id: string;
  name: string;
  specification: string | null;
  manufacturer: string | null;
  approval_number: string | null;
  barcode_value: string | null;
  active_ingredients: unknown;
  purpose_category: string | null;
  leaflet_purpose_summary: string | null;
  leaflet_package_usage_summary: string | null;
  leaflet_contraindications_summary: string | null;
  leaflet_precautions_summary: string | null;
  leaflet_source: string | null;
  leaflet_review_status: string;
  is_archived: boolean;
  low_stock_threshold_quantity: number | null;
  low_stock_threshold_unit: string | null;
  deleted_at: Date | string | null;
  version: number;
}

const MEDICINE_COLUMNS =
  "id, name, specification, manufacturer, approval_number, barcode_value, active_ingredients, purpose_category, leaflet_purpose_summary, leaflet_package_usage_summary, leaflet_contraindications_summary, leaflet_precautions_summary, leaflet_source, leaflet_review_status, is_archived, low_stock_threshold_quantity, low_stock_threshold_unit, deleted_at, version";

export function toMedicineSummary(
  row: MedicineRow,
  batches: MedicationBatchSummary[],
  now: Date = new Date(),
): MedicationSummary {
  const state =
    batches.length > 0
      ? mostSevereState(batches.map((batch) => batch.managementExpiryState?.state ?? batch.expiryState.state))
      : "unknown";
  const threshold: LowStockThresholdInput | null =
    row.low_stock_threshold_quantity == null || row.low_stock_threshold_unit == null
      ? null
      : {
          quantity: row.low_stock_threshold_quantity,
          unit: row.low_stock_threshold_unit as LowStockThresholdInput["unit"],
        };
  return {
    id: row.id,
    name: row.name,
    specification: row.specification ?? null,
    manufacturer: row.manufacturer ?? null,
    approvalNumber: row.approval_number ?? null,
    barcodeValue: row.barcode_value ?? null,
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
    lowStockThreshold: threshold,
    stockStatus: calculateStockStatus(batches, threshold, now),
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
    `SELECT ${MEDICINE_COLUMNS} FROM medicines WHERE family_id = $1 AND deleted_at IS NULL${archivedFilter} ORDER BY created_at, id`,
    [familyId],
  );
  return result.rows;
}

export async function findMedicineInFamily(
  database: QueryRunner,
  medicineId: string,
  familyId: string,
  includeDeleted = false,
): Promise<MedicineRow | null> {
  const result = await database.query<MedicineRow>(
    `SELECT ${MEDICINE_COLUMNS} FROM medicines WHERE id = $1 AND family_id = $2${includeDeleted ? "" : " AND deleted_at IS NULL"}`,
    [medicineId, familyId],
  );
  return result.rows[0] ?? null;
}

/** All aggregate writes acquire the parent row before touching any batch. */
export async function lockMedicineInFamily(
  transaction: QueryRunner,
  medicineId: string,
  familyId: string,
): Promise<MedicineRow | null> {
  const result = await transaction.query<MedicineRow>(
    `SELECT ${MEDICINE_COLUMNS} FROM medicines WHERE id = $1 AND family_id = $2 AND deleted_at IS NULL FOR UPDATE`,
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
    `INSERT INTO medicines (family_id, name, specification, manufacturer, approval_number, barcode_value, active_ingredients, purpose_category, leaflet_purpose_summary, leaflet_package_usage_summary, leaflet_contraindications_summary, leaflet_precautions_summary, leaflet_source, leaflet_review_status, low_stock_threshold_quantity, low_stock_threshold_unit, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING ${MEDICINE_COLUMNS}`,
    [
      familyId,
      fields.name,
      fields.specification,
      fields.manufacturer,
      fields.approvalNumber,
      fields.barcodeValue,
      JSON.stringify(fields.activeIngredients),
      fields.purposeCategory,
      fields.leafletPurposeSummary,
      fields.leafletPackageUsageSummary,
      fields.leafletContraindicationsSummary,
      fields.leafletPrecautionsSummary,
      fields.leafletSource,
      fields.leafletReviewStatus,
      fields.lowStockThreshold?.quantity ?? null,
      fields.lowStockThreshold?.unit ?? null,
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
       barcode_value = $7, active_ingredients = $8, purpose_category = $9,
       leaflet_purpose_summary = $10, leaflet_package_usage_summary = $11,
       leaflet_contraindications_summary = $12, leaflet_precautions_summary = $13,
       leaflet_source = $14, leaflet_review_status = $15,
       low_stock_threshold_quantity = CASE WHEN $16 THEN $17 ELSE low_stock_threshold_quantity END,
       low_stock_threshold_unit = CASE WHEN $16 THEN $18 ELSE low_stock_threshold_unit END,
       updated_by = $19, version = version + 1, updated_at = now()
     WHERE id = $1 AND family_id = $2 AND deleted_at IS NULL AND version = $20
     RETURNING ${MEDICINE_COLUMNS}`,
    [
      medicineId,
      familyId,
      fields.name,
      fields.specification,
      fields.manufacturer,
      fields.approvalNumber,
      fields.barcodeValue,
      JSON.stringify(fields.activeIngredients),
      fields.purposeCategory,
      fields.leafletPurposeSummary,
      fields.leafletPackageUsageSummary,
      fields.leafletContraindicationsSummary,
      fields.leafletPrecautionsSummary,
      fields.leafletSource,
      fields.leafletReviewStatus,
      fields.lowStockThresholdProvided,
      fields.lowStockThreshold?.quantity ?? null,
      fields.lowStockThreshold?.unit ?? null,
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
    "UPDATE medicines SET is_archived = TRUE, updated_by = $3, version = version + 1, updated_at = now() WHERE id = $1 AND family_id = $2 AND deleted_at IS NULL AND is_archived = FALSE RETURNING id",
    [medicineId, familyId, userId],
  );
  return result.rowCount !== 0;
}

/**
 * 批次独立操作后递增药品聚合版本（审核修复 #3）：药品整体保存以药品版本为
 * 聚合锁——任何批次的增/改/删都必须让旧页面的整体保存撞上 409，
 * 杜绝"他人新增的批次被当作我删除的批次"静默丢失。
 */
export async function bumpMedicineVersion(
  database: QueryRunner,
  medicineId: string,
  familyId: string,
  userId: string,
): Promise<boolean> {
  const result = await database.query<{ id: string }>(
    "UPDATE medicines SET version = version + 1, updated_by = $3, updated_at = now() WHERE id = $1 AND family_id = $2 RETURNING id",
    [medicineId, familyId, userId],
  );
  return result.rowCount !== 0;
}
