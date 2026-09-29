import type { FastifyInstance } from "fastify";
import type {
  FamilyInventorySettings,
  QuantityUnit,
  RestockStatus,
  StocktakeInterval,
  StocktakeItemResult,
} from "@home-medicine/contracts";
import { requireFamily } from "../auth/session.js";
import { lockMedicineInFamily, findMedicineInFamily, bumpMedicineVersion } from "../repositories/medicines.js";
import { toBatchSummary } from "../repositories/batches.js";
import type { Database, QueryRunner } from "../types.js";
import { errorBody, toIso, TransactionConflictError } from "../types.js";
import {
  validateFamilyInventorySettingsInput,
  validateRestockInput,
  validateRestockUpdateInput,
  validateStocktakeItemsInput,
} from "../inputs.js";

const NOT_FOUND = errorBody("NOT_FOUND", "记录不存在或不在当前家庭中");
const CONFLICT = errorBody("VERSION_CONFLICT", "记录已被他人修改，请刷新后重试");

interface SettingsRow {
  stocktake_interval: StocktakeInterval;
  last_stocktake_at: Date | string | null;
}

function nextStocktakeAt(interval: StocktakeInterval, last: string | null): string | null {
  if (last === null || interval === "disabled") return null;
  const date = new Date(last);
  if (!Number.isFinite(date.getTime())) return null;
  if (interval === "weekly") {
    date.setUTCDate(date.getUTCDate() + 7);
  } else {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + 1);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  }
  return date.toISOString();
}

function settingsSummary(row?: SettingsRow): FamilyInventorySettings {
  const stocktakeInterval = row?.stocktake_interval ?? "monthly";
  const lastStocktakeAt = row?.last_stocktake_at === null || row?.last_stocktake_at === undefined
    ? null
    : toIso(row.last_stocktake_at);
  return {
    stocktakeInterval,
    lastStocktakeAt,
    nextStocktakeAt: nextStocktakeAt(stocktakeInterval, lastStocktakeAt),
  };
}

interface StocktakeSessionRow {
  id: string;
  status: "open" | "completed";
  started_at: Date | string;
  completed_at?: Date | string | null;
}

interface StocktakeItemRow {
  batch_id: string;
  medicine_id: string;
  medicine_name: string;
  quantity: number | null;
  unit: QuantityUnit;
  expiry_value: string | null;
  expiry_precision: string;
  opened_state: string;
  opened_at: Date | string | null;
  after_opening_limit: unknown;
  expected_version: number;
  result: "pending" | "saved" | "conflict" | "not_found";
}

async function loadStocktakeItems(
  database: QueryRunner,
  familyId: string,
  sessionId: string,
): Promise<StocktakeItemRow[]> {
  const result = await database.query<StocktakeItemRow>(
    `SELECT si.batch_id, si.medicine_id, m.name AS medicine_name, si.expected_quantity AS quantity,
            b.unit, b.expiry_value, b.expiry_precision, b.opened_state, b.opened_at, b.after_opening_limit,
            si.expected_version, si.result
     FROM stocktake_items si
     LEFT JOIN medicines m ON m.id = si.medicine_id AND m.family_id = si.family_id
     LEFT JOIN medicine_batches b ON b.id = si.batch_id AND b.family_id = si.family_id
     WHERE si.session_id = $1 AND si.family_id = $2
     ORDER BY m.created_at, si.batch_id`,
    [sessionId, familyId],
  );
  return result.rows;
}

function stocktakeItemSummary(row: StocktakeItemRow) {
  const openedAt = row.opened_at === null
    ? null
    : row.opened_at instanceof Date
      ? `${String(row.opened_at.getFullYear()).padStart(4, "0")}-${String(row.opened_at.getMonth() + 1).padStart(2, "0")}-${String(row.opened_at.getDate()).padStart(2, "0")}`
      : row.opened_at.slice(0, 10);
  const batch = toBatchSummary({
    id: row.batch_id,
    medicine_id: row.medicine_id,
    lot_number: null,
    expiry_value: row.expiry_value,
    expiry_precision: row.expiry_precision,
    quantity: row.quantity,
    unit: row.unit,
    confirmed_units_per_package: null,
    storage_location: null,
    opened_state: row.opened_state,
    opened_at: row.opened_at,
    after_opening_limit: row.after_opening_limit,
    disposition_status: "active",
    deleted_at: null,
    version: row.expected_version,
  });
  return {
    batchId: row.batch_id,
    medicineId: row.medicine_id,
    medicineName: row.medicine_name,
    quantity: row.quantity,
    unit: row.unit,
    expiry: { value: row.expiry_value, precision: row.expiry_precision },
    openedState: row.opened_state,
    openedAt,
    managementExpiryDate: batch.managementExpiryDate,
    version: row.expected_version,
    result: row.result,
  };
}

interface RestockRow {
  id: string;
  medicine_id: string;
  medicine_name: string;
  desired_quantity: number | null;
  unit: QuantityUnit;
  status: RestockStatus;
  created_at: Date | string;
  version: number;
}

const RESTOCK_SELECT = `SELECT r.id, r.medicine_id, m.name AS medicine_name, r.desired_quantity,
  r.unit, r.status, r.created_at, r.version
  FROM restock_items r JOIN medicines m ON m.id = r.medicine_id AND m.family_id = r.family_id`;

function restockSummary(row: RestockRow) {
  return {
    id: row.id,
    medicineId: row.medicine_id,
    medicineName: row.medicine_name,
    desiredQuantity: row.desired_quantity,
    unit: row.unit,
    status: row.status,
    createdAt: toIso(row.created_at),
    version: row.version,
  };
}

async function writeAudit(
  tx: QueryRunner,
  familyId: string,
  userId: string,
  entityType: string,
  entityId: string,
  action: string,
  changes: unknown,
): Promise<void> {
  await tx.query(
    "INSERT INTO audit_events (family_id, actor_id, entity_type, entity_id, action, changes) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
    [familyId, userId, entityType, entityId, action, JSON.stringify(changes ?? {})],
  );
}

export async function registerInventoryRoutes(app: FastifyInstance, database: Database): Promise<void> {
  app.get("/api/v1/families/settings", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const result = await database.query<SettingsRow>(
      "SELECT stocktake_interval, last_stocktake_at FROM family_inventory_settings WHERE family_id = $1",
      [ctx.familyId],
    );
    return { settings: settingsSummary(result.rows[0]) };
  });

  app.put("/api/v1/families/settings", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const parsed = validateFamilyInventorySettingsInput(request.body);
    if (!parsed.ok) return reply.code(400).send(errorBody("VALIDATION_ERROR", parsed.message));
    const result = await database.withTransaction(async (tx) => {
      const saved = await tx.query<SettingsRow>(
        `INSERT INTO family_inventory_settings (family_id, stocktake_interval, updated_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (family_id) DO UPDATE SET stocktake_interval = EXCLUDED.stocktake_interval,
           updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING stocktake_interval, last_stocktake_at`,
        [ctx.familyId, parsed.value.stocktakeInterval, ctx.userId],
      );
      await writeAudit(tx, ctx.familyId, ctx.userId, "family_settings", ctx.familyId, "updated", parsed.value);
      return saved.rows[0];
    });
    return { settings: settingsSummary(result) };
  });

  app.get("/api/v1/families/stocktakes/current", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const current = await database.query<StocktakeSessionRow>(
      `SELECT id, status, started_at, completed_at FROM stocktake_sessions
       WHERE family_id = $1 AND status = 'open'
       ORDER BY started_at DESC, id DESC LIMIT 1`,
      [ctx.familyId],
    );
    const session = current.rows[0];
    if (session === undefined) return { stocktake: null };
    const items = await loadStocktakeItems(database, ctx.familyId, session.id);
    return {
      stocktake: {
        id: session.id,
        status: session.status,
        startedAt: toIso(session.started_at),
        items: items.map(stocktakeItemSummary),
      },
    };
  });

  app.post("/api/v1/families/stocktakes", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const session = await database.withTransaction(async (tx) => {
      const created = await tx.query<StocktakeSessionRow>(
        "INSERT INTO stocktake_sessions (family_id, started_by) VALUES ($1, $2) RETURNING id, status, started_at",
        [ctx.familyId, ctx.userId],
      );
      const row = created.rows[0];
      await tx.query(
        `INSERT INTO stocktake_items (session_id, family_id, batch_id, medicine_id, expected_version, expected_quantity)
         SELECT $1, b.family_id, b.id, m.id, b.version, b.quantity
         FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id AND m.family_id = b.family_id
         WHERE b.family_id = $2 AND b.deleted_at IS NULL AND b.disposition_status = 'active'
           AND m.deleted_at IS NULL AND m.is_archived = FALSE`,
        [row.id, ctx.familyId],
      );
      await writeAudit(tx, ctx.familyId, ctx.userId, "stocktake", row.id, "started", {});
      return row;
    });
    const items = await loadStocktakeItems(database, ctx.familyId, session.id);
    return reply.code(201).send({
      stocktake: {
        id: session.id,
        status: session.status,
        startedAt: toIso(session.started_at),
        items: items.map(stocktakeItemSummary),
      },
    });
  });

  app.post<{ Params: { id: string } }>("/api/v1/families/stocktakes/:id/items", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const parsed = validateStocktakeItemsInput(request.body);
    if (!parsed.ok) return reply.code(400).send(errorBody("VALIDATION_ERROR", parsed.message));
    try {
      const results = await database.withTransaction(async (tx) => {
        const sessions = await tx.query<StocktakeSessionRow>(
          "SELECT id, status, started_at FROM stocktake_sessions WHERE id = $1 AND family_id = $2 FOR UPDATE",
          [request.params.id, ctx.familyId],
        );
        const session = sessions.rows[0];
        if (session === undefined) throw new TransactionConflictError(404, NOT_FOUND);
        if (session.status !== "open") {
          throw new TransactionConflictError(409, errorBody("VERSION_CONFLICT", "盘点已完成，不能继续修改"));
        }
        const outcomes: StocktakeItemResult[] = [];
        for (const item of parsed.value.items) {
          const snapshot = await tx.query<{ medicine_id: string }>(
            "SELECT medicine_id FROM stocktake_items WHERE session_id = $1 AND family_id = $2 AND batch_id = $3",
            [session.id, ctx.familyId, item.batchId],
          );
          const medicineId = snapshot.rows[0]?.medicine_id;
          if (medicineId === undefined) {
            outcomes.push({ batchId: item.batchId, outcome: "not_found" });
            continue;
          }
          const medicine = await lockMedicineInFamily(tx, medicineId, ctx.familyId);
          if (medicine === null) {
            await tx.query(
              "UPDATE stocktake_items SET outcome = $3, result = 'not_found', updated_by = $4, updated_at = now() WHERE session_id = $1 AND batch_id = $2",
              [session.id, item.batchId, item.outcome, ctx.userId],
            );
            outcomes.push({ batchId: item.batchId, outcome: "not_found" });
            continue;
          }
          const current = await tx.query<{ id: string; version: number; quantity: number | null }>(
            `SELECT b.id, b.version, b.quantity FROM medicine_batches b
             JOIN medicines m ON m.id = b.medicine_id AND m.family_id = b.family_id
             WHERE b.id = $1 AND b.medicine_id = $2 AND b.family_id = $3 AND b.deleted_at IS NULL
               AND m.deleted_at IS NULL AND m.is_archived = FALSE
             FOR UPDATE OF b`,
            [item.batchId, medicineId, ctx.familyId],
          );
          const batch = current.rows[0];
          if (batch === undefined) {
            await tx.query(
              "UPDATE stocktake_items SET outcome = $3, result = 'not_found', updated_by = $4, updated_at = now() WHERE session_id = $1 AND batch_id = $2",
              [session.id, item.batchId, item.outcome, ctx.userId],
            );
            outcomes.push({ batchId: item.batchId, outcome: "not_found" });
            continue;
          }
          if (batch.version !== item.version) {
            await tx.query(
              "UPDATE stocktake_items SET outcome = $3, result = 'conflict', observed_quantity = $4, updated_by = $5, updated_at = now() WHERE session_id = $1 AND batch_id = $2",
              [session.id, item.batchId, item.outcome, batch.quantity, ctx.userId],
            );
            outcomes.push({ batchId: item.batchId, outcome: "conflict", currentVersion: batch.version });
            continue;
          }
          let updatedVersion = batch.version;
          if (item.outcome === "adjusted" || item.outcome === "empty" || item.outcome === "handled") {
            const changed = await tx.query<{ version: number }>(
              `UPDATE medicine_batches SET
                 quantity = CASE WHEN $4 = 'adjusted' THEN $5 WHEN $4 = 'empty' THEN 0 ELSE quantity END,
                 disposition_status = CASE WHEN $4 = 'handled' THEN 'handled' ELSE disposition_status END,
                 updated_by = $6, version = version + 1, updated_at = now()
               WHERE id = $1 AND family_id = $2 AND version = $3 AND deleted_at IS NULL
               RETURNING version`,
              [item.batchId, ctx.familyId, item.version, item.outcome, item.quantity ?? null, ctx.userId],
            );
            if (changed.rowCount === 0) {
              const reread = await tx.query<{ version: number }>(
                "SELECT version FROM medicine_batches WHERE id = $1 AND family_id = $2 AND deleted_at IS NULL",
                [item.batchId, ctx.familyId],
              );
              outcomes.push({ batchId: item.batchId, outcome: "conflict", currentVersion: reread.rows[0]?.version });
              continue;
            }
            updatedVersion = changed.rows[0].version;
            await bumpMedicineVersion(tx, medicineId, ctx.familyId, ctx.userId);
          }
          await tx.query(
            `UPDATE stocktake_items SET outcome = $3, result = 'saved', observed_quantity = $4,
             expected_version = $5, updated_by = $6, updated_at = now()
             WHERE session_id = $1 AND batch_id = $2`,
            [session.id, item.batchId, item.outcome, item.outcome === "adjusted" ? item.quantity : item.outcome === "empty" ? 0 : batch.quantity, updatedVersion, ctx.userId],
          );
          outcomes.push({ batchId: item.batchId, outcome: "saved", currentVersion: updatedVersion });
        }
        await writeAudit(tx, ctx.familyId, ctx.userId, "stocktake", session.id, "items_recorded", { results: outcomes });
        return outcomes;
      });
      return { results };
    } catch (error) {
      if (error instanceof TransactionConflictError) return reply.code(error.statusCode).send(error.body);
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/families/stocktakes/:id/complete", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    try {
      const completed = await database.withTransaction(async (tx) => {
        const sessions = await tx.query<StocktakeSessionRow>(
          "SELECT id, status, started_at FROM stocktake_sessions WHERE id = $1 AND family_id = $2 FOR UPDATE",
          [request.params.id, ctx.familyId],
        );
        const session = sessions.rows[0];
        if (session === undefined) throw new TransactionConflictError(404, NOT_FOUND);
        if (session.status !== "open") throw new TransactionConflictError(409, errorBody("VERSION_CONFLICT", "盘点已完成"));
        const updated = await tx.query<{ completed_at: Date | string }>(
          "UPDATE stocktake_sessions SET status = 'completed', completed_at = now() WHERE id = $1 AND family_id = $2 AND status = 'open' RETURNING completed_at",
          [session.id, ctx.familyId],
        );
        const settings = await tx.query<SettingsRow>(
          `INSERT INTO family_inventory_settings (family_id, stocktake_interval, last_stocktake_at, updated_by)
           VALUES ($1, 'monthly', $2, $3)
           ON CONFLICT (family_id) DO UPDATE SET last_stocktake_at = EXCLUDED.last_stocktake_at,
             updated_by = EXCLUDED.updated_by, updated_at = now()
           RETURNING stocktake_interval, last_stocktake_at`,
          [ctx.familyId, updated.rows[0].completed_at, ctx.userId],
        );
        await writeAudit(tx, ctx.familyId, ctx.userId, "stocktake", session.id, "completed", {});
        return { completedAt: toIso(updated.rows[0].completed_at), settings: settingsSummary(settings.rows[0]) };
      });
      return { completed: true, completedAt: completed.completedAt, nextStocktakeAt: completed.settings.nextStocktakeAt };
    } catch (error) {
      if (error instanceof TransactionConflictError) return reply.code(error.statusCode).send(error.body);
      throw error;
    }
  });

  app.get("/api/v1/families/restock", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const result = await database.query<RestockRow>(
      `${RESTOCK_SELECT} WHERE r.family_id = $1 AND m.deleted_at IS NULL AND m.is_archived = FALSE ORDER BY r.created_at DESC, r.id`,
      [ctx.familyId],
    );
    return { items: result.rows.map(restockSummary) };
  });

  app.post("/api/v1/families/restock", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const parsed = validateRestockInput(request.body);
    if (!parsed.ok) return reply.code(400).send(errorBody("VALIDATION_ERROR", parsed.message));
    const medicine = await findMedicineInFamily(database, parsed.value.medicineId, ctx.familyId);
    if (medicine === null) return reply.code(404).send(NOT_FOUND);
    const row = await database.withTransaction(async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO restock_items (family_id, medicine_id, desired_quantity, unit, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
        [ctx.familyId, parsed.value.medicineId, parsed.value.desiredQuantity, parsed.value.unit, parsed.value.status, ctx.userId],
      );
      await writeAudit(tx, ctx.familyId, ctx.userId, "restock", inserted.rows[0].id, "created", parsed.value);
      const selected = await tx.query<RestockRow>(
        `${RESTOCK_SELECT} WHERE r.id = $1 AND r.family_id = $2`,
        [inserted.rows[0].id, ctx.familyId],
      );
      return selected.rows[0];
    });
    return reply.code(201).send(restockSummary(row));
  });

  app.put<{ Params: { itemId: string } }>("/api/v1/families/restock/:itemId", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const parsed = validateRestockUpdateInput(request.body);
    if (!parsed.ok) return reply.code(400).send(errorBody("VALIDATION_ERROR", parsed.message));
    try {
      const row = await database.withTransaction(async (tx) => {
        const updated = await tx.query<{ id: string }>(
          `UPDATE restock_items SET
             desired_quantity = CASE WHEN $3 THEN $4 ELSE desired_quantity END,
             unit = CASE WHEN $5 THEN $6 ELSE unit END,
             status = CASE WHEN $7 THEN $8 ELSE status END,
             updated_by = $9, updated_at = now(), version = version + 1
           WHERE id = $1 AND family_id = $2 AND version = $10 RETURNING id`,
          [request.params.itemId, ctx.familyId,
            parsed.value.desiredQuantity !== undefined, parsed.value.desiredQuantity ?? null,
            parsed.value.unit !== undefined, parsed.value.unit ?? null,
            parsed.value.status !== undefined, parsed.value.status ?? null,
            ctx.userId, parsed.value.version],
        );
        if (updated.rowCount === 0) {
          const existing = await tx.query<{ id: string }>("SELECT id FROM restock_items WHERE id = $1 AND family_id = $2", [request.params.itemId, ctx.familyId]);
          if (existing.rowCount === 0) throw new TransactionConflictError(404, NOT_FOUND);
          throw new TransactionConflictError(409, CONFLICT);
        }
        await writeAudit(tx, ctx.familyId, ctx.userId, "restock", request.params.itemId, "updated", parsed.value);
        const selected = await tx.query<RestockRow>(`${RESTOCK_SELECT} WHERE r.id = $1 AND r.family_id = $2`, [request.params.itemId, ctx.familyId]);
        return selected.rows[0];
      });
      return restockSummary(row);
    } catch (error) {
      if (error instanceof TransactionConflictError) return reply.code(error.statusCode).send(error.body);
      throw error;
    }
  });

  app.delete<{ Params: { itemId: string } }>("/api/v1/families/restock/:itemId", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const deleted = await database.withTransaction(async (tx) => {
      const existing = await tx.query<{ id: string }>("SELECT id FROM restock_items WHERE id = $1 AND family_id = $2 FOR UPDATE", [request.params.itemId, ctx.familyId]);
      if (existing.rowCount === 0) return false;
      await writeAudit(tx, ctx.familyId, ctx.userId, "restock", request.params.itemId, "deleted", {});
      await tx.query("DELETE FROM restock_items WHERE id = $1 AND family_id = $2", [request.params.itemId, ctx.familyId]);
      return true;
    });
    if (!deleted) return reply.code(404).send(NOT_FOUND);
    return reply.code(204).send();
  });

  app.post<{ Params: { medicineId: string } }>("/api/v1/medicines/:medicineId/trash", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const deleted = await database.withTransaction(async (tx) => {
      const medicine = await lockMedicineInFamily(tx, request.params.medicineId, ctx.familyId);
      if (medicine === null) return false;
      const result = await tx.query<{ id: string }>(
        "UPDATE medicines SET deleted_at = now(), deleted_by = $3, updated_by = $3, version = version + 1, updated_at = now() WHERE id = $1 AND family_id = $2 AND deleted_at IS NULL RETURNING id",
        [request.params.medicineId, ctx.familyId, ctx.userId],
      );
      return result.rowCount !== 0;
    });
    if (!deleted) return reply.code(404).send(NOT_FOUND);
    return reply.code(204).send();
  });

  app.get("/api/v1/trash", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const result = await database.query<{
      type: "medicine" | "batch";
      id: string;
      medicine_id: string;
      name: string;
      deleted_at: Date | string;
      expires_at: Date | string;
      quantity: number | null;
      unit: QuantityUnit | null;
    }>(
      `SELECT 'medicine'::text AS type, m.id, m.id AS medicine_id, m.name, m.deleted_at,
              m.deleted_at + interval '30 days' AS expires_at, NULL::integer AS quantity, NULL::text AS unit
       FROM medicines m WHERE m.family_id = $1 AND m.deleted_at > now() - interval '30 days'
       UNION ALL
       SELECT 'batch'::text AS type, b.id, b.medicine_id, m.name, b.deleted_at,
              b.deleted_at + interval '30 days' AS expires_at, b.quantity, b.unit
       FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id AND m.family_id = b.family_id
       WHERE b.family_id = $1 AND b.deleted_at > now() - interval '30 days' AND m.deleted_at IS NULL
       ORDER BY deleted_at DESC, id`,
      [ctx.familyId],
    );
    return {
      items: result.rows.map((row) => ({
        type: row.type,
        id: row.id,
        medicineId: row.medicine_id,
        name: row.name,
        deletedAt: toIso(row.deleted_at),
        expiresAt: toIso(row.expires_at),
        quantity: row.quantity,
        unit: row.unit,
      })),
    };
  });

  app.post<{ Params: { type: string; id: string } }>("/api/v1/trash/:type/:id/restore", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    if (request.params.type !== "medicine" && request.params.type !== "batch") {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "回收站记录类型不合法"));
    }
    if (request.params.type === "medicine") {
      const restored = await database.query<{ id: string }>(
        `UPDATE medicines SET deleted_at = NULL, deleted_by = NULL, updated_by = $3,
         version = version + 1, updated_at = now()
         WHERE id = $1 AND family_id = $2 AND deleted_at > now() - interval '30 days'
         RETURNING id`,
        [request.params.id, ctx.familyId, ctx.userId],
      );
      if (restored.rowCount === 0) return reply.code(404).send(NOT_FOUND);
      return { restored: true, type: "medicine", id: request.params.id };
    }
    try {
      await database.withTransaction(async (tx) => {
        const lookup = await tx.query<{ medicine_id: string; deleted_at: Date | string | null }>(
          "SELECT medicine_id, deleted_at FROM medicine_batches WHERE id = $1 AND family_id = $2 FOR UPDATE",
          [request.params.id, ctx.familyId],
        );
        const batch = lookup.rows[0];
        if (batch === undefined || batch.deleted_at === null || new Date(toIso(batch.deleted_at)).getTime() <= Date.now() - 30 * 24 * 60 * 60_000) {
          throw new TransactionConflictError(404, NOT_FOUND);
        }
        const medicine = await lockMedicineInFamily(tx, batch.medicine_id, ctx.familyId);
        if (medicine === null) throw new TransactionConflictError(409, errorBody("VERSION_CONFLICT", "请先恢复所属药品"));
        const restored = await tx.query<{ id: string }>(
          `UPDATE medicine_batches SET deleted_at = NULL, deleted_by = NULL, updated_by = $3,
           version = version + 1, updated_at = now()
           WHERE id = $1 AND family_id = $2 AND deleted_at > now() - interval '30 days' RETURNING id`,
          [request.params.id, ctx.familyId, ctx.userId],
        );
        if (restored.rowCount === 0) throw new TransactionConflictError(404, NOT_FOUND);
        await bumpMedicineVersion(tx, batch.medicine_id, ctx.familyId, ctx.userId);
      });
      return { restored: true, type: "batch", id: request.params.id };
    } catch (error) {
      if (error instanceof TransactionConflictError) return reply.code(error.statusCode).send(error.body);
      throw error;
    }
  });

  app.get("/api/v1/families/audit", async (request, reply) => {
    const ctx = requireFamily(request, reply);
    if (ctx === null) return;
    const query = request.query as { limit?: string } | undefined;
    const parsedLimit = query?.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "limit 必须为 1 到 100 的整数"));
    }
    const result = await database.query<{
      id: string;
      actor_id: string | null;
      actor_nickname: string | null;
      entity_type: string;
      entity_id: string;
      action: string;
      changes: unknown;
      created_at: Date | string;
    }>(
      `SELECT e.id, e.actor_id, u.nickname AS actor_nickname, e.entity_type, e.entity_id,
              e.action, e.changes, e.created_at
       FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.family_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT $2`,
      [ctx.familyId, parsedLimit],
    );
    return {
      events: result.rows.map((row) => ({
        id: row.id,
        actorId: row.actor_id,
        actorName: row.actor_nickname,
        entityType: row.entity_type,
        entityId: row.entity_id,
        action: row.action,
        changes: row.changes,
        createdAt: toIso(row.created_at),
      })),
    };
  });
}
