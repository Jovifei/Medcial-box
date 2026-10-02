// R4 服药提醒的真实 PostgreSQL 验证（独立进程）。
// 覆盖：到点未确认才排队、无授权不排队、确认后取消、暂停/结束后取消、
// 发送前复核权限与成员身份、超时旧事件不补发。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { applyMigrations } from "../dist/db/migrations.js";
import { buildServer } from "../dist/app.js";
import {
  dispatchDoseReminders,
  queueDoseReminders,
  shanghaiClock,
} from "../dist/jobs/dose-reminder-scheduler.js";
import { createReminderTemplateConfig } from "../dist/services/subscribe-messages.js";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { isolatedPostgres } from "./helpers/isolated-pg.mjs";

const url = process.env.TEST_DATABASE_URL?.trim() ?? "";
const required = process.env.REQUIRE_POSTGRES_TESTS === "1";
const DOSE_TEMPLATE = "synthetic-dose-template";
const REMINDER_TEMPLATE = "synthetic-reminder-template";

function status(response, expected) {
  assert.equal(response.statusCode, expected, response.body);
  return expected === 204 ? null : response.json();
}

/** 把"现在"固定在上海时间某个 HH:MM，让时间点是否到点可预测。 */
function atShanghaiMinutes(minutes) {
  const clock = shanghaiClock(new Date());
  const base = new Date(`${clock.date}T00:00:00Z`);
  // 上海 00:00 = 前一天 16:00 UTC；用 date+8h 的方式折算出目标时刻的 UTC 时间。
  return new Date(base.getTime() + (minutes - 8 * 60) * 60 * 1000);
}

/** 轮询等待某个同步条件成立（用于让 dispatch 停在受控 sender 屏障处）。 */
async function waitFor(predicate, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

test("real PostgreSQL: dose reminders (R4)", {
  skip: !url && !required ? "TEST_DATABASE_URL absent: optional local PostgreSQL suite" : false,
  concurrency: 1,
}, async (t) => {
  assert.ok(url, "REQUIRE_POSTGRES_TESTS=1 requires TEST_DATABASE_URL; real PostgreSQL cannot be skipped");
  const fixture = await isolatedPostgres(url);
  const { pool, database } = fixture;
  const gateway = createTestGateway();
  let app;
  try {
    await applyMigrations(pool);
    const config = createReminderTemplateConfig({
      appId: "synthetic-app-id",
      appSecret: "synthetic-secret",
      templateId: REMINDER_TEMPLATE,
      doseTemplateId: DOSE_TEMPLATE,
    });
    assert.equal(config.doseAvailable, true);
    app = await buildServer({ database, wechatGateway: gateway, reminderTemplateConfig: config, logger: { level: "error" } });
    const request = (user, method, path, payload) => app.inject({ method, url: `/api/v1${path}`, headers: { authorization: `Bearer ${user.token}` }, ...(payload === undefined ? {} : { payload }) });
    async function user() {
      const code = randomUUID();
      gateway.registerCode(code, `dose-${code}`);
      const auth = status(await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: { code } }), 200);
      return { token: auth.token, id: auth.user.id };
    }
    async function family(memberCount = 0) {
      const owner = await user();
      const created = status(await request(owner, "POST", "/families", { name: `家庭-${randomUUID()}` }), 201);
      const members = [];
      for (let i = 0; i < memberCount; i++) {
        const member = await user();
        const invite = status(await request(owner, "POST", "/families/invitations"), 201);
        status(await request(member, "POST", "/families/invitations/accept", { code: invite.invitationCode }), 200);
        members.push(member);
      }
      return { owner, members, id: created.family.id };
    }
    const clock = shanghaiClock(new Date());
    async function grantDoseSubscription(member) {
      await pool.query(
        "INSERT INTO wechat_subscription_grants (family_id, user_id, template_id) VALUES ($1, $2, $3)",
        [(await familyOf(member)), member.id, DOSE_TEMPLATE],
      );
    }
    const familyIds = new Map();
    async function familyOf(member) {
      const row = (await pool.query("SELECT family_id FROM family_members WHERE user_id = $1", [member.id])).rows[0];
      familyIds.set(member.id, row.family_id);
      return row.family_id;
    }
    const sent = [];
    const sender = {
      async sendDose(message) {
        sent.push(message);
        return { messageId: `msg-${sent.length}` };
      },
    };

    await t.test("migration 018 adds the dose reminder table", async () => {
      const tables = (await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
        [fixture.schema, "dose_reminder_deliveries"],
      )).rows;
      assert.equal(tables.length, 1);
    });

    await t.test("no subscription grant means nothing is queued", async () => {
      const group = await family(0);
      const self = status(await request(group.owner, "POST", "/care-profiles", { displayName: "我自己", linkedUserId: group.owner.id }), 201);
      status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: self.id, medicineName: "提醒测试药", dosageText: "1 粒",
        timeSlots: ["00:01"], startDate: "2026-01-01",
      }), 201);
      const result = await queueDoseReminders(database, config, atShanghaiMinutes(30));
      assert.equal(result.queued, 0);
      assert.equal(result.skippedNoGrant >= 1, true, "没有授权时记为跳过，而不是假装排队");
      const statusBody = status(await request(group.owner, "GET", "/medication-plans/reminders/status"), 200);
      assert.equal(statusBody.available, true);
      assert.deepEqual(statusBody.deliveries, []);
    });

    await t.test("B05: three grants + repeated queueing rounds consume exactly one grant", async () => {
      const group = await family(0);
      const self = status(await request(group.owner, "POST", "/care-profiles/self", { displayName: "我自己" }), 201);
      status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: self.id, medicineName: "重复排队药", dosageText: "1 片",
        timeSlots: ["00:02"], startDate: "2026-01-01",
      }), 201);
      for (let i = 0; i < 3; i += 1) await grantDoseSubscription(group.owner);
      const when = atShanghaiMinutes(30);
      // 连续 3 轮排队（模拟多 worker / 多轮调度）
      for (let round = 0; round < 3; round += 1) {
        const result = await queueDoseReminders(database, config, when);
        if (round === 0) assert.equal(result.queued, 1, "first round queues once");
        else assert.equal(result.queued, 0, "later rounds must not queue again");
      }
      const deliveries = (await pool.query("SELECT id FROM dose_reminder_deliveries")).rows;
      assert.equal(deliveries.length, 1, "same occurrence + user dedupes to one delivery");
      const consumed = (await pool.query(
        "SELECT count(*)::int AS n FROM wechat_subscription_grants WHERE family_id = $1 AND consumed_at IS NOT NULL",
        [group.id],
      )).rows[0].n;
      assert.equal(consumed, 1, "exactly one grant is consumed despite repeated queueing");
      // 清理：停用本家庭全部计划（取消投递），断开投递对授权的引用后删除剩余授权，防止跨测试串扰。
      await pool.query("UPDATE medication_plans SET status = 'paused' WHERE family_id = $1", [group.id]);
      await pool.query("UPDATE dose_reminder_deliveries SET status = 'cancelled' WHERE family_id = $1 AND status IN ('queued', 'sending')", [group.id]);
      await pool.query(
        `UPDATE dose_reminder_deliveries d SET subscription_grant_id = NULL
         FROM wechat_subscription_grants g WHERE d.subscription_grant_id = g.id AND g.family_id = $1`,
        [group.id],
      );
      await pool.query("DELETE FROM wechat_subscription_grants WHERE family_id = $1", [group.id]);
    });

    await t.test("B06: reschedule cancels the old 08:00 delivery and only 09:00 sends", async () => {
      const group = await family(0);
      const self = status(await request(group.owner, "POST", "/care-profiles/self", { displayName: "我自己" }), 201);
      const plan = status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: self.id, medicineName: "改期药", dosageText: "1 片",
        timeSlots: ["00:03"], startDate: "2026-01-01",
      }), 201);
      await grantDoseSubscription(group.owner);
      const when = atShanghaiMinutes(30);
      await queueDoseReminders(database, config, when);
      // 改期：00:03 → 23:58（仍是"今天"语义，验证旧时间点的投递被取消）
      const detail = status(await request(group.owner, "GET", `/medication-plans/${plan.planId}`), 200);
      status(await request(group.owner, "PUT", `/medication-plans/${plan.planId}`, {
        version: detail.plan.version, timeSlots: ["23:58"],
      }), 200);
      const rows = (await pool.query(
        "SELECT status, time_of_day::text AS t FROM dose_reminder_deliveries WHERE plan_id = $1",
        [plan.planId],
      )).rows;
      assert.ok(rows.every((row) => row.status === "cancelled"), `old delivery must be cancelled: ${JSON.stringify(rows)}`);
      // 发送轮：不向已取消投递发送
      const before = sent.length;
      await dispatchDoseReminders(database, sender, config, when);
      assert.equal(sent.length, before, "no message may go out for a superseded occurrence");
      // 新时间点尚未到点（23:58），今天不应排队 23:58
      const requeued = await queueDoseReminders(database, config, when);
      assert.equal(requeued.queued, 0, "the new time has not come due yet");
    });

    await t.test("due pending occurrence is queued once per recipient and sent", async () => {
      const group = await family(0);
      const self = status(await request(group.owner, "POST", "/care-profiles", { displayName: "我自己", linkedUserId: group.owner.id }), 201);
      const plan = status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: self.id, medicineName: "早上的药", dosageText: "1 粒",
        timeSlots: ["00:05"], startDate: "2026-01-01",
      }), 201);
      await grantDoseSubscription(group.owner);
      const queued = await queueDoseReminders(database, config, atShanghaiMinutes(30));
      assert.equal(queued.queued, 1);
      const rows = (await pool.query(
        "SELECT status FROM dose_reminder_deliveries WHERE plan_id = $1", [plan.planId],
      )).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "queued");

      // 重复排队不会重复消耗授权
      const again = await queueDoseReminders(database, config, atShanghaiMinutes(31));
      assert.equal(again.queued, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS c FROM dose_reminder_deliveries WHERE plan_id = $1", [plan.planId])).rows[0].c, 1);

      const result = await dispatchDoseReminders(database, sender, config, atShanghaiMinutes(31));
      assert.equal(result.sent, 1);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].timeText, "00:05");
      assert.match(sent[0].page, /medication-plans/);
      const after = (await pool.query("SELECT status, message_id FROM dose_reminder_deliveries WHERE plan_id = $1", [plan.planId])).rows[0];
      assert.equal(after.status, "sent");
      assert.ok(after.message_id);
      const reported = status(await request(group.owner, "GET", "/medication-plans/reminders/status"), 200);
      assert.equal(reported.deliveries[0].statusLabel, "已发送");
    });

    await t.test("confirming a dose cancels the queued reminder and returns the grant", async () => {
      sent.length = 0;
      const group = await family(0);
      const self = status(await request(group.owner, "POST", "/care-profiles", { displayName: "我自己", linkedUserId: group.owner.id }), 201);
      status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: self.id, medicineName: "待确认的药", dosageText: "1 粒",
        timeSlots: ["00:10"], startDate: "2026-01-01",
      }), 201);
      await grantDoseSubscription(group.owner);
      await queueDoseReminders(database, config, atShanghaiMinutes(40));
      const schedule = status(await request(group.owner, "GET", `/medication-plans/schedule?date=${clock.date}`), 200);
      const occurrenceId = schedule.entries[0].occurrenceId;
      status(await request(group.owner, "POST", `/dose-occurrences/${occurrenceId}/confirm`, {
        action: "taken", idempotencyKey: `dose-${randomUUID()}`,
      }), 200);
      const rows = (await pool.query("SELECT status, subscription_grant_id FROM dose_reminder_deliveries WHERE occurrence_id = $1", [occurrenceId])).rows;
      assert.equal(rows[0].status, "cancelled");
      const grant = (await pool.query("SELECT consumed_at FROM wechat_subscription_grants WHERE id = $1", [rows[0].subscription_grant_id])).rows[0];
      assert.equal(grant.consumed_at, null, "用户主动确认后应退还一次性授权");
      const result = await dispatchDoseReminders(database, sender, config, atShanghaiMinutes(41));
      assert.equal(result.sent, 0);
      assert.equal(sent.length, 0, "确认后不能再收到提醒");
    });

    await t.test("pausing a plan cancels queued reminders", async () => {
      sent.length = 0;
      const group = await family(0);
      const self = status(await request(group.owner, "POST", "/care-profiles", { displayName: "我自己", linkedUserId: group.owner.id }), 201);
      const plan = status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: self.id, medicineName: "暂停前排队", dosageText: "1 粒",
        timeSlots: ["00:15"], startDate: "2026-01-01",
      }), 201);
      await grantDoseSubscription(group.owner);
      await queueDoseReminders(database, config, atShanghaiMinutes(50));
      assert.equal((await pool.query("SELECT count(*)::int AS c FROM dose_reminder_deliveries WHERE plan_id = $1 AND status = 'queued'", [plan.planId])).rows[0].c, 1);
      status(await request(group.owner, "POST", `/medication-plans/${plan.planId}/pause`, { version: 1 }), 200);
      const rows = (await pool.query("SELECT status FROM dose_reminder_deliveries WHERE plan_id = $1", [plan.planId])).rows;
      assert.equal(rows[0].status, "cancelled");
      const result = await dispatchDoseReminders(database, sender, config, atShanghaiMinutes(51));
      assert.equal(result.sent, 0);
    });

    await t.test("stale occurrences outside the window are dropped, not burst-sent", async () => {
      sent.length = 0;
      const group = await family(0);
      const self = status(await request(group.owner, "POST", "/care-profiles", { displayName: "我自己", linkedUserId: group.owner.id }), 201);
      status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: self.id, medicineName: "很早的药", dosageText: "1 粒",
        timeSlots: ["00:00"], startDate: "2026-01-01",
      }), 201);
      await grantDoseSubscription(group.owner);
      // 先排队，再等到远超窗口的时刻：补发必须被拦下。
      await queueDoseReminders(database, config, atShanghaiMinutes(20));
      const result = await dispatchDoseReminders(database, sender, config, atShanghaiMinutes(8 * 60));
      assert.equal(result.sent, 0);
      assert.equal(result.cancelled >= 1, true, "超时旧事件应被取消而不是集中补发");
      assert.equal(sent.length, 0);
    });

    await t.test("revoking a grant cancels queued reminders for that member", async () => {
      sent.length = 0;
      const group = await family(1);
      const member = group.members[0];
      const child = status(await request(group.owner, "POST", "/care-profiles", { displayName: "孩子" }), 201);
      status(await request(group.owner, "POST", `/care-profiles/${child.id}/grants`, { memberUserId: member.id, canManage: false }), 200);
      status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: child.id, medicineName: "孩子的药", dosageText: "5ml",
        timeSlots: ["00:20"], startDate: "2026-01-01",
      }), 201);
      await grantDoseSubscription(member);
      await queueDoseReminders(database, config, atShanghaiMinutes(60));
      const before = (await pool.query(
        "SELECT count(*)::int AS c FROM dose_reminder_deliveries WHERE user_id = $1", [member.id],
      )).rows[0].c;
      assert.equal(before, 1);
      status(await request(group.owner, "DELETE", `/care-profiles/${child.id}/grants/${member.id}`), 200);
      const after = (await pool.query(
        "SELECT status FROM dose_reminder_deliveries WHERE user_id = $1", [member.id],
      )).rows[0];
      assert.equal(after.status, "cancelled");
      const result = await dispatchDoseReminders(database, sender, config, atShanghaiMinutes(61));
      assert.equal(result.sent, 0);
      assert.equal(sent.length, 0);
    });

    await t.test("reminder status reports template unavailability honestly", async () => {
      const group = await family(0);
      const minimal = await buildServer({
        database,
        wechatGateway: gateway,
        reminderTemplateConfig: createReminderTemplateConfig({
          appId: "synthetic-app-id", appSecret: "synthetic-secret", templateId: REMINDER_TEMPLATE,
        }),
        logger: { level: "error" },
      });
      const body = status(await minimal.inject({
        method: "GET", url: "/api/v1/medication-plans/reminders/status",
        headers: { authorization: `Bearer ${group.owner.token}` },
      }), 200);
      assert.equal(body.available, false);
      assert.match(body.reason, /模板/);
      await minimal.close();
    });

    await t.test("R05: editing a plan while a delivery is in flight keeps the grant consumed", async () => {
      sent.length = 0;
      const group = await family(0);
      const self = status(await request(group.owner, "POST", "/care-profiles/self", { displayName: "我自己" }), 201);
      const plan = status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: self.id, medicineName: "在途编辑药", dosageText: "1 片",
        timeSlots: ["00:40"], startDate: "2026-01-01",
      }), 201);
      await grantDoseSubscription(group.owner);
      await queueDoseReminders(database, config, atShanghaiMinutes(45));

      // 受控 sender 屏障：让 dispatch 停在"已越过领取、正在发送"的窗口内。
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let entered = 0;
      const blockingSender = {
        async sendDose(message) {
          sent.push(message);
          entered += 1;
          await gate;
          return { messageId: `msg-inflight-${entered}` };
        },
      };
      const when = atShanghaiMinutes(50);
      const dispatchPromise = dispatchDoseReminders(database, blockingSender, config, when);
      let result;
      try {
        assert.equal(await waitFor(() => entered === 1), true, "sender should be in flight");
        const sendingRow = (await pool.query(
          "SELECT status FROM dose_reminder_deliveries WHERE plan_id = $1", [plan.planId],
        )).rows[0];
        assert.equal(sendingRow.status, "sending");

        // 在途改期：统一取消入口只应标 cancel_requested，不退授权、不改终态。
        const detail = status(await request(group.owner, "GET", `/medication-plans/${plan.planId}`), 200);
        status(await request(group.owner, "PUT", `/medication-plans/${plan.planId}`, {
          version: detail.plan.version, timeSlots: ["23:58"],
        }), 200);
        const during = (await pool.query(
          "SELECT status, cancel_requested, subscription_grant_id FROM dose_reminder_deliveries WHERE plan_id = $1",
          [plan.planId],
        )).rows[0];
        assert.equal(during.status, "sending", "in-flight status must not be flipped by a cancel");
        assert.equal(during.cancel_requested, true, "cancel must be recorded as requested");
        const duringGrant = (await pool.query(
          "SELECT consumed_at FROM wechat_subscription_grants WHERE id = $1", [during.subscription_grant_id],
        )).rows[0];
        assert.notEqual(duringGrant.consumed_at, null, "an in-flight grant must NOT be refunded (R05)");
      } finally {
        release();
      }
      result = await dispatchPromise;
      // sender 最终成功：消息已越过发送边界无法撤回，落 sent，授权保持消费。
      assert.equal(result.sent, 1);
      const after = (await pool.query(
        "SELECT status, cancel_requested, subscription_grant_id FROM dose_reminder_deliveries WHERE plan_id = $1",
        [plan.planId],
      )).rows[0];
      assert.equal(after.status, "sent", "a successful send is recorded even though a cancel was requested");
      const afterGrant = (await pool.query(
        "SELECT consumed_at FROM wechat_subscription_grants WHERE id = $1", [after.subscription_grant_id],
      )).rows[0];
      assert.notEqual(afterGrant.consumed_at, null, "a genuinely sent message keeps its grant consumed (R05)");
    });

    await t.test("R05: cancel during an ambiguous send keeps the grant consumed and never re-notifies", async () => {
      sent.length = 0;
      const group = await family(0);
      const self = status(await request(group.owner, "POST", "/care-profiles/self", { displayName: "我自己" }), 201);
      const plan = status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: self.id, medicineName: "模糊发送药", dosageText: "1 片",
        timeSlots: ["00:41"], startDate: "2026-01-01",
      }), 201);
      await grantDoseSubscription(group.owner);
      await queueDoseReminders(database, config, atShanghaiMinutes(45));

      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let entered = 0;
      const failingSender = {
        async sendDose() {
          entered += 1;
          await gate;
          // 结果不确定：请求可能已到达微信，只是响应超时。
          throw new Error("network timeout after WeChat may have received it");
        },
      };
      const dispatchPromise = dispatchDoseReminders(database, failingSender, config, atShanghaiMinutes(50));
      let result;
      try {
        assert.equal(await waitFor(() => entered === 1), true, "sender should be in flight");
        // 在途确认服药：标 cancel_requested，不退授权。
        const schedule = status(await request(group.owner, "GET", `/medication-plans/schedule?date=${clock.date}`), 200);
        const occurrence = schedule.entries.find((entry) => entry.planId === plan.planId) ?? schedule.entries[0];
        status(await request(group.owner, "POST", `/dose-occurrences/${occurrence.occurrenceId}/confirm`, {
          action: "taken", idempotencyKey: `dose-${randomUUID()}`,
        }), 200);
      } finally {
        release();
      }
      result = await dispatchPromise;
      assert.equal(result.sent, 0, "an ambiguous failure must not count as sent");
      const after = (await pool.query(
        "SELECT status, cancel_requested, subscription_grant_id FROM dose_reminder_deliveries WHERE plan_id = $1",
        [plan.planId],
      )).rows[0];
      assert.equal(after.cancel_requested, true);
      assert.notEqual(after.status, "sent");
      const grant = (await pool.query(
        "SELECT consumed_at FROM wechat_subscription_grants WHERE id = $1", [after.subscription_grant_id],
      )).rows[0];
      assert.notEqual(grant.consumed_at, null, "an uncertain result keeps the grant consumed (not reused)");
      // 再跑一轮：cancel_requested 的投递不会被重新领取，不会重复通知。
      const before = sent.length;
      await dispatchDoseReminders(database, failingSender, config, atShanghaiMinutes(51));
      assert.equal(sent.length, before, "a cancelled in-flight delivery must not be re-dispatched");
    });

    await t.test("R05: a stale worker's send result cannot overwrite a newer lease", async () => {
      sent.length = 0;
      const group = await family(0);
      const self = status(await request(group.owner, "POST", "/care-profiles/self", { displayName: "我自己" }), 201);
      const plan = status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: self.id, medicineName: "租约药", dosageText: "1 片",
        timeSlots: ["00:43"], startDate: "2026-01-01",
      }), 201);
      await grantDoseSubscription(group.owner);
      await queueDoseReminders(database, config, atShanghaiMinutes(45));

      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let entered = 0;
      const blockingSender = {
        async sendDose(message) {
          sent.push(message);
          entered += 1;
          await gate;
          return { messageId: `msg-stale-${entered}` };
        },
      };
      const dispatchPromise = dispatchDoseReminders(database, blockingSender, config, atShanghaiMinutes(50));
      let result;
      try {
        assert.equal(await waitFor(() => entered === 1), true, "sender should be in flight");
        // 模拟租约被新 worker 接管：attempts 前进，旧 worker 仍停在 attempts=1。
        await pool.query("UPDATE dose_reminder_deliveries SET attempts = attempts + 1 WHERE plan_id = $1", [plan.planId]);
      } finally {
        release();
      }
      result = await dispatchPromise;
      assert.equal(result.sent, 0, "a stale worker must not record a send it no longer owns");
      const after = (await pool.query(
        "SELECT status, message_id FROM dose_reminder_deliveries WHERE plan_id = $1", [plan.planId],
      )).rows[0];
      assert.notEqual(after.status, "sent", "a stale result must not overwrite the newer lease");
      assert.equal(after.message_id, null);
    });

    await t.test("R05: ten queue+dispatch rounds consume exactly one grant and send once", async () => {
      sent.length = 0;
      const group = await family(0);
      const self = status(await request(group.owner, "POST", "/care-profiles/self", { displayName: "我自己" }), 201);
      const plan = status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: self.id, medicineName: "重复调度药", dosageText: "1 片",
        timeSlots: ["00:42"], startDate: "2026-01-01",
      }), 201);
      await grantDoseSubscription(group.owner);
      const when = atShanghaiMinutes(50);
      for (let round = 0; round < 10; round += 1) {
        await queueDoseReminders(database, config, when);
        await dispatchDoseReminders(database, sender, config, when);
      }
      assert.equal(sent.length, 1, "exactly one message across ten rounds");
      const consumed = (await pool.query(
        "SELECT count(*)::int AS n FROM wechat_subscription_grants WHERE family_id = $1 AND consumed_at IS NOT NULL",
        [group.id],
      )).rows[0].n;
      assert.equal(consumed, 1, "exactly one grant consumed across ten rounds");
      const deliveries = (await pool.query("SELECT id FROM dose_reminder_deliveries WHERE plan_id = $1", [plan.planId])).rows;
      assert.equal(deliveries.length, 1);
    });
  } finally {
    if (app !== undefined) await app.close();
    await fixture.close();
  }
});
