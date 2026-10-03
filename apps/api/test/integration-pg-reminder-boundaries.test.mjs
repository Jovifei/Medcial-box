// Real PostgreSQL regressions for channel consent and inventory send boundaries.
// Only the sender/explicit failure gates are synthetic; queries, transactions,
// migrations, authentication and the notification-preferences PUT are real.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { buildServer } from "../dist/app.js";
import { issueSessionToken } from "../dist/auth/session.js";
import { applyMigrations } from "../dist/db/migrations.js";
import { dispatchDoseReminders, queueDoseReminders, shanghaiClock } from "../dist/jobs/dose-reminder-scheduler.js";
import { cancelDeliveriesForMember, dispatchDueReminderMessages } from "../dist/jobs/reminder-scheduler.js";
import { toBatchSummary } from "../dist/repositories/batches.js";
import { createReminderTemplateConfig } from "../dist/services/subscribe-messages.js";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { bounded, contend, isolatedPostgres, signal } from "./helpers/isolated-pg.mjs";

const url = process.env.TEST_DATABASE_URL?.trim() ?? "";
const required = process.env.REQUIRE_POSTGRES_TESTS === "1";
const STOCK_TEMPLATE = "synthetic-boundary-stock";
const DOSE_TEMPLATE = "synthetic-boundary-dose";
const config = createReminderTemplateConfig({
  appId: "synthetic-app-id", appSecret: "synthetic-secret",
  templateId: STOCK_TEMPLATE, doseTemplateId: DOSE_TEMPLATE,
});

// Fixed Shanghai noon on today's date. Every fixture explicitly sets due times,
// so neither a midnight run nor PostgreSQL now() determines claim eligibility.
const date = shanghaiClock(new Date()).date;
const when = new Date(`${date}T04:00:00Z`);
const later = (minutes) => new Date(when.getTime() + minutes * 60_000);

function status(response, expected) {
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}

function track(promise) {
  // Register a rejection handler before waiting for a gate; cleanup still awaits
  // the original promise and reports any failure instead of leaking a rejection.
  promise.catch(() => {});
  return promise;
}

function queryWrapper(database, intercept) {
  return {
    query: (sql, params) => intercept({ sql, params, run: () => database.query(sql, params) }),
    withTransaction: (fn) => database.withTransaction((tx) => fn({
      query: (sql, params) => intercept({ sql, params, run: () => tx.query(sql, params) }),
    })),
  };
}

// Pause only after the production claim transaction has COMMITTED. Matching the
// returned lease object avoids depending on SQL formatting or holding row locks
// while the concurrent settings/removal/new-worker operation runs.
function afterClaim(database, deliveryId) {
  const entered = signal();
  const release = signal();
  let intercepted = false;
  return {
    entered: entered.promise,
    release: release.resolve,
    database: {
      query: (...args) => database.query(...args),
      async withTransaction(fn) {
        const result = await database.withTransaction(fn);
        if (!intercepted && Array.isArray(result) && result.some((row) =>
          row.id === deliveryId && Number.isInteger(row.attempts) && typeof row.openid === "string")) {
          intercepted = true;
          entered.resolve();
          await bounded(release.promise, "release committed claim");
        }
        return result;
      },
    },
  };
}

function beforeSendCompletes() {
  const entered = signal();
  const release = signal();
  const calls = [];
  return {
    entered: entered.promise,
    release: release.resolve,
    calls,
    sender: {
      async send(message) {
        calls.push(message);
        entered.resolve();
        await bounded(release.promise, "release in-flight sender");
        return { messageId: "original-in-flight-message" };
      },
    },
  };
}

test("real PostgreSQL: reminder consent, cancellation and send ownership", {
  skip: !url && !required ? "TEST_DATABASE_URL absent: optional local PostgreSQL suite" : false,
  concurrency: 1,
}, async (t) => {
  assert.ok(url, "REQUIRE_POSTGRES_TESTS=1 requires TEST_DATABASE_URL; real PostgreSQL cannot be skipped");
  const fixture = await isolatedPostgres(url);
  const { pool, database } = fixture;
  let app;
  try {
    await applyMigrations(pool);
    app = await buildServer({ database, reminderTemplateConfig: config, wechatGateway: createTestGateway(), logger: false });
    // This schema was created exclusively by isolatedPostgres for this suite.
    // Clear only its fixture rows, not a shared/public or pre-existing schema.
    t.beforeEach(async () => { await pool.query("TRUNCATE users CASCADE"); });

    async function group(memberCount = 0) {
      const users = [];
      for (let index = 0; index <= memberCount; index += 1) {
        const id = randomUUID();
        const openid = `boundary-${id}`;
        await pool.query("INSERT INTO users (id, openid) VALUES ($1, $2)", [id, openid]);
        const { token } = await issueSessionToken(database, id);
        users.push({ id, openid, token });
      }
      const id = randomUUID();
      await pool.query("INSERT INTO families (id, name, created_by) VALUES ($1, '发送边界测试家庭', $2)", [id, users[0].id]);
      for (const [index, user] of users.entries()) {
        await pool.query("INSERT INTO family_members (family_id, user_id, role) VALUES ($1, $2, $3)", [id, user.id, index === 0 ? "owner" : "member"]);
        await pool.query("INSERT INTO notification_preferences (user_id, stock_reminder_time, channels) VALUES ($1, '09:00', ARRAY['wechat','android']::text[])", [user.id]);
      }
      return { id, owner: users[0], members: users.slice(1) };
    }

    async function preferences(user, channels) {
      const result = status(await app.inject({
        method: "PUT", url: "/api/v1/notification-preferences",
        headers: { authorization: `Bearer ${user.token}` },
        payload: { stockReminderTime: "09:00", channels },
      }), 200);
      assert.deepEqual(result.preferences.channels, channels);
      return result;
    }

    async function dose(group, user = group.owner) {
      const profileId = randomUUID();
      const planId = randomUUID();
      const grantId = randomUUID();
      await pool.query(`INSERT INTO care_profiles (id, family_id, display_name, linked_user_id, created_by, managed_by)
        VALUES ($1, $2, '本人', $3, $3, $3)`, [profileId, group.id, user.id]);
      await pool.query(`INSERT INTO medication_plans (id, family_id, care_profile_id, medicine_name, dosage_text, start_date, created_by)
        VALUES ($1, $2, $3, '测试计划', '用户填写的剂量', $4::date, $5)`, [planId, group.id, profileId, date, user.id]);
      await pool.query("INSERT INTO plan_time_slots (plan_id, time_of_day) VALUES ($1, '11:50')", [planId]);
      await pool.query("INSERT INTO wechat_subscription_grants (id, family_id, user_id, template_id) VALUES ($1, $2, $3, $4)", [grantId, group.id, user.id, DOSE_TEMPLATE]);
      return { planId, grantId, user };
    }

    async function queuedDose(group, user = group.owner) {
      const seeded = await dose(group, user);
      await queueDoseReminders(database, config, when);
      const row = (await pool.query("SELECT id, status FROM dose_reminder_deliveries WHERE plan_id=$1", [seeded.planId])).rows[0];
      assert.equal(row?.status, "queued");
      return { ...seeded, id: row.id };
    }

    async function stock(group, user = group.owner) {
      const medicineId = randomUUID();
      const batchId = randomUUID();
      const grantId = randomUUID();
      const id = randomUUID();
      await pool.query(`INSERT INTO medicines (id, family_id, name, created_by, updated_by)
        VALUES ($1, $2, '测试库存', $3, $3)`, [medicineId, group.id, group.owner.id]);
      await pool.query(`INSERT INTO medicine_batches
        (id, family_id, medicine_id, quantity, unit, expiry_value, expiry_precision, created_by, updated_by)
        VALUES ($1, $2, $3, 1, 'box', $4, 'day', $5, $5)`, [batchId, group.id, medicineId, date, group.owner.id]);
      await pool.query(`INSERT INTO wechat_subscription_grants (id, family_id, user_id, template_id, consumed_at)
        VALUES ($1, $2, $3, $4, now())`, [grantId, group.id, user.id, STOCK_TEMPLATE]);
      await pool.query(`INSERT INTO reminder_deliveries
        (id, family_id, user_id, medicine_id, batch_id, deadline_date, days_before, template_id, subscription_grant_id, next_attempt_at)
        VALUES ($1, $2, $3, $4, $5, $6::date, 0, $7, $8, $9)`,
      [id, group.id, user.id, medicineId, batchId, date, STOCK_TEMPLATE, grantId, when]);
      return { id, grantId, medicineId, batchId, user };
    }

    async function delivery(table, id) {
      assert.ok(["reminder_deliveries", "dose_reminder_deliveries"].includes(table));
      const rows = (await pool.query(`SELECT * FROM ${table} WHERE id=$1`, [id])).rows;
      assert.equal(rows.length, 1);
      return rows[0];
    }

    async function grant(id) {
      const rows = (await pool.query("SELECT consumed_at, dose_delivery_id FROM wechat_subscription_grants WHERE id=$1", [id])).rows;
      assert.equal(rows.length, 1);
      return rows[0];
    }

    async function removeMember(group, user) {
      await database.withTransaction(async (tx) => {
        await tx.query("DELETE FROM family_members WHERE family_id=$1 AND user_id=$2", [group.id, user.id]);
        await cancelDeliveriesForMember(tx, group.id, user.id);
      });
    }

    for (const channels of [[], ["android"]]) {
      await t.test(`PUT channels=${JSON.stringify(channels)} cancels queued dose and preserves another member`, async () => {
        const family = await group(1);
        const first = await queuedDose(family);
        const second = await queuedDose(family, family.members[0]);
        await preferences(family.owner, channels);
        const cancelled = await delivery("dose_reminder_deliveries", first.id);
        assert.equal(cancelled.status, "cancelled");
        assert.equal(cancelled.send_started_at, null);
        assert.equal((await grant(first.grantId)).consumed_at, null, "only a definitely queued dose may refund");
        assert.equal((await grant(first.grantId)).dose_delivery_id, null);
        assert.equal((await delivery("dose_reminder_deliveries", second.id)).status, "queued");
        assert.notEqual((await grant(second.grantId)).consumed_at, null);
        const calls = [];
        const result = await dispatchDoseReminders(database, {
          async sendDose(message) { calls.push(message.openid); return { messageId: "other-member-dose" }; },
        }, config, when);
        assert.deepEqual(calls, [family.members[0].openid]);
        assert.equal(result.sent, 1);
        assert.equal((await delivery("dose_reminder_deliveries", second.id)).status, "sent");
        const stored = status(await app.inject({ method: "GET", url: "/api/v1/notification-preferences", headers: { authorization: `Bearer ${family.owner.token}` } }), 200);
        assert.deepEqual(stored.preferences.channels, channels, "Android-only preference survives cancellation");
      });
    }

    await t.test("PUT after dose claim stops the sender and retains the in-flight reservation", async () => {
      const family = await group();
      const item = await queuedDose(family);
      const gate = afterClaim(database, item.id);
      let calls = 0;
      const pending = track(dispatchDoseReminders(gate.database, {
        async sendDose() { calls += 1; return { messageId: "must-not-send" }; },
      }, config, when));
      try {
        await bounded(gate.entered, "dose claim committed");
        assert.equal((await delivery("dose_reminder_deliveries", item.id)).status, "sending");
        await preferences(family.owner, ["android"]);
        const during = await delivery("dose_reminder_deliveries", item.id);
        assert.equal(during.cancel_requested, true);
        assert.equal(during.send_started_at, null);
        assert.notEqual((await grant(item.grantId)).consumed_at, null);
      } finally { gate.release(); await bounded(pending, "dose dispatch cleanup"); }
      assert.equal(calls, 0);
      assert.equal((await delivery("dose_reminder_deliveries", item.id)).status, "cancelled");
      assert.equal((await grant(item.grantId)).dose_delivery_id, item.id);
    });

    await t.test("queue that read WeChat before PUT cannot send after PUT commits", async () => {
      const family = await group();
      const item = await dose(family);
      const entered = signal();
      const release = signal();
      let held = false;
      const racingDatabase = queryWrapper(database, async ({ sql, params, run }) => {
        const result = await run();
        // The gate observes the actual enabled eligibility read and returns its
        // old result only after the PUT's cancellation transaction has committed.
        if (!held && /^\s*SELECT\b/i.test(sql) && /\bnotification_preferences\b/i.test(sql) &&
            params?.includes(item.user.id) && result.rows[0]?.channels?.includes("wechat")) {
          held = true;
          entered.resolve();
          await bounded(release.promise, "release queue eligibility snapshot");
        }
        return result;
      });
      const pending = track(queueDoseReminders(racingDatabase, config, when));
      try {
        await bounded(entered.promise, "queue has read enabled channel");
        await preferences(family.owner, ["android"]);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM dose_reminder_deliveries WHERE plan_id=$1", [item.planId])).rows[0].n, 0, "PUT cannot cancel a row that has not been inserted yet");
      } finally { release.resolve(); await bounded(pending, "racing queue cleanup"); }
      let calls = 0;
      await dispatchDoseReminders(database, {
        async sendDose() { calls += 1; return { messageId: "must-not-send" }; },
      }, config, when);
      assert.equal(calls, 0, "the send barrier must use current consent, not the queue's earlier read");
      const rows = (await pool.query("SELECT status, send_started_at FROM dose_reminder_deliveries WHERE plan_id=$1", [item.planId])).rows;
      for (const row of rows) {
        assert.ok(["cancelled", "blocked"].includes(row.status));
        assert.equal(row.send_started_at, null);
      }
      const receipt = await grant(item.grantId);
      if (rows.length === 0) assert.equal(receipt.consumed_at, null);
      else assert.notEqual(receipt.consumed_at, null, "an already-claimed reservation is conservatively retained");
    });

    await t.test("dose barrier rechecks membership after a committed claim", async () => {
      const family = await group(1);
      const item = await queuedDose(family, family.members[0]);
      const gate = afterClaim(database, item.id);
      let calls = 0;
      const pending = track(dispatchDoseReminders(gate.database, {
        async sendDose() { calls += 1; return { messageId: "must-not-send" }; },
      }, config, when));
      try {
        await bounded(gate.entered, "dose membership snapshot committed");
        // Deliberately omit the cancellation helper: the final barrier itself
        // must see membership loss rather than trust its claim-time snapshot.
        await pool.query("DELETE FROM family_members WHERE family_id=$1 AND user_id=$2", [family.id, item.user.id]);
      } finally { gate.release(); await bounded(pending, "dose membership dispatch cleanup"); }
      assert.equal(calls, 0);
      assert.equal((await delivery("dose_reminder_deliveries", item.id)).send_started_at, null);
    });

    await t.test("ambiguous inventory send is never retried or refunded", async () => {
      const family = await group();
      const item = await stock(family);
      const originalGrant = await grant(item.grantId);
      let calls = 0;
      const sender = { async send() { calls += 1; throw new Error("response lost after provider may have accepted request"); } };
      const first = await dispatchDueReminderMessages(database, sender, config, when);
      assert.equal(first.failed, 1);
      assert.equal(calls, 1);
      const failed = await delivery("reminder_deliveries", item.id);
      assert.equal(failed.status, "failed");
      assert.notEqual(failed.send_started_at, null);
      // Even an otherwise-due retry and subsequent milestone expiry cannot
      // make an uncertain, started delivery reusable.
      await pool.query("UPDATE reminder_deliveries SET next_attempt_at=$2 WHERE id=$1", [item.id, when]);
      for (const minutes of [11, 60, 24 * 60]) await dispatchDueReminderMessages(database, sender, config, later(minutes));
      assert.equal(calls, 1);
      assert.deepEqual(await grant(item.grantId), originalGrant);
      const held = await delivery("reminder_deliveries", item.id);
      assert.equal(held.attempts, 1);
      assert.equal(held.message_id, null);
      assert.notEqual(held.send_started_at, null);
    });

    await t.test("successful inventory send plus sent-state database failure is not sent again", async () => {
      const family = await group();
      const item = await stock(family);
      const originalGrant = await grant(item.grantId);
      const messageId = `provider-accepted-${randomUUID()}`;
      let injected = 0;
      let calls = 0;
      const failingSettlement = queryWrapper(database, async ({ sql, params, run }) => {
        if (injected === 0 && /^\s*UPDATE\s+reminder_deliveries\b/i.test(sql) && params?.includes(messageId)) {
          injected += 1;
          throw new Error("synthetic database failure after successful provider response");
        }
        return run();
      });
      const sender = { async send() { calls += 1; return { messageId }; } };
      await dispatchDueReminderMessages(failingSettlement, sender, config, when);
      assert.equal(injected, 1, "failure must occur on the real post-send settlement query");
      assert.equal(calls, 1);
      assert.notEqual((await delivery("reminder_deliveries", item.id)).send_started_at, null);
      await pool.query("UPDATE reminder_deliveries SET next_attempt_at=$2 WHERE id=$1", [item.id, when]);
      await dispatchDueReminderMessages(database, sender, config, later(11));
      await dispatchDueReminderMessages(database, sender, config, later(60));
      assert.equal(calls, 1, "an accepted message must not be duplicated to repair missing sent state");
      assert.deepEqual(await grant(item.grantId), originalGrant);
      assert.equal((await delivery("reminder_deliveries", item.id)).attempts, 1);
    });

    await t.test("inventory member removal after claim prevents send and preserves blocked state", async () => {
      const family = await group(1);
      const item = await stock(family, family.members[0]);
      const originalGrant = await grant(item.grantId);
      const gate = afterClaim(database, item.id);
      let calls = 0;
      const pending = track(dispatchDueReminderMessages(gate.database, {
        async send() { calls += 1; return { messageId: "must-not-send" }; },
      }, config, when));
      try {
        await bounded(gate.entered, "inventory claim committed");
        await removeMember(family, item.user);
        const cancelled = await delivery("reminder_deliveries", item.id);
        assert.equal(cancelled.status, "blocked");
        assert.equal(cancelled.send_started_at, null);
      } finally { gate.release(); await bounded(pending, "removed-member dispatch cleanup"); }
      assert.equal(calls, 0);
      const final = await delivery("reminder_deliveries", item.id);
      assert.equal(final.status, "blocked");
      assert.equal(final.last_error_code, "NOT_A_MEMBER");
      assert.equal(final.message_id, null);
      assert.deepEqual(await grant(item.grantId), originalGrant);
    });

    for (const editKind of ["package expiry", "after-opening deadline"]) {
      await t.test(`${editKind} edit after inventory claim prevents the old-deadline send`, async () => {
        const family = await group();
        const item = await stock(family);
        const originalGrant = await grant(item.grantId);
        if (editKind === "after-opening deadline") {
          // The package lasts another month; a seven-day opening limit is the
          // effective deadline today. The edit changes that calculated limit.
          await pool.query(`UPDATE medicine_batches
            SET expiry_value=($2::date + 30)::text, opened_state='opened', opened_at=$2::date - 7,
                after_opening_limit='{"value":7,"unit":"day"}'::jsonb, version=version+1
            WHERE id=$1`, [item.batchId, date]);
        }
        const before = (await pool.query("SELECT * FROM medicine_batches WHERE id=$1", [item.batchId])).rows[0];
        assert.equal(toBatchSummary(before, when).managementExpiryDate, date);
        const gate = afterClaim(database, item.id);
        const calls = [];
        const pending = track(dispatchDueReminderMessages(gate.database, {
          async send(message) { calls.push(message); return { messageId: "must-not-send-old-deadline" }; },
        }, config, when));
        try {
          await bounded(gate.entered, "inventory claim committed before deadline edit");
          assert.equal((await delivery("reminder_deliveries", item.id)).send_started_at, null);
          if (editKind === "package expiry") {
            await pool.query(`UPDATE medicine_batches
              SET expiry_value=($2::date + 7)::text, version=version+1 WHERE id=$1`, [item.batchId, date]);
          } else {
            await pool.query(`UPDATE medicine_batches
              SET after_opening_limit='{"value":14,"unit":"day"}'::jsonb, version=version+1 WHERE id=$1`, [item.batchId]);
          }
          const updated = (await pool.query("SELECT * FROM medicine_batches WHERE id=$1", [item.batchId])).rows[0];
          assert.equal(toBatchSummary(updated, when).managementExpiryDate, later(7 * 24 * 60).toISOString().slice(0, 10));
        } finally { gate.release(); await bounded(pending, "edited-deadline dispatch cleanup"); }
        assert.deepEqual(calls, [], "a claim-time cached deadline cannot authorize a stale reminder");
        const final = await delivery("reminder_deliveries", item.id);
        assert.equal(final.status, "blocked");
        assert.equal(final.send_started_at, null);
        assert.equal(final.message_id, null);
        assert.deepEqual(await grant(item.grantId), originalGrant);
      });
    }

    await t.test("quantity and storage edit after inventory claim preserves an unchanged-deadline send", async () => {
      const family = await group();
      const item = await stock(family);
      const gate = afterClaim(database, item.id);
      const calls = [];
      const pending = track(dispatchDueReminderMessages(gate.database, {
        async send(message) { calls.push(message); return { messageId: "unchanged-deadline-success" }; },
      }, config, when));
      try {
        await bounded(gate.entered, "inventory claim committed before ordinary edit");
        await pool.query(`UPDATE medicine_batches
          SET quantity=2, storage_location='上层药箱', version=version+1 WHERE id=$1`, [item.batchId]);
      } finally { gate.release(); await bounded(pending, "ordinary-edit dispatch cleanup"); }
      assert.equal((await pending).sent, 1);
      assert.equal(calls.length, 1, "an unrelated version change must not suppress a valid deadline reminder");
      assert.equal(calls[0].deadlineDate, date);
      const final = await delivery("reminder_deliveries", item.id);
      assert.equal(final.status, "sent");
      assert.equal(final.message_id, "unchanged-deadline-success");
      assert.notEqual(final.send_started_at, null);
      const edited = (await pool.query("SELECT version, quantity, storage_location FROM medicine_batches WHERE id=$1", [item.batchId])).rows[0];
      assert.equal(edited.version, 2);
      assert.equal(Number(edited.quantity), 2);
      assert.equal(edited.storage_location, "上层药箱");
    });

    await t.test("inventory boundary row lock serializes a later expiry edit after the durable send marker", async () => {
      const family = await group();
      const item = await stock(family);
      const calls = [];
      // contend() pauses after the first real lock is acquired, starts the
      // competing UPDATE, and verifies pg_blocking_pids before releasing it.
      // The boundary wins here; the later edit cannot recall a started message.
      const [dispatched, markerSeenByEdit] = await contend(fixture,
        /(?:\bFOR\s+SHARE\s+OF\s+b\b|\bUPDATE\s+medicine_batches\b)/i,
        () => dispatchDueReminderMessages(database, {
          async send(message) { calls.push(message); return { messageId: "boundary-before-edit" }; },
        }, config, when),
        () => database.withTransaction(async (tx) => {
          await tx.query(`UPDATE medicine_batches
            SET expiry_value=($2::date + 7)::text, version=version+1 WHERE id=$1`, [item.batchId, date]);
          return (await tx.query("SELECT send_started_at FROM reminder_deliveries WHERE id=$1", [item.id])).rows[0].send_started_at;
        }),
      );
      assert.notEqual(markerSeenByEdit, null, "the edit must observe the already committed send boundary");
      assert.equal(dispatched.sent, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].deadlineDate, date);
      const final = await delivery("reminder_deliveries", item.id);
      assert.equal(final.status, "sent");
      assert.equal(final.message_id, "boundary-before-edit");
      const edited = (await pool.query("SELECT expiry_value, version FROM medicine_batches WHERE id=$1", [item.batchId])).rows[0];
      assert.equal(edited.expiry_value, later(7 * 24 * 60).toISOString().slice(0, 10));
      assert.equal(edited.version, 2);
    });

    await t.test("inventory in-flight cancellation retains grant, prevents takeover and records actual success", async () => {
      const family = await group(1);
      const item = await stock(family, family.members[0]);
      const originalGrant = await grant(item.grantId);
      const gate = beforeSendCompletes();
      const pending = track(dispatchDueReminderMessages(database, gate.sender, config, when));
      try {
        await bounded(gate.entered, "inventory sender is in flight");
        assert.notEqual((await delivery("reminder_deliveries", item.id)).send_started_at, null);
        await removeMember(family, item.user);
        const during = await delivery("reminder_deliveries", item.id);
        assert.equal(during.status, "sending", "a started send cannot be represented as recalled");
        assert.equal(during.cancel_requested, true);
        assert.deepEqual(await grant(item.grantId), originalGrant);
        const competitor = await dispatchDueReminderMessages(database, {
          async send() { assert.fail("another worker must not reclaim a started delivery"); },
        }, config, later(6));
        assert.equal(competitor.sent, 0);
      } finally { gate.release(); await bounded(pending, "cancelled in-flight dispatch cleanup"); }
      assert.equal((await pending).sent, 1);
      assert.equal(gate.calls.length, 1);
      const final = await delivery("reminder_deliveries", item.id);
      assert.equal(final.status, "sent");
      assert.equal(final.cancel_requested, true);
      assert.equal(final.message_id, "original-in-flight-message");
      assert.equal(final.attempts, 1);
      assert.deepEqual(await grant(item.grantId), originalGrant);
    });

    await t.test("started eligible inventory delivery cannot be reclaimed after its lease expires", async () => {
      const family = await group();
      const item = await stock(family);
      const gate = beforeSendCompletes();
      const pending = track(dispatchDueReminderMessages(database, gate.sender, config, when));
      try {
        await bounded(gate.entered, "eligible inventory sender is in flight");
        const during = await delivery("reminder_deliveries", item.id);
        assert.notEqual(during.send_started_at, null);
        assert.equal(during.cancel_requested, false, "no cancellation predicate may mask a missing started-send guard");
        // Force the scheduling timestamp due even when PostgreSQL now() differs
        // from our injected Shanghai-noon scheduler clock.
        await pool.query("UPDATE reminder_deliveries SET next_attempt_at=$2 WHERE id=$1", [item.id, when]);
        await dispatchDueReminderMessages(database, {
          async send() { assert.fail("a started delivery cannot be reclaimed while its first request is unresolved"); },
        }, config, later(6));
        assert.equal((await delivery("reminder_deliveries", item.id)).attempts, 1);
      } finally { gate.release(); await bounded(pending, "eligible in-flight dispatch cleanup"); }
      assert.equal((await pending).sent, 1);
      assert.equal(gate.calls.length, 1);
      const final = await delivery("reminder_deliveries", item.id);
      assert.equal(final.message_id, "original-in-flight-message");
      assert.equal(final.status, "sent");
    });

    await t.test("expired pre-send inventory worker cannot send or overwrite newer worker", async () => {
      const family = await group();
      const item = await stock(family);
      const originalGrant = await grant(item.grantId);
      const gate = afterClaim(database, item.id);
      let staleCalls = 0;
      let newerCalls = 0;
      const pending = track(dispatchDueReminderMessages(gate.database, {
        async send() { staleCalls += 1; return { messageId: "stale-worker" }; },
      }, config, when));
      try {
        await bounded(gate.entered, "old inventory claim committed");
        const old = await delivery("reminder_deliveries", item.id);
        assert.equal(old.attempts, 1);
        assert.equal(old.send_started_at, null);
        const newer = await dispatchDueReminderMessages(database, {
          async send() { newerCalls += 1; return { messageId: "new-worker" }; },
        }, config, later(6));
        assert.equal(newer.sent, 1, "expired not-started work may be claimed by a new worker");
        const current = await delivery("reminder_deliveries", item.id);
        assert.equal(current.attempts, 2);
        assert.equal(current.message_id, "new-worker");
      } finally { gate.release(); await bounded(pending, "stale-worker dispatch cleanup"); }
      assert.equal(staleCalls, 0);
      assert.equal(newerCalls, 1);
      assert.equal((await pending).sent, 0);
      const final = await delivery("reminder_deliveries", item.id);
      assert.equal(final.status, "sent");
      assert.equal(final.attempts, 2);
      assert.equal(final.message_id, "new-worker");
      assert.deepEqual(await grant(item.grantId), originalGrant);
    });

    await t.test("ordinary successful inventory send stays sent and consumes exactly one grant", async () => {
      const family = await group();
      const item = await stock(family);
      const originalGrant = await grant(item.grantId);
      const calls = [];
      const sender = { async send(message) { calls.push(message); return { messageId: "normal-success" }; } };
      assert.equal((await dispatchDueReminderMessages(database, sender, config, when)).sent, 1);
      await dispatchDueReminderMessages(database, sender, config, later(11));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].openid, item.user.openid);
      const row = await delivery("reminder_deliveries", item.id);
      assert.equal(row.status, "sent");
      assert.equal(row.message_id, "normal-success");
      assert.notEqual(row.send_started_at, null);
      assert.notEqual(row.sent_at, null);
      assert.equal(row.attempts, 1);
      assert.equal(row.cancel_requested, false);
      assert.deepEqual(await grant(item.grantId), originalGrant);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM wechat_subscription_grants WHERE family_id=$1 AND consumed_at IS NOT NULL", [family.id])).rows[0].n, 1);
    });
  } finally {
    if (app !== undefined) await app.close();
    await fixture.close();
  }
});
