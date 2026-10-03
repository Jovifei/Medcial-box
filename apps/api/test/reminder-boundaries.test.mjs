// Behavioral regressions using the existing scripted pool. SQL effects are
// modeled for both the old and repaired implementation, so the same tests can
// produce red/green receipts against different built API roots. Real isolation
// and locking are covered by integration-pg-reminder-boundaries.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createFakePool } from "./helpers/fake-pool.mjs";
import { medicineRow, batchRow } from "./helpers/app.mjs";
const apiRoot = process.env.REMINDER_TEST_API_ROOT
  ? pathToFileURL(`${process.env.REMINDER_TEST_API_ROOT}/`)
  : new URL("../", import.meta.url);
const load = (file) => import(new URL(`dist/${file}`, apiRoot));
const { buildServer } = await load("app.js");
const { FakeWechatGateway } = await load("auth/wechat.js");
const { dispatchDoseReminders, queueDoseReminders } = await load("jobs/dose-reminder-scheduler.js");
const { dispatchDueReminderMessages, cancelDeliveriesForMember } = await load("jobs/reminder-scheduler.js");
const { createReminderTemplateConfig, WechatSubscribeMessageSender } = await load("services/subscribe-messages.js");
const config = createReminderTemplateConfig({ appId: "synthetic", appSecret: "synthetic", templateId: "stock-template", doseTemplateId: "dose-template" });
const now = new Date("2026-10-03T01:30:00Z");
const later = (minutes) => new Date(+now + minutes * 60_000);
const row = (value) => ({ rows: [value], rowCount: 1 });
const empty = { rows: [], rowCount: 0 };
function signal() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function preferences(pool, state) {
  pool.always(/INSERT INTO notification_preferences/, (_sql, params) => {
    state.preference = { stock_reminder_time: `${params[1]}:00`, channels: [...params[2]] }; return empty;
  });
  pool.always(/SELECT .*FROM notification_preferences WHERE user_id\s*=\s*\$1/, () => row({ ...state.preference, channels: [...state.preference.channels] }));
}
async function appFor(pool) {
  pool.always(/FROM sessions WHERE token_hash/, row({ id: "session-1", user_id: "user-1", expires_at: new Date(Date.now() + 86_400_000) }));
  pool.always(/FROM family_members WHERE user_id/, row({ id: "member-1", family_id: "family-1", user_id: "user-1", role: "owner" }));
  return buildServer({ database: pool, wechatGateway: new FakeWechatGateway(), reminderTemplateConfig: config, logger: false });
}
async function putPreferences(app, channels) {
  const response = await app.inject({ method: "PUT", url: "/api/v1/notification-preferences", headers: { authorization: "Bearer synthetic" }, payload: { stockReminderTime: "09:00", channels } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().preferences.channels, channels);
}
function baseState() {
  return { status: "queued", attempts: 0, next: +now, sendStarted: false, cancelRequested: false, isMember: true, grantConsumed: true, messageId: null, preference: { stock_reminder_time: "09:00:00", channels: ["wechat"] } };
}
function doseFixture() {
  const pool = createFakePool(); const state = baseState(); preferences(pool, state);
  pool.always(/WITH candidates AS .*dose_reminder_deliveries/, (_sql, params) => {
    if (!["queued", "failed", "sending"].includes(state.status) || state.sendStarted || state.cancelRequested || state.next > +params[0]) return empty;
    state.status = "sending"; state.attempts++; state.next = +params[0] + 300_000; return row({ id: "dose-1" });
  });
  pool.always(/SELECT d.id, d.user_id, u.openid.*FROM dose_reminder_deliveries/, () => row({
    id: "dose-1", user_id: "user-1", openid: "synthetic-user", plan_id: "plan-1", occurrence_id: "occurrence-1", attempts: state.attempts,
    dose_date: "2026-10-03", time_of_day: "09:25:00", subscription_grant_id: "grant-1", plan_status: "active", occurrence_status: "pending",
    occurrence_superseded: false, slot_active: true, schedule_still_covers: true, is_member: state.isMember, has_access: true,
  }));
  pool.always(/UPDATE dose_reminder_deliveries(?: d)? SET next_attempt_at = now\(\).*send_started_at = now\(\)/, (sql, params) => {
    if (state.attempts !== params[1] || state.status !== "sending" || state.cancelRequested) return empty;
    if (/send_started_at IS NULL/.test(sql) && state.sendStarted) return empty;
    if (/notification_preferences/.test(sql) && !state.preference.channels.includes("wechat")) return empty;
    if (/family_members/.test(sql) && !state.isMember) return empty;
    state.sendStarted = true; return row({ id: "dose-1" });
  });
  pool.always(/UPDATE dose_reminder_deliveries SET status = 'sent'/, (_sql, params) => {
    if (state.attempts !== params[2] || state.status !== "sending") return empty;
    state.status = "sent"; state.messageId = params[1]; return row({ id: "dose-1" });
  });
  pool.always(/UPDATE dose_reminder_deliveries SET status = 'failed'/, (_sql, params) => {
    if (state.attempts !== params[2] || state.status !== "sending") return empty;
    state.status = "failed"; state.next = +later(5); return row({ id: "dose-1" });
  });
  pool.always(/UPDATE dose_reminder_deliveries SET status = 'cancelled', next_attempt_at = now\(\)/, (_sql, params) => {
    assert.equal(params[0], "user-1");
    if (!["queued", "blocked"].includes(state.status)) return empty;
    state.status = "cancelled"; return row({ id: "dose-1", subscription_grant_id: "grant-1" });
  });
  pool.always(/UPDATE dose_reminder_deliveries SET cancel_requested = true/, (_sql, params) => {
    assert.equal(params[0], "user-1");
    if (!["sending", "failed"].includes(state.status) || state.cancelRequested) return empty;
    state.cancelRequested = true; return row({ id: "dose-1" });
  });
  pool.always(/UPDATE wechat_subscription_grants SET consumed_at = NULL/, (_sql, params) => {
    assert.deepEqual(params, ["grant-1", "dose-1"]); state.grantConsumed = false; return empty;
  });
  pool.always(/UPDATE dose_reminder_deliveries SET status = 'cancelled', last_error_code/, (sql, params) => {
    if (state.attempts !== params[1] || state.status !== "sending") return empty;
    if (/AND cancel_requested/.test(sql) && !state.cancelRequested) return empty;
    if (/send_started_at IS NULL/.test(sql) && state.sendStarted) return empty;
    state.status = "cancelled"; return row({ id: "dose-1" });
  });
  return { pool, state };
}
function stockFixture() {
  const pool = createFakePool(); const state = baseState(); preferences(pool, state);
  pool.always(/SELECT DISTINCT family_id FROM family_members/, row({ family_id: "family-1" }));
  pool.always(/FROM medicines WHERE family_id/, row(medicineRow()));
  state.batch = batchRow({ expiry_value: "2026-10-03" });
  pool.always(/FROM medicine_batches WHERE family_id/, () => row({ ...state.batch }));
  pool.always(/SELECT b.\* FROM medicine_batches b/, () => row({ ...state.batch }));
  pool.always(/SELECT fm.user_id FROM family_members fm LEFT JOIN notification_preferences/, () => state.isMember && state.preference.channels.includes("wechat") ? row({ user_id: "user-1" }) : empty);
  // Seeded delivery already owns its grant; no other usable grant is available.
  pool.always(/SELECT id FROM wechat_subscription_grants/, empty);
  const cancel = (sql) => {
    if (!["queued", "failed", "sending"].includes(state.status)) return empty;
    if (/NOT (?:d\.)?cancel_requested/.test(sql) && state.cancelRequested) return empty;
    if (!/CASE WHEN/.test(sql) || !state.sendStarted) state.status = "blocked";
    if (/cancel_requested = true/.test(sql)) state.cancelRequested = true;
    return row({ id: "stock-1" });
  };
  pool.always(/UPDATE reminder_deliveries d SET status = .*NOT EXISTS/, (sql) => state.isMember ? empty : cancel(sql));
  pool.always(/UPDATE reminder_deliveries SET status = .*WHERE family_id = \$1/, (sql, params) => {
    assert.deepEqual(params, ["family-1", "user-1"]); return cancel(sql);
  });
  pool.always(/WITH candidates AS .*FROM reminder_deliveries/, (sql, params) => {
    if (!["queued", "failed", "sending"].includes(state.status) || state.next > +params[0]) return empty;
    if (/send_started_at IS NULL/.test(sql) && state.sendStarted) return empty;
    if (/NOT cancel_requested/.test(sql) && state.cancelRequested) return empty;
    state.status = "sending"; state.attempts++; state.next = +params[0] + 300_000; return row({ id: "stock-1" });
  });
  pool.always(/SELECT d.id, d.user_id, u.openid.*FROM reminder_deliveries/, () => row({
    id: "stock-1", user_id: "user-1", openid: "synthetic-user", medicine_id: "medicine-1", medicine_name: "Synthetic inventory item",
    batch_id: "batch-1", deadline_date: "2026-10-03", days_before: 0, attempts: state.attempts, is_archived: false,
    medicine_deleted_at: null, batch_deleted_at: null, disposition_status: "active", is_member: state.isMember,
  }));
  pool.always(/UPDATE reminder_deliveries d SET send_started_at = now\(\)/, (_sql, params) => {
    if (state.attempts !== params[1] || state.status !== "sending" || state.sendStarted || state.cancelRequested || !state.isMember || !state.preference.channels.includes("wechat") || state.preference.stock_reminder_time > params[2]) return empty;
    state.sendStarted = true; return row({ id: "stock-1" });
  });
  pool.always(/UPDATE reminder_deliveries SET status = 'sent'/, (sql, params) => {
    if (/attempts = \$4/.test(sql) && (state.attempts !== params[3] || state.status !== "sending" || !state.sendStarted)) return empty;
    state.status = "sent"; state.messageId = params[1]; return row({ id: "stock-1" });
  });
  pool.always(/UPDATE reminder_deliveries SET status = \$2/, (_sql, params) => {
    state.status = params[1]; state.next = +params[2]; return row({ id: "stock-1" });
  });
  pool.always(/UPDATE reminder_deliveries SET status = 'failed'/, (_sql, params) => {
    if (state.attempts !== params[1] || state.status !== "sending" || !state.sendStarted) return empty;
    state.status = "failed"; return row({ id: "stock-1" });
  });
  pool.always(/UPDATE reminder_deliveries SET status\s*=\s*'blocked'/, (sql, params) => {
    if (/attempts = \$2/.test(sql) && (state.attempts !== params[1] || state.status !== "sending" || state.sendStarted)) return empty;
    state.status = "blocked"; return row({ id: "stock-1" });
  });
  return { pool, state };
}

test("disabling WeChat atomically cancels queued dose jobs and refunds their owned grant", async () => {
  for (const channels of [[], ["android"]]) {
    const { pool, state } = doseFixture(); const app = await appFor(pool);
    try {
      await putPreferences(app, channels);
      assert.equal(state.status, "cancelled"); assert.equal(state.grantConsumed, false);
      let sends = 0;
      await dispatchDoseReminders(pool, { async sendDose() { sends++; return { messageId: "unexpected" }; } }, config, now);
      assert.equal(sends, 0);
      const mutationCalls = pool.calls.filter((call) => /^(BEGIN|COMMIT)$|INSERT INTO notification_preferences|UPDATE dose_reminder_deliveries/.test(call.sql));
      assert.equal(mutationCalls[0].sql, "BEGIN");
      assert.equal(mutationCalls.findIndex((call) => call.sql === "COMMIT") > mutationCalls.findIndex((call) => /status = 'cancelled'/.test(call.sql)), true);
    } finally { await app.close(); }
  }
});

test("keeping WeChat enabled preserves normal dose dispatch and does not cancel queued work", async () => {
  const { pool, state } = doseFixture(); const app = await appFor(pool);
  try {
    await putPreferences(app, ["wechat", "android"]); assert.equal(state.status, "queued");
    const result = await dispatchDoseReminders(pool, { async sendDose() { return { messageId: "normal-dose" }; } }, config, now);
    assert.equal(result.sent, 1); assert.equal(state.grantConsumed, true);
  } finally { await app.close(); }
});

test("dose jobs inserted after an opt-out cancellation still fail the current-channel boundary", async () => {
  const { pool, state } = doseFixture(); state.preference.channels = [];
  let sends = 0;
  const result = await dispatchDoseReminders(pool, { async sendDose() { sends++; return { messageId: "unexpected" }; } }, config, now);
  assert.equal(sends, 0); assert.equal(result.cancelled, 1); assert.equal(state.status, "cancelled");
});

test("dose opt-out after claim prevents sender and retains conservative in-flight grant ownership", async () => {
  const { pool, state } = doseFixture(); const app = await appFor(pool); const base = pool.withTransaction.bind(pool); let changed = false;
  pool.withTransaction = async (fn) => {
    const result = await base(fn);
    if (!changed && state.status === "sending") { changed = true; await putPreferences(app, []); }
    return result;
  };
  try {
    let sends = 0;
    await dispatchDoseReminders(pool, { async sendDose() { sends++; return { messageId: "unexpected" }; } }, config, now);
    assert.equal(changed, true); assert.equal(sends, 0); assert.equal(state.grantConsumed, true); assert.equal(state.status, "cancelled");
  } finally { await app.close(); }
});

test("dose queue respects disabled channels and ambiguous dose attempts remain non-retryable", async () => {
  const { pool, state } = doseFixture(); state.preference.channels = [];
  pool.always(/SELECT o.id, o.family_id, o.plan_id/, row({ id: "occurrence-1", family_id: "family-1", plan_id: "plan-1", care_profile_id: "care-1", linked_user_id: "user-1", time_of_day: "09:25:00" }));
  pool.always(/SELECT user_id FROM family_members WHERE family_id/, row({ user_id: "user-1" }));
  assert.equal((await queueDoseReminders(pool, config, now)).queued, 0);
  assert.equal(pool.callsMatching(/INSERT INTO dose_reminder_deliveries/).length, 0);
  state.preference.channels = ["wechat"]; let sends = 0;
  const sender = { async sendDose() { sends++; throw new Error("Synthetic response lost"); } };
  await dispatchDoseReminders(pool, sender, config, now); await dispatchDoseReminders(pool, sender, config, later(11));
  assert.equal(sends, 1); assert.equal(state.grantConsumed, true);
});

test("ambiguous inventory HTTP POST is never automatically posted a second time", async () => {
  const { pool, state } = stockFixture(); let acceptedPosts = 0;
  const sender = new WechatSubscribeMessageSender(config, async (url, options) => {
    if (new URL(url).pathname.endsWith("/token")) return new globalThis.Response(JSON.stringify({ access_token: "synthetic-token", expires_in: 7200 }), { status: 200 });
    assert.equal(options.method, "POST"); acceptedPosts++;
    throw new TypeError("Synthetic server accepted message, response connection lost");
  });
  assert.equal((await dispatchDueReminderMessages(pool, sender, config, now)).failed, 1);
  await dispatchDueReminderMessages(pool, sender, config, later(11));
  assert.equal(acceptedPosts, 1); assert.equal(state.sendStarted, true); assert.equal(state.grantConsumed, true);
});

test("inventory sender success followed by failed DB settlement never retries external send", async () => {
  const { pool, state } = stockFixture(); const base = pool.query.bind(pool); let failed = false; let sends = 0;
  pool.query = async (sql, params) => {
    if (!failed && /UPDATE reminder_deliveries SET status = 'sent'/.test(sql)) { failed = true; throw new Error("Synthetic settlement failure"); }
    return base(sql, params);
  };
  const sender = { async send() { sends++; return { messageId: "delivered" }; } };
  await dispatchDueReminderMessages(pool, sender, config, now); await dispatchDueReminderMessages(pool, sender, config, later(11));
  assert.equal(sends, 1); assert.equal(state.sendStarted, true); assert.equal(state.grantConsumed, true);
});

test("inventory member removal between claim and send blocks the external call", async () => {
  const { pool, state } = stockFixture(); const base = pool.query.bind(pool); let removed = false; let sends = 0;
  pool.query = async (sql, params) => {
    if (!removed && /SELECT stock_reminder_time::text, channels FROM notification_preferences/.test(sql)) {
      removed = true; state.isMember = false; await cancelDeliveriesForMember(pool, "family-1", "user-1");
    }
    return base(sql, params);
  };
  await dispatchDueReminderMessages(pool, { async send() { sends++; return { messageId: "unexpected" }; } }, config, now);
  assert.equal(sends, 0); assert.equal(state.status, "blocked");
});

test("inventory boundary rechecks opt-out after the earlier preference read", async () => {
  const { pool, state } = stockFixture(); const app = await appFor(pool); const base = pool.query.bind(pool); let changed = false; let sends = 0;
  pool.query = async (sql, params) => {
    const result = await base(sql, params);
    if (!changed && /SELECT stock_reminder_time::text, channels FROM notification_preferences/.test(sql)) { changed = true; await putPreferences(app, []); }
    return result;
  };
  try {
    await dispatchDueReminderMessages(pool, { async send() { sends++; return { messageId: "unexpected" }; } }, config, now);
    assert.equal(sends, 0); assert.equal(state.status, "blocked");
  } finally { await app.close(); }
});

test("an expired pre-send inventory lease cannot send or overwrite its successor", async () => {
  const { pool, state } = stockFixture(); const base = pool.query.bind(pool); const reached = signal(); const release = signal(); let reads = 0; let sends = 0;
  pool.query = async (sql, params) => {
    if (/SELECT stock_reminder_time::text, channels FROM notification_preferences/.test(sql) && reads++ === 0) { reached.resolve(); await release.promise; }
    return base(sql, params);
  };
  const first = dispatchDueReminderMessages(pool, { async send() { sends++; return { messageId: "stale-worker" }; } }, config, now);
  await reached.promise;
  try {
    const second = await dispatchDueReminderMessages(pool, { async send() { sends++; return { messageId: "current-worker" }; } }, config, later(6));
    assert.equal(second.sent, 1);
  } finally { release.resolve(); }
  assert.equal((await first).sent, 0); assert.equal(sends, 1); assert.equal(state.messageId, "current-worker");
});

test("inventory cancellation after send starts retains the grant and records actual success", async () => {
  const { pool, state } = stockFixture(); const reached = signal(); const release = signal();
  const pending = dispatchDueReminderMessages(pool, { async send() { reached.resolve(); await release.promise; return { messageId: "in-flight-success" }; } }, config, now);
  await reached.promise;
  try {
    state.isMember = false; await cancelDeliveriesForMember(pool, "family-1", "user-1");
    assert.equal(state.status, "sending"); assert.equal(state.cancelRequested, true); assert.equal(state.grantConsumed, true);
  } finally { release.resolve(); }
  assert.equal((await pending).sent, 1); assert.equal(state.status, "sent"); assert.equal(state.grantConsumed, true);
});

test("an old inventory sender cannot settle over a different attempt owner", async () => {
  const { pool, state } = stockFixture(); const reached = signal(); const release = signal();
  const pending = dispatchDueReminderMessages(pool, { async send() { reached.resolve(); await release.promise; return { messageId: "stale-result" }; } }, config, now);
  await reached.promise; state.attempts++; release.resolve();
  assert.equal((await pending).sent, 0); assert.equal(state.messageId, null);
});


for (const kind of ["package expiry", "opening deadline", "quantity and location"]) {
  test(`inventory current-deadline barrier handles a ${kind} edit after claim`, async () => {
    const { pool, state } = stockFixture(); const base = pool.withTransaction.bind(pool); let changed = false; let sends = 0;
    pool.withTransaction = async (fn) => {
      const result = await base(fn);
      if (!changed && Array.isArray(result) && result.some((item) => item.id === "stock-1" && item.openid)) {
        changed = true;
        if (kind === "package expiry") state.batch.expiry_value = "2026-10-04";
        if (kind === "opening deadline") state.batch.after_opening_limit = { date: "2026-10-02", source: "confirmed" };
        if (kind === "quantity and location") { state.batch.quantity = 7; state.batch.storage_location = "another cupboard"; }
        state.batch.version++;
      }
      return result;
    };
    const result = await dispatchDueReminderMessages(pool, { async send() { sends++; return { messageId: "current-deadline" }; } }, config, now);
    const expected = kind === "quantity and location" ? 1 : 0;
    assert.equal(changed, true); assert.equal(sends, expected); assert.equal(result.sent, expected);
    assert.equal(state.status, expected ? "sent" : "blocked");
  });
}
