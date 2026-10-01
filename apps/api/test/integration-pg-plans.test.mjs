// R3 用药计划的真实 PostgreSQL 验证（独立进程，避免登录限流共享配额）。
// 覆盖：照护对象私有性、授权查看/管理、今日安排懒物化、幂等确认与纠正留痕、
// 版本冲突、暂停后不再物化、结束保留历史。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { applyMigrations } from "../dist/db/migrations.js";
import { buildServer } from "../dist/app.js";
import { createReminderTemplateConfig } from "../dist/services/subscribe-messages.js";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { isolatedPostgres } from "./helpers/isolated-pg.mjs";

const url = process.env.TEST_DATABASE_URL?.trim() ?? "";
const required = process.env.REQUIRE_POSTGRES_TESTS === "1";

function status(response, expected) {
  assert.equal(response.statusCode, expected, response.body);
  return expected === 204 ? null : response.json();
}

test("real PostgreSQL: medication plans with care profiles (R3)", {
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
    app = await buildServer({
      database,
      wechatGateway: gateway,
      reminderTemplateConfig: createReminderTemplateConfig({
        appId: "synthetic-app-id",
        appSecret: "synthetic-secret",
        templateId: "synthetic-reminder-template",
      }),
      logger: { level: "error" },
    });
    const request = (user, method, path, payload) => app.inject({ method, url: `/api/v1${path}`, headers: { authorization: `Bearer ${user.token}` }, ...(payload === undefined ? {} : { payload }) });
    async function user() {
      const code = randomUUID();
      gateway.registerCode(code, `plans-${code}`);
      const auth = status(await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: { code } }), 200);
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

    await t.test("migration 016 adds the five plan tables", async () => {
      const tables = (await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1
           AND table_name = ANY($2::text[]) ORDER BY table_name`,
        [fixture.schema, ["care_profiles", "care_grants", "medication_plans", "plan_time_slots", "dose_confirmations", "dose_occurrences"]],
      )).rows.map((row) => row.table_name);
      assert.deepEqual(tables, ["care_grants", "care_profiles", "dose_confirmations", "dose_occurrences", "medication_plans", "plan_time_slots"]);
    });

    await t.test("own linked profile is private: other members cannot see it or its schedule", async () => {
      const group = await family(1);
      const member = group.members[0];
      const mine = status(await request(group.owner, "POST", "/care-profiles", { displayName: "我自己", linkedUserId: group.owner.id }), 201);
      assert.equal(mine.isPrivate, true);
      // 代创建他人关联账号被拒绝
      const surrogate = await request(group.owner, "POST", "/care-profiles", { displayName: "冒名", linkedUserId: member.id });
      assert.equal(surrogate.statusCode, 400, surrogate.body);

      status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: mine.id, medicineName: "私密药", dosageText: "每次 1 片",
        timeSlots: ["08:00"], startDate: "2026-01-01",
      }), 201);

      // 本人可见
      const ownList = status(await request(group.owner, "GET", "/care-profiles"), 200);
      assert.deepEqual(ownList.careProfiles.map((item) => item.id), [mine.id]);
      // 家庭成员不可见（管理员无特权）
      const memberList = status(await request(member, "GET", "/care-profiles"), 200);
      assert.deepEqual(memberList.careProfiles, []);
      const memberSchedule = status(await request(member, "GET", "/medication-plans/schedule"), 200);
      assert.deepEqual(memberSchedule.entries, []);
      // 未授权成员不能代记
      const forbidden = await request(member, "POST", "/medication-plans", {
        careProfileId: mine.id, medicineName: "偷偷代记", dosageText: "1 片", timeSlots: ["09:00"], startDate: "2026-01-01",
      });
      assert.equal(forbidden.statusCode, 403, forbidden.body);
    });

    await t.test("unlinked profile requires explicit grants; manage enables proxy recording", async () => {
      const group = await family(1);
      const member = group.members[0];
      const child = status(await request(group.owner, "POST", "/care-profiles", { displayName: "孩子" }), 201);
      assert.equal(child.isPrivate, false);

      // 未授权：成员不可见
      assert.deepEqual(status(await request(member, "GET", "/care-profiles"), 200).careProfiles, []);

      // 授权查看（canManage=false）：可见，但不能创建计划
      status(await request(group.owner, "POST", `/care-profiles/${child.id}/grants`, { memberUserId: member.id, canManage: false }), 200);
      const visible = status(await request(member, "GET", "/care-profiles"), 200).careProfiles.find((item) => item.id === child.id);
      assert.equal(visible.canManage, false);
      const forbidden = await request(member, "POST", "/medication-plans", {
        careProfileId: child.id, medicineName: "越权计划", dosageText: "1 片", timeSlots: ["09:00"], startDate: "2026-01-01",
      });
      assert.equal(forbidden.statusCode, 403, forbidden.body);

      // 升级为管理：可代记
      status(await request(group.owner, "POST", `/care-profiles/${child.id}/grants`, { memberUserId: member.id, canManage: true }), 200);
      const plan = status(await request(member, "POST", "/medication-plans", {
        careProfileId: child.id, medicineName: "儿童维生素", dosageText: "每天 1 粒",
        timeSlots: ["08:00"], weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], startDate: "2026-01-01",
      }), 201);
      assert.equal(plan.status, "active");
    });

    await t.test("schedule materialises occurrences lazily and confirm is idempotent with correctable history", async () => {
      const group = await family(1);
      const member = group.members[0];
      const elder = status(await request(group.owner, "POST", "/care-profiles", { displayName: "老人" }), 201);
      status(await request(group.owner, "POST", `/care-profiles/${elder.id}/grants`, { memberUserId: member.id, canManage: true }), 200);
      const plan = status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: elder.id, medicineName: "降压药", dosageText: "每次 1 粒",
        timeSlots: ["08:00", "20:00"], weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], startDate: "2026-01-01",
      }), 201);

      const today = shanghaiToday();
      const schedule = status(await request(group.owner, "GET", `/medication-plans/schedule?date=${today}`), 200);
      assert.equal(schedule.entries.length, 2, JSON.stringify(schedule));
      assert.deepEqual(schedule.entries.map((item) => item.time), ["08:00", "20:00"]);
      assert.ok(schedule.entries.every((item) => item.status === "pending"));

      // 确认第一剂（幂等键 A）
      const first = schedule.entries[0];
      const confirmed = status(await request(group.owner, "POST", `/dose-occurrences/${first.occurrenceId}/confirm`, {
        action: "taken", idempotencyKey: `key-${randomUUID()}`,
      }), 200);
      assert.equal(confirmed.status, "taken");
      // 同键重试：replayed，不追加事件
      const replay = status(await request(group.owner, "POST", `/dose-occurrences/${first.occurrenceId}/confirm`, {
        action: "taken", idempotencyKey: `key-${randomUUID()}`,
      }), 200);
      assert.equal(replay.replayed, false);
      const events = (await pool.query(
        "SELECT count(*)::int AS count FROM dose_confirmations WHERE occurrence_id = $1",
        [first.occurrenceId],
      )).rows[0].count;
      assert.equal(events, 2, "different keys append events; corrections keep history");

      // 另一成员（有管理授权）用不同键纠正为 skipped
      const corrected = status(await request(member, "POST", `/dose-occurrences/${first.occurrenceId}/confirm`, {
        action: "skipped", idempotencyKey: `key-${randomUUID()}`,
      }), 200);
      assert.equal(corrected.status, "skipped");
      const after = (await pool.query(
        "SELECT status FROM dose_occurrences WHERE id = $1",
        [first.occurrenceId],
      )).rows[0];
      assert.equal(after.status, "skipped");
      assert.ok(plan.planId);
    });

    await t.test("pause stops future materialisation, version conflict is detected, end keeps history", async () => {
      const group = await family(0);
      const self = status(await request(group.owner, "POST", "/care-profiles", { displayName: "我自己", linkedUserId: group.owner.id }), 201);
      const plan = status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: self.id, medicineName: "每日药", dosageText: "1 粒",
        timeSlots: ["08:00"], weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], startDate: "2026-01-01",
      }), 201);
      const today = shanghaiToday();
      status(await request(group.owner, "GET", `/medication-plans/schedule?date=${today}`), 200);

      // 版本冲突
      const conflict = await request(group.owner, "POST", `/medication-plans/${plan.planId}/pause`, { version: 99 });
      assert.equal(conflict.statusCode, 409, conflict.body);

      // 正确版本暂停：当日已物化的实例保留，但再次物化不会新增
      status(await request(group.owner, "POST", `/medication-plans/${plan.planId}/pause`, { version: 1 }), 200);
      const countBefore = (await pool.query("SELECT count(*)::int AS count FROM dose_occurrences WHERE plan_id = $1", [plan.planId])).rows[0].count;
      const paused = status(await request(group.owner, "GET", `/medication-plans/schedule?date=${shanghaiDate(1)}`), 200);
      assert.deepEqual(paused.entries, [], "paused plans must not materialise new occurrences");
      const countAfter = (await pool.query("SELECT count(*)::int AS count FROM dose_occurrences WHERE plan_id = $1", [plan.planId])).rows[0].count;
      assert.equal(countAfter, countBefore);

      // 结束（从暂停态直接结束）：列表不再返回
      status(await request(group.owner, "POST", `/medication-plans/${plan.planId}/end`, { version: 2 }), 200);
      assert.equal(status(await request(group.owner, "GET", "/medication-plans"), 200).plans.length, 0);
      const history = (await pool.query("SELECT count(*)::int AS count FROM dose_occurrences WHERE plan_id = $1", [plan.planId])).rows[0].count;
      assert.ok(history >= 1, "ending a plan keeps historical occurrences");
    });
    await t.test("plan detail and history expose corrections without rewriting them", async () => {
      const group = await family(0);
      const self = status(await request(group.owner, "POST", "/care-profiles", { displayName: "我自己", linkedUserId: group.owner.id }), 201);
      const plan = status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: self.id, medicineName: "复查用药", dosageText: "每次 2 粒",
        timeSlots: ["08:00"], startDate: "2026-01-01",
      }), 201);

      const detail = status(await request(group.owner, "GET", `/medication-plans/${plan.planId}`), 200);
      assert.deepEqual(detail.plan.timeSlots, ["08:00"]);
      assert.equal(detail.plan.status, "active");
      assert.equal(detail.canManage, true);

      const schedule = status(await request(group.owner, "GET", `/medication-plans/schedule?date=${shanghaiToday()}`), 200);
      const occurrenceId = schedule.entries[0].occurrenceId;
      status(await request(group.owner, "POST", `/dose-occurrences/${occurrenceId}/confirm`, { action: "taken", idempotencyKey: `k1-${randomUUID()}` }), 200);
      status(await request(group.owner, "POST", `/dose-occurrences/${occurrenceId}/confirm`, { action: "skipped", idempotencyKey: `k2-${randomUUID()}` }), 200);

      const history = status(await request(group.owner, "GET", `/medication-plans/${plan.planId}/history`), 200);
      assert.equal(history.medicineName, "复查用药");
      const record = history.history.find((item) => item.occurrenceId === occurrenceId);
      assert.equal(record.status, "skipped", "latest state wins");
      assert.equal(record.events.length, 2, "both events are kept");
      assert.deepEqual(record.events.map((item) => item.action), ["taken", "skipped"]);
      assert.equal(record.corrected, true, "corrections are flagged, never collapsed");
    });

    await t.test("editing a plan only changes future occurrences and keeps history", async () => {
      const group = await family(0);
      const self = status(await request(group.owner, "POST", "/care-profiles", { displayName: "我自己", linkedUserId: group.owner.id }), 201);
      const plan = status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: self.id, medicineName: "早晚药", dosageText: "1 粒",
        timeSlots: ["08:00", "20:00"], startDate: "2026-01-01",
      }), 201);

      const today = shanghaiToday();
      status(await request(group.owner, "GET", `/medication-plans/schedule?date=${today}`), 200);
      const beforeCount = (await pool.query("SELECT count(*)::int AS count FROM dose_occurrences WHERE plan_id = $1", [plan.planId])).rows[0].count;
      assert.equal(beforeCount, 2);

      const conflict = await request(group.owner, "PUT", `/medication-plans/${plan.planId}`, { version: 99, timeSlots: ["08:00"] });
      assert.equal(conflict.statusCode, 409, conflict.body);

      const updated = status(await request(group.owner, "PUT", `/medication-plans/${plan.planId}`, {
        version: 1, timeSlots: ["08:00", "21:00"], dosageText: "每次 2 粒",
      }), 200);
      assert.equal(updated.version, 2);
      assert.deepEqual(updated.timeSlots, ["08:00", "21:00"]);

      // 已物化的 20:00 记录保留（历史不被删）
      const kept = (await pool.query(
        "SELECT time_of_day::text AS time FROM dose_occurrences WHERE plan_id = $1 AND dose_date = $2 ORDER BY time_of_day",
        [plan.planId, today],
      )).rows.map((row) => row.time.slice(0, 5));
      assert.deepEqual(kept, ["08:00", "20:00"], "history must survive a schedule edit");

      // 明天只按新的时间点物化
      const tomorrow = status(await request(group.owner, "GET", `/medication-plans/schedule?date=${shanghaiDate(1)}`), 200);
      assert.deepEqual(tomorrow.entries.map((item) => item.time), ["08:00", "21:00"]);

      const detail = status(await request(group.owner, "GET", `/medication-plans/${plan.planId}`), 200);
      assert.equal(detail.plan.dosageText, "每次 2 粒");
      assert.equal(detail.plan.version, 2);
    });

    await t.test("grants can be listed and revoked; revocation removes access immediately", async () => {
      const group = await family(1);
      const member = group.members[0];
      const child = status(await request(group.owner, "POST", "/care-profiles", { displayName: "孩子" }), 201);
      status(await request(group.owner, "POST", `/care-profiles/${child.id}/grants`, { memberUserId: member.id, canManage: true }), 200);
      const plan = status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: child.id, medicineName: "退烧药", dosageText: "5ml",
        timeSlots: ["08:00"], startDate: "2026-01-01",
      }), 201);

      const listed = status(await request(group.owner, "GET", `/care-profiles/${child.id}/grants`), 200);
      assert.equal(listed.grants.length, 1);
      assert.equal(listed.grants[0].memberUserId, member.id);
      assert.equal(listed.grants[0].canManage, true);

      // 非管理者不能查看授权
      const other = group.members[0];
      assert.equal(other.id, member.id);
      const schedule = status(await request(member, "GET", `/medication-plans/schedule?date=${shanghaiToday()}`), 200);
      assert.equal(schedule.entries.length, 1);
      const occurrenceId = schedule.entries[0].occurrenceId;

      status(await request(group.owner, "DELETE", `/care-profiles/${child.id}/grants/${member.id}`), 200);
      assert.deepEqual(status(await request(member, "GET", "/care-profiles"), 200).careProfiles, [], "revoked member loses visibility");
      const denied = await request(member, "POST", `/dose-occurrences/${occurrenceId}/confirm`, { action: "taken", idempotencyKey: `k-${randomUUID()}` });
      assert.equal(denied.statusCode, 403, denied.body);
      assert.ok(plan.planId);
    });

    await t.test("an ended plan cannot be edited", async () => {
      const group = await family(0);
      const self = status(await request(group.owner, "POST", "/care-profiles", { displayName: "我自己", linkedUserId: group.owner.id }), 201);
      const plan = status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: self.id, medicineName: "短期药", dosageText: "1 粒", timeSlots: ["08:00"], startDate: "2026-01-01",
      }), 201);
      status(await request(group.owner, "POST", `/medication-plans/${plan.planId}/end`, { version: 1 }), 200);
      const denied = await request(group.owner, "PUT", `/medication-plans/${plan.planId}`, { version: 2, dosageText: "2 粒" });
      assert.equal(denied.statusCode, 409, denied.body);
      assert.equal(denied.json().error.code, "PLAN_ENDED");
    });
  } finally {
    if (app !== undefined) await app.close();
    await fixture.close();
  }
});

function shanghaiToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function shanghaiDate(offsetDays) {
  const shanghai = new Date(Date.now() + 8 * 3600 * 1000);
  const shifted = new Date(Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate() + offsetDays));
  return shifted.toISOString().slice(0, 10);
}
