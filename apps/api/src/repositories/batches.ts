// medicine_batches 表仓储：批次冗余 family_id，端点用单查询完成归属校验。
import type { AfterOpeningLimitInput, DispositionStatus, ExpiryPrecision, OpenedState, QuantityUnit } from "@home-medicine/contracts";
import type { MedicationBatchSummary } from "@home-medicine/contracts";
import type { QueryRunner } from "../types.js";
import { describeExpiry } from "../domain/expiry.js";
import { calculateEffectiveExpiryDate, calculateOpenedExpiryDate, describeManagementExpiry } from "../domain/medicine-inventory.js";
import type { ValidatedBatchFields } from "../inputs.js";

export interface MedicineBatchRow {
  id: string;
  medicine_id: string;
  lot_number: string | null;
  expiry_value: string | null;
  expiry_precision: string;
  quantity: number | null;
  unit: string;
  confirmed_units_per_package: number | null;
  storage_location: string | null;
  opened_state: string;
  opened_at: string | Date | null;
  after_opening_limit: unknown;
  disposition_status: string;
  deleted_at: Date | string | null;
  version: number;
}

const BATCH_COLUMNS =
  "id, medicine_id, lot_number, expiry_value, expiry_precision, quantity, unit, confirmed_units_per_package, storage_location, opened_state, opened_at, after_opening_limit, disposition_status, deleted_at, version";

function openingLimit(value: unknown): AfterOpeningLimitInput | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      return openingLimit(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.date === "string") {
    return { date: record.date, source: typeof record.source === "string" ? record.source : null };
  }
  if (
    Number.isSafeInteger(record.value) &&
    (record.unit === "day" || record.unit === "month")
  ) {
    return {
      value: record.value as number,
      unit: record.unit,
      source: typeof record.source === "string" ? record.source : null,
    };
  }
  return null;
}

function dateOnly(value: string | Date | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) {
    const year = String(value.getFullYear()).padStart(4, "0");
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return value.slice(0, 10);
}

/** Row → API summary; derives expiryState at read time with the current clock. */
export function toBatchSummary(
  row: MedicineBatchRow,
  now: Date = new Date(),
): MedicationBatchSummary {
  const expiry = {
    value: row.expiry_value ?? null,
    precision: row.expiry_precision as ExpiryPrecision,
  };
  const openedAt = dateOnly(row.opened_at ?? null);
  const limit = openingLimit(row.after_opening_limit);
  const openedExpiryDate = calculateOpenedExpiryDate(openedAt, limit);
  const managementExpiry = calculateEffectiveExpiryDate(expiry, openedExpiryDate);
  return {
    id: row.id,
    lotNumber: row.lot_number ?? null,
    expiry,
    expiryState: describeExpiry(expiry, now),
    quantity: row.quantity ?? null,
    unit: row.unit as QuantityUnit,
    confirmedUnitsPerPackage: row.confirmed_units_per_package ?? null,
    storageLocation: row.storage_location ?? null,
    openedState: row.opened_state as OpenedState,
    openedAt,
    afterOpeningLimit: limit,
    openedExpiryDate,
    managementExpiryDate: managementExpiry.date,
    managementExpirySource: managementExpiry.source,
    managementExpiryState: describeManagementExpiry(managementExpiry.date, now),
    dispositionStatus: row.disposition_status === "handled" ? "handled" : "active",
    version: row.version,
  };
}

export async function listBatchesByMedicine(
  database: QueryRunner,
  medicineId: string,
  familyId: string,
): Promise<MedicineBatchRow[]> {
  const result = await database.query<MedicineBatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM medicine_batches WHERE medicine_id = $1 AND family_id = $2 AND deleted_at IS NULL ORDER BY created_at, id`,
    [medicineId, familyId],
  );
  return result.rows;
}

export async function listBatchesByFamily(
  database: QueryRunner,
  familyId: string,
): Promise<MedicineBatchRow[]> {
  const result = await database.query<MedicineBatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM medicine_batches WHERE family_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`,
    [familyId],
  );
  return result.rows;
}

export async function findBatchInMedicine(
  database: QueryRunner,
  batchId: string,
  medicineId: string,
  familyId: string,
): Promise<MedicineBatchRow | null> {
  const result = await database.query<MedicineBatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM medicine_batches WHERE id = $1 AND medicine_id = $2 AND family_id = $3 AND deleted_at IS NULL`,
    [batchId, medicineId, familyId],
  );
  return result.rows[0] ?? null;
}

export async function lockBatchInMedicine(
  transaction: QueryRunner,
  batchId: string,
  medicineId: string,
  familyId: string,
): Promise<MedicineBatchRow | null> {
  const result = await transaction.query<MedicineBatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM medicine_batches
     WHERE id = $1 AND medicine_id = $2 AND family_id = $3 AND deleted_at IS NULL
     FOR UPDATE`,
    [batchId, medicineId, familyId],
  );
  return result.rows[0] ?? null;
}

export async function decrementUnopenedBatchForSplit(
  transaction: QueryRunner,
  batchId: string,
  medicineId: string,
  familyId: string,
  openedQuantity: number,
  expectedVersion: number,
  userId: string,
): Promise<MedicineBatchRow | null> {
  const result = await transaction.query<MedicineBatchRow>(
    `UPDATE medicine_batches SET quantity = quantity - $4, updated_by = $6,
       version = version + 1, updated_at = now()
     WHERE id = $1 AND medicine_id = $2 AND family_id = $3
       AND quantity IS NOT NULL AND quantity > $4
       AND opened_state = 'unopened' AND disposition_status = 'active'
       AND deleted_at IS NULL AND version = $5
     RETURNING ${BATCH_COLUMNS}`,
    [batchId, medicineId, familyId, openedQuantity, expectedVersion, userId],
  );
  return result.rows[0] ?? null;
}

export async function insertOpenedBatchSplit(
  transaction: QueryRunner,
  sourceBatchId: string,
  medicineId: string,
  familyId: string,
  expectedSourceVersion: number,
  openedQuantity: number,
  openedAt: string,
  afterOpeningLimit: AfterOpeningLimitInput | null,
  userId: string,
): Promise<MedicineBatchRow | null> {
  const result = await transaction.query<MedicineBatchRow>(
    `INSERT INTO medicine_batches (
       medicine_id, family_id, lot_number, expiry_value, expiry_precision,
       quantity, unit, confirmed_units_per_package, storage_location,
       opened_state, opened_at, after_opening_limit, created_by, updated_by
     )
     SELECT medicine_id, family_id, lot_number, expiry_value, expiry_precision,
       $5, unit, confirmed_units_per_package, storage_location,
       'opened', $6::date, $7::jsonb, $8, $8
     FROM medicine_batches
     WHERE id = $1 AND medicine_id = $2 AND family_id = $3
       AND version = $4 AND deleted_at IS NULL
     RETURNING ${BATCH_COLUMNS}`,
    [
      sourceBatchId,
      medicineId,
      familyId,
      expectedSourceVersion,
      openedQuantity,
      openedAt,
      afterOpeningLimit === null ? null : JSON.stringify(afterOpeningLimit),
      userId,
    ],
  );
  return result.rows[0] ?? null;
}

export async function insertBatch(
  database: QueryRunner,
  medicineId: string,
  familyId: string,
  fields: ValidatedBatchFields,
  userId: string,
  options: { dispositionStatus?: DispositionStatus } = {},
): Promise<MedicineBatchRow> {
  const result = await database.query<MedicineBatchRow>(
    `INSERT INTO medicine_batches (medicine_id, family_id, lot_number, expiry_value, expiry_precision, quantity, unit, confirmed_units_per_package, storage_location, opened_state, opened_at, after_opening_limit, disposition_status, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING ${BATCH_COLUMNS}`,
    [
      medicineId,
      familyId,
      fields.lotNumber,
      fields.expiryValue,
      fields.expiryPrecision,
      fields.quantity,
      fields.unit,
      fields.confirmedUnitsPerPackage,
      fields.storageLocation,
      fields.openedState,
      fields.openedAt,
      fields.afterOpeningLimit === null ? null : JSON.stringify(fields.afterOpeningLimit),
      options.dispositionStatus ?? "active",
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
export async function updateBatch(
  database: QueryRunner,
  batchId: string,
  medicineId: string,
  familyId: string,
  fields: ValidatedBatchFields,
  userId: string,
  expectedVersion: number,
): Promise<MedicineBatchRow | null> {
  const result = await database.query<MedicineBatchRow>(
    `UPDATE medicine_batches SET
       lot_number = $4, expiry_value = $5, expiry_precision = $6, quantity = $7,
       unit = $8, confirmed_units_per_package = $9, storage_location = $10,
       opened_state = CASE WHEN $11 THEN $12 ELSE opened_state END,
       opened_at = CASE WHEN $11 THEN $13::date ELSE opened_at END,
       after_opening_limit = CASE WHEN $11 THEN $14::jsonb ELSE after_opening_limit END,
       updated_by = $15, version = version + 1, updated_at = now()
     WHERE id = $1 AND medicine_id = $2 AND family_id = $3 AND deleted_at IS NULL AND version = $16
     RETURNING ${BATCH_COLUMNS}`,
    [
      batchId,
      medicineId,
      familyId,
      fields.lotNumber,
      fields.expiryValue,
      fields.expiryPrecision,
      fields.quantity,
      fields.unit,
      fields.confirmedUnitsPerPackage,
      fields.storageLocation,
      fields.openingFieldsProvided,
      fields.openedState,
      fields.openedAt,
      fields.afterOpeningLimit === null ? null : JSON.stringify(fields.afterOpeningLimit),
      userId,
      expectedVersion,
    ],
  );
  return result.rows[0] ?? null;
}

/** Batches are physically deleted (mistyped entries, no references). */
export async function deleteBatch(
  database: QueryRunner,
  batchId: string,
  medicineId: string,
  familyId: string,
  userId: string,
): Promise<boolean> {
  const result = await database.query<{ id: string }>(
    "UPDATE medicine_batches SET deleted_at = now(), deleted_by = $4, updated_by = $4, version = version + 1, updated_at = now() WHERE id = $1 AND medicine_id = $2 AND family_id = $3 AND deleted_at IS NULL RETURNING id",
    [batchId, medicineId, familyId, userId],
  );
  return result.rowCount !== 0;
}
