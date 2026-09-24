// medicine_batches 表仓储：批次冗余 family_id，端点用单查询完成归属校验。
import type { ExpiryPrecision, QuantityUnit } from "@home-medicine/contracts";
import type { MedicationBatchSummary } from "@home-medicine/contracts";
import type { Database } from "../types.js";
import { describeExpiry } from "../domain/expiry.js";
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
  version: number;
}

const BATCH_COLUMNS =
  "id, medicine_id, lot_number, expiry_value, expiry_precision, quantity, unit, confirmed_units_per_package, storage_location, version";

/** Row → API summary; derives expiryState at read time with the current clock. */
export function toBatchSummary(
  row: MedicineBatchRow,
  now: Date = new Date(),
): MedicationBatchSummary {
  const expiry = {
    value: row.expiry_value ?? null,
    precision: row.expiry_precision as ExpiryPrecision,
  };
  return {
    id: row.id,
    lotNumber: row.lot_number ?? null,
    expiry,
    expiryState: describeExpiry(expiry, now),
    quantity: row.quantity ?? null,
    unit: row.unit as QuantityUnit,
    confirmedUnitsPerPackage: row.confirmed_units_per_package ?? null,
    storageLocation: row.storage_location ?? null,
    version: row.version,
  };
}

export async function listBatchesByMedicine(
  database: Database,
  medicineId: string,
  familyId: string,
): Promise<MedicineBatchRow[]> {
  const result = await database.query<MedicineBatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM medicine_batches WHERE medicine_id = $1 AND family_id = $2 ORDER BY created_at, id`,
    [medicineId, familyId],
  );
  return result.rows;
}

export async function listBatchesByFamily(
  database: Database,
  familyId: string,
): Promise<MedicineBatchRow[]> {
  const result = await database.query<MedicineBatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM medicine_batches WHERE family_id = $1 ORDER BY created_at, id`,
    [familyId],
  );
  return result.rows;
}

export async function findBatchInMedicine(
  database: Database,
  batchId: string,
  medicineId: string,
  familyId: string,
): Promise<MedicineBatchRow | null> {
  const result = await database.query<MedicineBatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM medicine_batches WHERE id = $1 AND medicine_id = $2 AND family_id = $3`,
    [batchId, medicineId, familyId],
  );
  return result.rows[0] ?? null;
}

export async function insertBatch(
  database: Database,
  medicineId: string,
  familyId: string,
  fields: ValidatedBatchFields,
  userId: string,
): Promise<MedicineBatchRow> {
  const result = await database.query<MedicineBatchRow>(
    `INSERT INTO medicine_batches (medicine_id, family_id, lot_number, expiry_value, expiry_precision, quantity, unit, confirmed_units_per_package, storage_location, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
  database: Database,
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
       updated_by = $11, version = version + 1, updated_at = now()
     WHERE id = $1 AND medicine_id = $2 AND family_id = $3 AND version = $12
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
      userId,
      expectedVersion,
    ],
  );
  return result.rows[0] ?? null;
}

/** Batches are physically deleted (mistyped entries, no references). */
export async function deleteBatch(
  database: Database,
  batchId: string,
  medicineId: string,
  familyId: string,
): Promise<boolean> {
  const result = await database.query<{ id: string }>(
    "DELETE FROM medicine_batches WHERE id = $1 AND medicine_id = $2 AND family_id = $3 RETURNING id",
    [batchId, medicineId, familyId],
  );
  return result.rowCount !== 0;
}
