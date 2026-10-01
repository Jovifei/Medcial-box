// Real PostgreSQL only. WeChat identity exchange alone is a fake gateway.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { applyMigrations } from "../dist/db/migrations.js";
import { buildServer } from "../dist/app.js";
import { dispatchDueReminderMessages } from "../dist/jobs/reminder-scheduler.js";
import { cleanupExpiredTrashedMedicinePhotos } from "../dist/jobs/leaflet-photo-cleanup.js";
import { createReminderTemplateConfig } from "../dist/services/subscribe-messages.js";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { isolatedPostgres, contend, bounded, signal } from "./helpers/isolated-pg.mjs";

const url = process.env.TEST_DATABASE_URL?.trim() ?? "";

/** 上海日历日（可偏移天数）：时间敏感的提醒用例不能依赖固定日期，否则真实时间一过就腐化。 */
function shanghaiDate(offsetDays) {
  const real = new Date();
  const shanghai = new Date(real.getTime() + 8 * 3600 * 1000);
  const shifted = new Date(Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate() + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

/**
 * 调度时刻：取"真实时间（或当日上海 09:30，保证在提醒窗口内）之后一分钟"。
 * 比真实时间晚一点，才能覆盖刚由同一轮调度写入的 next_attempt_at = now()。
 */
function reminderDispatchNow() {
  const real = new Date();
  const shanghai = new Date(real.getTime() + 8 * 3600 * 1000);
  const windowStart = Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate(), 1, 30);
  const base = real.getTime() >= windowStart ? real.getTime() : windowStart;
  return new Date(base + 60_000);
}

const required = process.env.REQUIRE_POSTGRES_TESTS === "1";
const batch = (quantity = 2) => ({ quantity, unit: "box", lotNumber: randomUUID(), expiry: { value: "2099-12", precision: "month" }, storageLocation: "药箱" });
const medicineLock = /SELECT[\s\S]*FROM medicines[\s\S]*FOR UPDATE/;
const familyLock = /SELECT id FROM families WHERE id = \$1 FOR UPDATE/;

function status(response, expected) {
  assert.equal(response.statusCode, expected, response.body);
  return expected === 204 ? null : response.json();
}

test("real PostgreSQL: isolated migrations, CRUD, privacy and deterministic contention", {
  skip: !url && !required ? "TEST_DATABASE_URL absent: optional local PostgreSQL suite" : false,
  concurrency: 1,
}, async (t) => {
  assert.ok(url, "REQUIRE_POSTGRES_TESTS=1 requires TEST_DATABASE_URL; real PostgreSQL cannot be skipped");
  const fixture = await isolatedPostgres(url);
  const { pool, database } = fixture;
  const gateway = createTestGateway();
  const privatePhotoFiles = new Map();
  const privatePhotoStore = {
    save: async ({ familyId, medicineId, photoId, bytes }) => {
      const key = `leaflets/${familyId}/${medicineId}/${photoId}.png`;
      privatePhotoFiles.set(key, Buffer.from(bytes));
      return key;
    },
    read: async (key) => {
      const bytes = privatePhotoFiles.get(key);
      if (bytes === undefined) throw new Error("photo is missing");
      return bytes;
    },
    remove: async (key) => { privatePhotoFiles.delete(key); },
  };
  const reminderConfig = createReminderTemplateConfig({
    appId: "synthetic-app-id",
    appSecret: "synthetic-secret",
    templateId: "synthetic-reminder-template",
  });
  let app;
  try {
    await t.test("fresh schema applies 006 lifecycle after the established migrations; second migrate is empty", async () => {
      const applied = await applyMigrations(pool);
      assert.deepEqual(applied.slice(0, 6), ["001_bootstrap.sql", "002_core_inventory.sql", "003_family_invites.sql", "004_family_single_owner.sql", "005_add_created_at_columns.sql", "006_inventory_lifecycle.sql"]);
      assert.ok(applied.some((name) => /^007_/.test(name)), "later feature migrations may follow lifecycle migration 006");
      assert.ok(applied.includes("008_medicine_barcode.sql"));
      assert.ok(applied.includes("009_session_client_kind.sql"));
      assert.ok(applied.includes("010_device_link_code_unique.sql"));
      assert.ok(applied.includes("011_backup_restore_previews.sql"));
      assert.ok(applied.includes("012_leaflet_photo_storage_cleanup.sql"));
      assert.deepEqual(await applyMigrations(pool), []);
      const columns = await pool.query("SELECT table_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'created_at' AND table_name = ANY($2::text[]) ORDER BY table_name", [fixture.schema, ["medicines", "medicine_batches", "dosage_notes"]]);
      assert.deepEqual(columns.rows, ["dosage_notes", "medicine_batches", "medicines"].map((table_name) => ({ table_name, data_type: "timestamp with time zone", is_nullable: "NO" })));
      const index = await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'family_members' AND indexname = 'family_members_single_owner_per_family'", [fixture.schema]);
      assert.equal(index.rowCount, 1);
      assert.match(index.rows[0].indexdef, /UNIQUE[\s\S]*WHERE[\s\S]*owner/);
      // Check multiple simultaneous connections, not just whichever ran migrations.
      const clients = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
      try {
        for (const client of clients) assert.deepEqual((await client.query("SELECT current_schemas(false)::text[] AS schemas")).rows[0].schemas, [fixture.schema, "pg_catalog"]);
      } finally { clients.forEach((client) => client.release()); }
    });
    app = await buildServer({ database, wechatGateway: gateway, reminderTemplateConfig: reminderConfig, privatePhotoStore, logger: { level: "error" } });
    const request = (user, method, path, payload) => app.inject({ method, url: `/api/v1${path}`, headers: { authorization: `Bearer ${user.token}` }, ...(payload === undefined ? {} : { payload }) });
    async function user() {
      const code = randomUUID();
      gateway.registerCode(code, `real-pg-${code}`);
      const auth = status(await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: { code } }), 200);
      assert.equal(auth.user.hasFamily, false);
      return { token: auth.token, id: auth.user.id };
    }
    async function family(memberCount = 0) {
      const owner = await user();
      const created = status(await request(owner, "POST", "/families", { name: `家庭-${randomUUID()}` }), 201);
      owner.membershipId = created.membership.id;
      const members = [];
      for (let i = 0; i < memberCount; i++) {
        const member = await user();
        const invite = status(await request(owner, "POST", "/families/invitations"), 201);
        const accepted = status(await request(member, "POST", "/families/invitations/accept", { code: invite.invitationCode }), 200);
        member.membershipId = accepted.membership.id;
        members.push(member);
      }
      return { owner, members, id: created.family.id };
    }
    async function createMedicine(owner, batches = [batch()], name = "测试药品") {
      return status(await request(owner, "POST", "/medicines", { name, batches }), 201);
    }
    async function roles(id) {
      return (await pool.query("SELECT user_id, role FROM family_members WHERE family_id = $1 ORDER BY user_id", [id])).rows;
    }
    async function assertOwner(group, winner) {
      const actual = await roles(group.id);
      assert.deepEqual(actual.filter((row) => row.role === "owner"), [{ user_id: winner.id, role: "owner" }]);
      assert.equal(actual.find((row) => row.user_id === group.owner.id)?.role, "member");
    }

    await t.test("private photo quota serializes concurrent uploads and releases space only after file removal", async () => {
      const { owner, id: familyId } = await family();
      const medicine = await createMedicine(owner, [], "说明书图片配额测试药");
      const tinyPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
      const first = status(await request(owner, "POST", `/medicines/${medicine.id}/leaflet-photos`, {
        imageBase64: tinyPng.toString("base64"), mimeType: "image/png",
      }), 201);
      assert.equal(status(await request(owner, "GET", `/medicines/${medicine.id}/leaflet-photos`), 200).photos.length, 1);
      const fetched = await request(owner, "GET", `/medicines/${medicine.id}/leaflet-photos/${first.photo.id}`);
      assert.equal(fetched.statusCode, 200);
      assert.deepEqual(fetched.rawPayload, tinyPng);
      const outsider = (await family()).owner;
      status(await request(outsider, "GET", `/medicines/${medicine.id}/leaflet-photos/${first.photo.id}`), 404);

      await pool.query(
        `INSERT INTO medicine_leaflet_photos
         (family_id, medicine_id, storage_key, content_type, size_bytes, source, created_by, upload_completed_at)
         SELECT $1,$2,'quota-' || gen_random_uuid()::text || '.png','image/png',$4,'quota-test',$3,now()
         FROM generate_series(1,7)`,
        [familyId, medicine.id, owner.id, 8 * 1024 * 1024],
      );
      const makePng = (size) => {
        const bytes = Buffer.alloc(size);
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
        Buffer.from([73, 69, 78, 68, 174, 66, 96, 130]).copy(bytes, size - 8);
        return bytes.toString("base64");
      };
      const concurrentImage = makePng(4 * 1024 * 1024);
      const responses = await Promise.all([
        request(owner, "POST", `/medicines/${medicine.id}/leaflet-photos`, { imageBase64: concurrentImage, mimeType: "image/png" }),
        request(owner, "POST", `/medicines/${medicine.id}/leaflet-photos`, { imageBase64: concurrentImage, mimeType: "image/png" }),
      ]);
      assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 413]);
      assert.equal(privatePhotoFiles.size, 2, "quota rejection removes the temporary file");
      status(await request(owner, "DELETE", `/medicines/${medicine.id}/leaflet-photos/${first.photo.id}`), 204);
      assert.equal(privatePhotoFiles.has(`leaflets/${familyId}/${medicine.id}/${first.photo.id}.png`), false);
      const removedMetadata = await pool.query(
        "SELECT deleted_at, storage_removed_at FROM medicine_leaflet_photos WHERE id = $1",
        [first.photo.id],
      );
      assert.ok(removedMetadata.rows[0].deleted_at);
      assert.ok(removedMetadata.rows[0].storage_removed_at, "quota is released only after the private file is removed");
      status(await request(owner, "POST", `/medicines/${medicine.id}/leaflet-photos`, {
        imageBase64: concurrentImage, mimeType: "image/png",
      }), 201);
      status(await request(owner, "POST", `/medicines/${medicine.id}/leaflet-photos`, {
        imageBase64: tinyPng.toString("base64"), mimeType: "image/png",
      }), 413);
    });

    await t.test("photos remain during the medicine recovery window and are cleaned after 30 days", async () => {
      const { owner, id: familyId } = await family();
      const medicine = await createMedicine(owner, [], "回收站照片清理测试药");
      const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
      const upload = status(await request(owner, "POST", `/medicines/${medicine.id}/leaflet-photos`, {
        imageBase64: png.toString("base64"), mimeType: "image/png",
      }), 201);
      const photoKey = `leaflets/${familyId}/${medicine.id}/${upload.photo.id}.png`;
      assert.equal(privatePhotoFiles.has(photoKey), true);
      await pool.query("UPDATE medicines SET deleted_at = now() - interval '20 days' WHERE id = $1", [medicine.id]);
      assert.equal(await cleanupExpiredTrashedMedicinePhotos(database, privatePhotoStore), 0);
      assert.equal(privatePhotoFiles.has(photoKey), true);
      await pool.query("UPDATE medicines SET deleted_at = now() - interval '31 days' WHERE id = $1", [medicine.id]);
      assert.equal(await cleanupExpiredTrashedMedicinePhotos(database, privatePhotoStore), 1);
      assert.equal(privatePhotoFiles.has(photoKey), false);
      const state = (await pool.query("SELECT deleted_at, upload_completed_at, storage_removed_at FROM medicine_leaflet_photos WHERE id = $1", [upload.photo.id])).rows[0];
      assert.ok(state.deleted_at);
      assert.ok(state.upload_completed_at);
      assert.ok(state.storage_removed_at);
      status(await request(owner, "POST", `/trash/medicine/${medicine.id}/restore`), 404);
    });

    await t.test("splitting an unopened batch is atomic, versioned, audited, and family-scoped", async () => {
      const group = await family();
      const { owner } = group;
      const outsider = (await family()).owner;
      const medicine = await createMedicine(owner, [{
        quantity: 8,
        unit: "box",
        lotNumber: "SPLIT-LOT-1",
        expiry: { value: "2027-12", precision: "month" },
        confirmedUnitsPerPackage: 20,
        storageLocation: "卧室药箱",
        openedState: "unopened",
      }], "批次拆分测试药");
      const sourceBefore = medicine.batches[0];
      assert.equal(sourceBefore.quantity, 8);
      assert.equal(sourceBefore.openedState, "unopened");

      const split = status(await request(owner, "POST", `/medicines/${medicine.id}/batches/${sourceBefore.id}/open-split`, {
        version: sourceBefore.version,
        openedQuantity: 3,
        openedAt: "2026-09-29",
        afterOpeningLimit: { value: 2, unit: "month", source: "包装说明" },
        confirmed: true,
      }), 201);
      assert.equal(split.remainingBatch.id, sourceBefore.id);
      assert.equal(split.remainingBatch.quantity, 5);
      assert.equal(split.remainingBatch.openedState, "unopened");
      assert.equal(split.remainingBatch.version, sourceBefore.version + 1);
      assert.equal(split.openedBatch.quantity, 3);
      assert.equal(split.openedBatch.openedState, "opened");
      assert.equal(split.openedBatch.openedAt, "2026-09-29");
      assert.deepEqual(split.openedBatch.afterOpeningLimit, { value: 2, unit: "month", source: "包装说明" });
      for (const field of ["lotNumber", "expiry", "unit", "confirmedUnitsPerPackage", "storageLocation"]) {
        assert.deepEqual(split.openedBatch[field], sourceBefore[field], `${field} must be copied from the physical package`);
      }
      const current = status(await request(owner, "GET", `/medicines/${medicine.id}`), 200);
      assert.equal(current.version, medicine.version + 1);
      assert.equal(current.batches.length, 2);
      assert.equal(current.batches.reduce((sum, entry) => sum + entry.quantity, 0), 8);
      const semanticAudit = (await pool.query(
        "SELECT family_id, actor_id, entity_type, entity_id, action, changes FROM audit_events WHERE action = 'split_opened' AND entity_id = $1",
        [split.openedBatch.id],
      )).rows[0];
      assert.equal(semanticAudit.family_id, group.id);
      assert.equal(semanticAudit.actor_id, owner.id);
      assert.equal(semanticAudit.entity_type, "batch");
      assert.equal(semanticAudit.entity_id, split.openedBatch.id);
      // 审计事件里的 numeric 以字符串保存（触发器既有行为）：比较前显式归一为数字。
      assert.equal(Number(semanticAudit.changes.openedQuantity), 3);
      assert.equal(Number(semanticAudit.changes.remainingQuantity), 5);

      const auditCount = (await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE entity_id = ANY($1::uuid[])", [[sourceBefore.id, split.openedBatch.id]])).rows[0].count;
      status(await request(owner, "POST", `/medicines/${medicine.id}/batches/${sourceBefore.id}/open-split`, {
        version: sourceBefore.version,
        openedQuantity: 1,
        openedAt: "2026-09-29",
        confirmed: true,
      }), 409);
      const afterStale = status(await request(owner, "GET", `/medicines/${medicine.id}`), 200);
      assert.equal(afterStale.version, current.version);
      assert.deepEqual(afterStale.batches, current.batches);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE entity_id = ANY($1::uuid[])", [[sourceBefore.id, split.openedBatch.id]])).rows[0].count, auditCount);

      status(await request(outsider, "POST", `/medicines/${medicine.id}/batches/${sourceBefore.id}/open-split`, {
        version: split.remainingBatch.version,
        openedQuantity: 1,
        openedAt: "2026-09-29",
        confirmed: true,
      }), 404);
      assert.deepEqual(status(await request(outsider, "GET", `/medicines/${medicine.id}`), 404), { error: { code: "NOT_FOUND", message: "药品不存在或不在当前家庭中" } });
      assert.equal(status(await request(owner, "GET", `/medicines/${medicine.id}`), 200).batches.length, 2);
    });

    await t.test("inventory lifecycle, item-level stocktake conflicts, restock versions, trash and device linking", async () => {
      const { owner, members: [member] } = await family(1);
      const outsider = (await family()).owner;
      const created = status(await request(owner, "POST", "/medicines", {
        name: "开封期限测试药",
        barcodeValue: "6901234567890",
        lowStockThreshold: { quantity: 2, unit: "box" },
        batches: [
          { quantity: 2, unit: "box", expiry: { value: "2027-01", precision: "month" }, openedState: "opened", openedAt: shanghaiDate(-30), afterOpeningLimit: { value: 30, unit: "day", source: "包装说明" } },
          { quantity: 1, unit: "box", expiry: { value: "2099-12", precision: "month" }, openedState: "unopened" },
        ],
      }), 201);
      status(await request(owner, "POST", "/notifications/subscribe", {
        acceptedTemplateIds: ["synthetic-reminder-template"],
      }), 200);
      const sentReminders = [];
      const dispatched = await dispatchDueReminderMessages(database, {
        send: async (message) => {
          sentReminders.push(message);
          return { messageId: `synthetic-${sentReminders.length}` };
        },
      }, reminderConfig, reminderDispatchNow());
      const reminderRows = (await pool.query("SELECT status, deadline_date::text, last_error_code FROM reminder_deliveries ORDER BY created_at")).rows;
      assert.equal(dispatched.sent, 1, JSON.stringify({ dispatched, sentReminders, reminderRows }));
      const today = shanghaiDate(0);
      assert.equal(sentReminders[0].deadlineDate, today, "the earlier opening deadline drives the reminder");
      assert.equal(sentReminders[0].medicineName, "开封期限测试药");
      const med = status(await request(owner, "GET", `/medicines/${created.id}`), 200);
      assert.equal(med.barcodeValue, "6901234567890");
      assert.equal(med.lowStockThreshold.quantity, 2);
      assert.equal(med.batches.find((entry) => entry.id === created.batches[0].id).openedExpiryDate, today);
      assert.equal(med.batches.find((entry) => entry.id === created.batches[0].id).managementExpiryDate, today);
      assert.equal(med.stockStatus.state, "ok");

      assert.deepEqual(status(await request(owner, "GET", "/families/settings"), 200).settings, {
        stocktakeInterval: "monthly", lastStocktakeAt: null, nextStocktakeAt: null,
      });
      status(await request(owner, "PUT", "/families/settings", { stocktakeInterval: "weekly" }), 200);

      const firstSession = status(await request(owner, "POST", "/families/stocktakes"), 201).stocktake;
      assert.equal(firstSession.items.length, 2);
      const openedBatch = med.batches.find((entry) => entry.openedState === "opened");
      assert.equal(firstSession.items.find((entry) => entry.batchId === openedBatch.id).managementExpiryDate, today);
      const changed = status(await request(member, "PUT", `/medicines/${med.id}/batches/${openedBatch.id}`, {
        ...openedBatch, quantity: 3,
      }), 200);
      assert.equal(changed.version, openedBatch.version + 1);
      const stale = status(await request(owner, "POST", `/families/stocktakes/${firstSession.id}/items`, {
        items: [{ batchId: openedBatch.id, version: openedBatch.version, outcome: "adjusted", quantity: 1 }],
      }), 200);
      assert.deepEqual(stale.results, [{ batchId: openedBatch.id, outcome: "conflict", currentVersion: changed.version }]);
      status(await request(outsider, "POST", `/families/stocktakes/${firstSession.id}/items`, {
        items: [{ batchId: openedBatch.id, version: changed.version, outcome: "unchanged" }],
      }), 404);

      const secondSession = status(await request(owner, "POST", "/families/stocktakes"), 201).stocktake;
      const current = status(await request(owner, "GET", `/medicines/${med.id}`), 200).batches.find((entry) => entry.id === openedBatch.id);
      const saved = status(await request(owner, "POST", `/families/stocktakes/${secondSession.id}/items`, {
        items: [{ batchId: openedBatch.id, version: current.version, outcome: "handled" }],
      }), 200);
      assert.equal(saved.results[0].outcome, "saved");
      const afterHandle = status(await request(owner, "GET", `/medicines/${med.id}`), 200);
      assert.equal(afterHandle.batches.find((entry) => entry.id === openedBatch.id).dispositionStatus, "handled");
      assert.equal(afterHandle.stockStatus.state, "low");
      const completed = status(await request(owner, "POST", `/families/stocktakes/${secondSession.id}/complete`), 200);
      assert.equal(completed.completed, true);
      assert.ok(completed.nextStocktakeAt);
      status(await request(owner, "POST", `/families/stocktakes/${secondSession.id}/complete`), 409);

      const restock = status(await request(member, "POST", "/families/restock", {
        medicineId: med.id, desiredQuantity: 2, unit: "box",
      }), 201);
      assert.equal(restock.version, 1);
      const updatedRestock = status(await request(owner, "PUT", `/families/restock/${restock.id}`, {
        version: 1, status: "purchased",
      }), 200);
      assert.equal(updatedRestock.version, 2);
      status(await request(owner, "PUT", `/families/restock/${restock.id}`, { version: 1, status: "dismissed" }), 409);
      assert.deepEqual(status(await request(outsider, "GET", "/families/restock"), 200).items, []);
      status(await request(owner, "DELETE", `/families/restock/${restock.id}`), 204);

      const unopened = afterHandle.batches.find((entry) => entry.id !== openedBatch.id);
      status(await request(owner, "DELETE", `/medicines/${med.id}/batches/${unopened.id}`), 204);
      assert.ok(status(await request(owner, "GET", "/trash"), 200).items.some((entry) => entry.id === unopened.id && entry.type === "batch"));
      status(await request(outsider, "POST", `/trash/batch/${unopened.id}/restore`), 404);
      status(await request(owner, "POST", `/trash/batch/${unopened.id}/restore`), 200);
      status(await request(owner, "DELETE", `/medicines/${med.id}/batches/${unopened.id}`), 204);
      await pool.query("UPDATE medicine_batches SET deleted_at = now() - interval '31 days' WHERE id = $1", [unopened.id]);
      assert.ok(!status(await request(owner, "GET", "/trash"), 200).items.some((entry) => entry.id === unopened.id));
      status(await request(owner, "POST", `/trash/batch/${unopened.id}/restore`), 404);

      status(await request(owner, "POST", `/medicines/${med.id}/trash`), 204);
      assert.deepEqual(status(await request(owner, "GET", "/medicines"), 200).medicines, []);
      status(await request(owner, "POST", `/trash/medicine/${med.id}/restore`), 200);
      assert.equal(status(await request(owner, "GET", `/medicines/${med.id}`), 200).isArchived, false);
      assert.ok(status(await request(owner, "GET", "/families/audit"), 200).events.length >= 6);

      const backup = status(await request(owner, "POST", "/backups/json"), 200);
      assert.equal(backup.medicines[0].barcodeValue, "6901234567890");
      assert.equal(backup.medicines[0].batches.find((item) => item.openedState === "opened").afterOpeningLimit.value, 30);
      assert.equal(backup.medicines[0].batches.find((item) => item.openedState === "opened").afterOpeningLimit.unit, "day");
      assert.equal(JSON.stringify(backup).includes("dosage"), false);
      backup.inventorySettings.stocktakeInterval = "monthly";
      const preview = status(await request(owner, "POST", "/backups/preview", { backup }), 200);
      assert.equal(preview.valid, true);
      assert.equal(preview.duplicateBackup, false);
      assert.equal(preview.inventorySettings.stocktakeInterval, "monthly");
      assert.match(preview.confirmationToken, /^[a-f0-9]{64}$/);
      const beforeRestoreCount = status(await request(owner, "GET", "/medicines?includeArchived=true"), 200).medicines.length;
      const tamperedBackup = { ...backup, familyName: "已修改预览内容" };
      status(await request(owner, "POST", "/backups/restore", {
        backup: tamperedBackup, confirmationToken: preview.confirmationToken, confirmed: true,
      }), 409);
      assert.equal(status(await request(owner, "GET", "/medicines?includeArchived=true"), 200).medicines.length, beforeRestoreCount);
      const restored = status(await request(owner, "POST", "/backups/restore", {
        backup, confirmationToken: preview.confirmationToken, confirmed: true,
      }), 201);
      assert.equal(restored.restoredCount, 1);
      assert.equal(status(await request(owner, "GET", "/medicines?includeArchived=true"), 200).medicines.length, beforeRestoreCount + 1);
      assert.equal(status(await request(owner, "GET", "/families/settings"), 200).settings.stocktakeInterval, "weekly", "restore must not overwrite existing family settings");

      const noSettingsOwner = (await family()).owner;
      assert.equal(status(await request(noSettingsOwner, "GET", "/families/settings"), 200).settings.stocktakeInterval, "monthly");
      const settingsBackup = status(await request(noSettingsOwner, "POST", "/backups/json"), 200);
      const malformedBackup = {
        ...settingsBackup,
        backupId: randomUUID(),
        inventorySettings: { ...settingsBackup.inventorySettings, lastStocktakeAt: { invalid: true } },
      };
      const malformedPreview = status(await request(noSettingsOwner, "POST", "/backups/preview", { backup: malformedBackup }), 200);
      assert.equal(malformedPreview.valid, false);
      assert.equal(malformedPreview.confirmationToken, undefined);
      status(await request(noSettingsOwner, "POST", "/backups/restore", {
        backup: malformedBackup, confirmationToken: "f".repeat(64), confirmed: true,
      }), 400);
      const missingTokenBackup = { ...settingsBackup, backupId: randomUUID(), medicines: [] };
      status(await request(noSettingsOwner, "POST", "/backups/restore", { backup: missingTokenBackup, confirmed: true }), 400);
      settingsBackup.backupId = randomUUID();
      settingsBackup.medicines = [];
      settingsBackup.inventorySettings.stocktakeInterval = "disabled";
      const settingsPreview = status(await request(noSettingsOwner, "POST", "/backups/preview", { backup: settingsBackup }), 200);
      status(await request(noSettingsOwner, "POST", "/backups/restore", {
        backup: settingsBackup, confirmationToken: settingsPreview.confirmationToken, confirmed: true,
      }), 201);
      assert.equal(status(await request(noSettingsOwner, "GET", "/families/settings"), 200).settings.stocktakeInterval, "monthly", "restore must preserve the effective default when settings row is absent");
      assert.equal(status(await request(owner, "POST", "/backups/preview", { backup }), 200).duplicateBackup, true);
      status(await request(owner, "POST", "/backups/restore", {
        backup, confirmationToken: preview.confirmationToken, confirmed: true,
      }), 409);
      assert.equal(status(await request(owner, "GET", "/medicines?includeArchived=true"), 200).medicines.length, beforeRestoreCount + 1);

      const link = status(await app.inject({ method: "POST", url: "/api/v1/auth/device-links" }), 201);
      const storedLink = (await pool.query("SELECT code_hash, poll_token_hash FROM device_link_requests WHERE code_hash = $1", [createHash("sha256").update(link.code).digest("hex")])).rows[0];
      assert.ok(storedLink);
      assert.notEqual(storedLink.code_hash, link.code);
      assert.notEqual(storedLink.poll_token_hash, link.pollToken);
      assert.deepEqual(status(await request(owner, "POST", "/auth/device-links/approve", { code: link.code }), 200), { approved: true });
      const exchanged = status(await app.inject({ method: "POST", url: "/api/v1/auth/device-links/exchange", payload: { pollToken: link.pollToken } }), 200);
      assert.equal(exchanged.state, "approved");
      assert.equal(exchanged.user.id, owner.id);
      const appSession = (await pool.query("SELECT id, client_kind FROM sessions WHERE token_hash = $1", [createHash("sha256").update(exchanged.token).digest("hex")])).rows[0];
      assert.equal(appSession.client_kind, "android");
      const devices = status(await request(owner, "GET", "/auth/devices"), 200).devices;
      const androidDevice = devices.find((device) => device.id === appSession.id);
      assert.equal(androidDevice?.clientKind, "android");
      status(await request(owner, "POST", `/auth/devices/${appSession.id}/revoke`), 200);
      status(await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { authorization: `Bearer ${exchanged.token}` } }), 401);
      assert.equal(status(await app.inject({ method: "POST", url: "/api/v1/auth/device-links/exchange", payload: { pollToken: link.pollToken } }), 200).state, "expired");

      const staleLink = status(await app.inject({ method: "POST", url: "/api/v1/auth/device-links" }), 201);
      status(await request(member, "POST", "/auth/device-links/approve", { code: staleLink.code }), 200);
      status(await request(member, "POST", "/families/leave"), 204);
      const denied = status(await app.inject({ method: "POST", url: "/api/v1/auth/device-links/exchange", payload: { pollToken: staleLink.pollToken } }), 200);
      assert.equal(denied.state, "expired", "membership revocation before exchange prevents App session issuance");
    });

    await t.test("backup restore round-trip preserves every field including handled batches across families (A01/A02)", async () => {
      const source = await family();
      const created = status(await request(source.owner, "POST", "/medicines", {
        name: "往返保真药",
        specification: "10mg×12片",
        manufacturer: "测试制药",
        approvalNumber: "国药准字H12345678",
        barcodeValue: "6901234567890",
        activeIngredients: ["布洛芬", "淀粉"],
        purposeCategory: "解热镇痛",
        leaflet: {
          purposeSummary: "用于缓解轻至中度疼痛",
          packageUsageSummary: "口服，一次1片，一日2次",
          contraindicationsSummary: "对本品过敏者禁用",
          precautionsSummary: "避免与其他解热镇痛药同用",
          source: "药品包装拍照",
          reviewStatus: "user_confirmed",
        },
        lowStockThreshold: { quantity: 2, unit: "box" },
        batches: [
          { lotNumber: "RT-L1", expiry: { value: "2027-12-31", precision: "day" }, quantity: 5, unit: "box", confirmedUnitsPerPackage: 12, storageLocation: "客厅药箱", openedState: "opened", openedAt: "2026-09-01", afterOpeningLimit: { value: 1, unit: "month", source: "说明书" } },
          { lotNumber: "RT-L2", expiry: { value: "2028-03", precision: "month" }, quantity: 3, unit: "box", storageLocation: "卧室药箱", openedState: "unopened" },
          { expiry: { value: null, precision: "unknown" }, quantity: 1, unit: "box", storageLocation: "冰箱" },
        ],
      }), 201);
      await pool.query("UPDATE medicine_batches SET disposition_status = 'handled' WHERE id = $1", [created.batches[0].id]);
      // DELETE /medicines/:id 才是归档（is_archived）；trash 是回收站软删除，不属于备份导出范围。
      const archivedMedicine = await createMedicine(source.owner, [batch()], "往返归档药");
      status(await request(source.owner, "DELETE", `/medicines/${archivedMedicine.id}`), 204);

      const sourceMedicines = status(await request(source.owner, "GET", "/medicines?includeArchived=true"), 200).medicines;
      assert.equal(sourceMedicines.length, 2);
      const backup = status(await request(source.owner, "POST", "/backups/json"), 200);
      const exportedMain = backup.medicines.find((item) => item.name === "往返保真药");
      assert.equal(exportedMain.batches.find((item) => item.lotNumber === "RT-L1").dispositionStatus, "handled");
      assert.equal(exportedMain.batches.find((item) => item.lotNumber === "RT-L2").dispositionStatus, "active");
      assert.equal(backup.medicines.find((item) => item.name === "往返归档药").isArchived, true);

      const preview = status(await request(source.owner, "POST", "/backups/preview", { backup }), 200);
      assert.equal(preview.valid, true);
      assert.equal(preview.handledBatchCount, 1, "preview must surface handled batches before restore");
      assert.equal(preview.settingsPolicy, "inventory_only");

      const tampered = structuredClone(backup);
      tampered.medicines.find((item) => item.name === "往返保真药").batches.find((item) => item.lotNumber === "RT-L1").dispositionStatus = "active";
      status(await request(source.owner, "POST", "/backups/restore", {
        backup: tampered, confirmationToken: preview.confirmationToken, confirmed: true,
      }), 409);

      // 源药品移入回收站后恢复到同一家庭，单次登录即可完成全字段往返比对：
      // 登录速率限制 30 次/分钟且按客户端地址共享，不为测试放宽产品限流。
      for (const medicine of sourceMedicines) {
        status(await request(source.owner, "POST", `/medicines/${medicine.id}/trash`), 204);
      }
      assert.deepEqual(status(await request(source.owner, "GET", "/medicines?includeArchived=true"), 200).medicines, []);
      const restoreBackup = structuredClone(backup);
      restoreBackup.backupId = randomUUID();
      const targetPreview = status(await request(source.owner, "POST", "/backups/preview", { backup: restoreBackup }), 200);
      const restored = status(await request(source.owner, "POST", "/backups/restore", {
        backup: restoreBackup, confirmationToken: targetPreview.confirmationToken, confirmed: true,
      }), 201);
      assert.equal(restored.restoredCount, 2);
      const targetMedicines = status(await request(source.owner, "GET", "/medicines?includeArchived=true"), 200).medicines;
      assert.equal(targetMedicines.length, 2);

      const batchKey = (item) => JSON.stringify([item.lotNumber ?? null, item.expiry?.value ?? null, item.expiry?.precision ?? null, item.quantity ?? null, item.unit ?? null, item.storageLocation ?? null]);
      const normalizeMedicine = (medicine) => ({
        name: medicine.name,
        specification: medicine.specification,
        manufacturer: medicine.manufacturer,
        approvalNumber: medicine.approvalNumber,
        barcodeValue: medicine.barcodeValue ?? null,
        activeIngredients: medicine.activeIngredients,
        purposeCategory: medicine.purposeCategory,
        leaflet: medicine.leaflet,
        lowStockThreshold: medicine.lowStockThreshold ?? null,
        isArchived: medicine.isArchived,
        batches: medicine.batches.map((item) => ({
          key: batchKey(item),
          lotNumber: item.lotNumber ?? null,
          expiry: item.expiry,
          quantity: item.quantity ?? null,
          unit: item.unit,
          confirmedUnitsPerPackage: item.confirmedUnitsPerPackage ?? null,
          storageLocation: item.storageLocation ?? null,
          openedState: item.openedState,
          openedAt: item.openedAt ?? null,
          afterOpeningLimit: item.afterOpeningLimit ?? null,
          dispositionStatus: item.dispositionStatus ?? "active",
        })).sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)),
      });
      for (const expected of sourceMedicines) {
        const actual = targetMedicines.find((item) => item.name === expected.name);
        assert.ok(actual, `restored medicine missing: ${expected.name}`);
        assert.deepEqual(normalizeMedicine(actual), normalizeMedicine(expected));
      }

      // 已处理库存不得复活为正常库存：handled 的 5 盒不计入余量（3 + 1 = 4）。
      const targetMain = targetMedicines.find((item) => item.name === "往返保真药");
      assert.equal(targetMain.batches.find((item) => item.lotNumber === "RT-L1").dispositionStatus, "handled");
      assert.deepEqual(targetMain.stockStatus, { state: "ok", quantity: 4, unit: "box" });
    });

    await t.test("HTTP auth/family/inventory CRUD, unknown versus zero, notes privacy and escaped export", async () => {
      const { owner, members: [member] } = await family(1);
      const outsider = (await family()).owner;
      status(await app.inject({ method: "GET", url: "/api/v1/medicines" }), 401);
      assert.equal(status(await request(owner, "GET", "/families/current"), 200).family.members.length, 2);
      const med = await createMedicine(owner, [batch(null), batch(0)], "药|品\n# 标题");
      const path = `/medicines/${med.id}`;
      const read = status(await request(owner, "GET", path), 200);
      assert.deepEqual(read.batches.map((item) => item.quantity).sort((a, b) => a === null ? -1 : b === null ? 1 : a - b), [null, 0]);
      assert.equal(status(await request(owner, "GET", "/medicines"), 200).medicines[0].id, med.id);
      status(await request(outsider, "GET", path), 404);
      status(await request(outsider, "GET", `${path}/batches`), 404);
      status(await request(outsider, "POST", `${path}/batches`, batch()), 404);
      status(await request(outsider, "DELETE", `${path}/batches/${read.batches[0].id}`), 404);
      status(await request(outsider, "PUT", path, { ...read, name: "intruder" }), 404);
      const notesPath = `${path}/dosage-notes`;
      const privateNote = status(await request(owner, "POST", notesPath, { content: "owner-secret", visibility: "private" }), 201);
      const shared = status(await request(owner, "POST", notesPath, { content: "共享|备注\n# 注入", visibility: "family" }), 201);
      assert.deepEqual(status(await request(member, "GET", notesPath), 200).notes.map((note) => note.id), [shared.id]);
      assert.equal(status(await request(owner, "GET", notesPath), 200).notes.length, 2);
      status(await request(member, "PUT", `${notesPath}/${privateNote.id}`, { version: 1, content: "偷改" }), 404);
      status(await request(outsider, "GET", notesPath), 404);
      const markdown = status(await request(member, "POST", "/exports/markdown", { includePersonalDosage: true }), 200).markdown;
      assert.ok(!markdown.includes("owner-secret"));
      assert.ok(markdown.includes("药\\|品 \\# 标题"));
      assert.ok(markdown.includes("共享\\|备注 \\# 注入"));
      assert.ok(markdown.includes("数量未知") && markdown.includes("已耗尽"));
      const defaultExport = status(await request(owner, "POST", "/exports/markdown", {}), 200).markdown;
      assert.ok(!defaultExport.includes("owner-secret"));
      status(await request(owner, "PUT", `${notesPath}/${privateNote.id}`, { version: privateNote.version, content: "updated-secret", visibility: "private" }), 200);
      status(await request(owner, "PUT", `${notesPath}/${privateNote.id}`, { version: privateNote.version, content: "stale" }), 409);
      status(await request(owner, "DELETE", `${notesPath}/${privateNote.id}`), 204);
      assert.ok(!status(await request(owner, "GET", notesPath), 200).notes.some((note) => note.id === privateNote.id));
      const added = status(await request(owner, "POST", `${path}/batches`, batch(3)), 201);
      const changed = status(await request(owner, "PUT", `${path}/batches/${added.id}`, { ...added, quantity: 4 }), 200);
      assert.equal(changed.quantity, 4);
      status(await request(owner, "PUT", `${path}/batches/${added.id}`, { ...added, quantity: 5 }), 409);
      status(await request(owner, "PUT", path, read), 409);
      const fresh = status(await request(owner, "GET", path), 200);
      const updated = status(await request(owner, "PUT", path, { ...fresh, name: "已更新" }), 200);
      assert.equal(updated.name, "已更新");
      status(await request(owner, "DELETE", `${path}/batches/${added.id}`), 204);
      assert.ok(!status(await request(owner, "GET", path), 200).batches.some((item) => item.id === added.id));
      status(await request(owner, "DELETE", path), 204);
      assert.deepEqual(status(await request(owner, "GET", "/medicines"), 200).medicines, []);
      assert.equal(status(await request(owner, "GET", "/medicines?includeArchived=true"), 200).medicines[0].isArchived, true);
    });

    await t.test("production adapter rolls back and stale batch rolls back whole medicine save", async () => {
      const marker = `rollback-${randomUUID()}`;
      await assert.rejects(database.withTransaction(async (tx) => {
        await tx.query("INSERT INTO users(openid) VALUES ($1)", [marker]);
        throw new Error("rollback-marker");
      }), /rollback-marker/);
      assert.equal((await pool.query("SELECT id FROM users WHERE openid = $1", [marker])).rowCount, 0);
      const { owner } = await family();
      const med = await createMedicine(owner, [batch(1), batch(2)]);
      const before = status(await request(owner, "GET", `/medicines/${med.id}`), 200);
      const stale = { ...before, batches: before.batches.map((item) => ({ ...item })) };
      stale.batches[1].version += 100;
      stale.name = "must-roll-back";
      status(await request(owner, "PUT", `/medicines/${med.id}`, stale), 409);
      const after = status(await request(owner, "GET", `/medicines/${med.id}`), 200);
      assert.deepEqual(after, before);
    });

    await t.test("single-use invite race rolls back losing inserted membership", async () => {
      const group = await family();
      const candidates = [await user(), await user()];
      const invite = status(await request(group.owner, "POST", "/families/invitations"), 201);
      const both = signal();
      let arrived = 0;
      fixture.observe = async ({ sql, run }) => {
        if (/UPDATE family_invites SET used_at/.test(sql)) {
          if (++arrived === 2) both.resolve();
          await bounded(both.promise, "both invite transactions inserted memberships");
        }
        return run();
      };
      let responses;
      try {
        const outcomes = await Promise.allSettled(candidates.map((candidate) => request(candidate, "POST", "/families/invitations/accept", { code: invite.invitationCode })));
        assert.ok(outcomes.every((outcome) => outcome.status === "fulfilled"), "both HTTP requests must fulfill");
        responses = outcomes.map((outcome) => outcome.value);
      } finally { both.resolve(); fixture.observe = null; }
      assert.equal(arrived, 2);
      assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 410]);
      const winner = candidates[responses.findIndex((response) => response.statusCode === 200)];
      const loser = candidates[responses.findIndex((response) => response.statusCode === 410)];
      assert.equal((await pool.query("SELECT id FROM family_members WHERE user_id = $1", [loser.id])).rowCount, 0);
      assert.equal((await pool.query("SELECT family_id FROM family_members WHERE user_id = $1", [winner.id])).rows[0].family_id, group.id);
      assert.equal((await pool.query("SELECT used_by FROM family_invites WHERE family_id = $1", [group.id])).rows[0].used_by, winner.id);
    });

    await t.test("correct owner unique constraint and concurrent transfers identify actual winning owner", async () => {
      const group = await family(2);
      const [one, two] = group.members;
      await assert.rejects(pool.query("UPDATE family_members SET role = 'owner' WHERE id = $1", [one.membershipId]), (error) => error.code === "23505" && error.constraint === "family_members_single_owner_per_family");
      const outcomes = await Promise.allSettled(group.members.map((member) => request(group.owner, "POST", `/families/members/${member.membershipId}/transfer-ownership`)));
      assert.ok(outcomes.every((outcome) => outcome.status === "fulfilled"), "all transfers must fulfill");
      const responses = outcomes.map((outcome) => outcome.value);
      assert.equal(responses.filter((response) => response.statusCode === 200).length, 1);
      assert.equal(responses.filter((response) => [403, 409].includes(response.statusCode)).length, 1);
      const winner = [one, two][responses.findIndex((response) => response.statusCode === 200)];
      await assertOwner(group, winner);
      status(await request(group.owner, "POST", "/families/leave"), 204);
      assert.equal((await pool.query("SELECT id FROM family_members WHERE user_id = $1", [group.owner.id])).rowCount, 0);
      assert.equal((await roles(group.id)).find((row) => row.user_id === winner.id).role, "owner");
    });

    for (const operation of ["PUT", "DELETE", "POST"]) {
      for (const batchFirst of [true, false]) {
        await t.test(`real medicine lock contention: ${operation} batch ${batchFirst ? "before" : "after"} whole save`, async () => {
          const { owner } = await family();
          const med = await createMedicine(owner);
          const path = `/medicines/${med.id}`;
          const original = med.batches[0];
          const standalone = () => request(owner, operation, operation === "POST" ? `${path}/batches` : `${path}/batches/${original.id}`, operation === "DELETE" ? undefined : operation === "POST" ? { ...batch(7), lotNumber: "committed-new" } : { ...original, quantity: 7 });
          const whole = () => request(owner, "PUT", path, { ...med, name: "whole-saved" });
          const [leader, follower] = await contend(fixture, medicineLock, batchFirst ? standalone : whole, batchFirst ? whole : standalone);
          status(leader, batchFirst ? operation === "POST" ? 201 : operation === "DELETE" ? 204 : 200 : 200);
          status(follower, batchFirst ? 409 : operation === "PUT" ? 409 : operation === "POST" ? 201 : 204);
          const final = status(await request(owner, "GET", path), 200);
          assert.equal(final.name, batchFirst ? med.name : "whole-saved");
          if (operation === "POST") {
            assert.equal(final.batches.length, 2);
            assert.equal(final.batches.find((item) => item.lotNumber === "committed-new")?.quantity, 7);
            assert.ok(final.batches.some((item) => item.id === original.id));
          } else if (operation === "DELETE") {
            assert.deepEqual(final.batches, []);
          } else {
            assert.equal(final.batches.length, 1);
            assert.equal(final.batches[0].id, original.id);
            assert.equal(final.batches[0].quantity, batchFirst ? 7 : original.quantity);
          }
        });
      }
    }

    for (const operation of ["leave", "remove"]) {
      await t.test(`family lock: transfer precedes ${operation}; new owner cannot disappear`, async () => {
        const group = await family(1);
        const target = group.members[0];
        const responses = await contend(fixture, familyLock,
          () => request(group.owner, "POST", `/families/members/${target.membershipId}/transfer-ownership`),
          () => operation === "leave" ? request(target, "POST", "/families/leave") : request(group.owner, "DELETE", `/families/members/${target.membershipId}`));
        status(responses[0], 200);
        status(responses[1], 409);
        await assertOwner(group, target);
        assert.equal((await roles(group.id)).length, 2);
      });
    }
  } finally {
    try { if (app) await app.close(); }
    finally { await fixture.close(); }
  }
});
