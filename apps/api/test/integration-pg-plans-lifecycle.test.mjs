// S1 服药实例生命周期与历史的真实 PostgreSQL 验证（深审 R01–R04/R06）。
// 覆盖：改剂量后同一时间点仍有 1 个有效未来实例、A→B→A 复原、作废实例不可确认、
// 暂停/结束后历史仍可见、今日 taken 显示原快照、并发本人档案只创建 1 个。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { applyMigrations } from "../dist/db/migrations.js";
import { buildServer } from "../dist/app.js";
import { createReminderTemplateConfig } from "../dist/services/subscribe-messages.js";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { issueSessionToken } from "../dist/auth/session.js";
import { isolatedPostgres, contend } from "./helpers/isolated-pg.mjs";

const url = process.env.TEST_DATABASE_URL?.trim() ?? "";
const required = process.env.REQUIRE_POSTGRES_TESTS === "1";

function status(response, expected) {
  assert.equal(response.statusCode, expected, response.body);
  return expected === 204 ? null : response.json();
}

function shanghaiToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function shanghaiDate(offsetDays) {
  const shanghai = new Date(Date.now() + 8 * 3600 * 1000);
  const shifted = new Date(Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate() + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

test("real PostgreSQL: dose occurrence lifecycle and history (S1 R01-R04/R06)", {
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
      gateway.registerCode(code, `s1-${code}`);
      const auth = status(await app.inject({ method: "POST", url: "/api/v1/auth/wechat", payload: { code } }), 200);
      return { token: auth.token, id: auth.user.id };
    }
    async function family() {
      const owner = await user();
      const created = status(await request(owner, "POST", "/families", { name: `家庭-${randomUUID()}` }), 201);
      owner.membershipId = created.membership.id;
      return { owner, id: created.family.id };
    }
    async function selfProfile(owner) {
      return status(await request(owner, "POST", "/care-profiles/self", { displayName: "我" }), 201);
    }

    await t.test("preferences default off and roundtrip per user with validated time", async () => {
      const group=await family();
      const read=status(await request(group.owner,"GET","/notification-preferences"),200);
      assert.deepEqual(read.preferences,{stockReminderTime:"09:00",timezone:"Asia/Shanghai",channels:[]});
      status(await request(group.owner,"PUT","/notification-preferences",{stockReminderTime:"25:00",channels:["wechat"]}),400);
      const saved=status(await request(group.owner,"PUT","/notification-preferences",{stockReminderTime:"07:35",channels:["android"]}),200);
      assert.equal(saved.preferences.stockReminderTime,"07:35");
      assert.deepEqual(status(await request(group.owner,"GET","/notification-preferences"),200),saved);
    });

    await t.test("V03: confirmed today remains visible after pause and slot change", async () => {
      const group=await family(); const self=await selfProfile(group.owner);
      const plan=status(await request(group.owner,"POST","/medication-plans",{careProfileId:self.id,medicineName:"原药",dosageText:"1片",timeSlots:["08:00"],startDate:"2026-01-01"}),201);
      const first=status(await request(group.owner,"GET",`/medication-plans/schedule?date=${shanghaiToday()}`),200);
      const occurrenceId=first.entries[0].occurrenceId;
      status(await request(group.owner,"POST",`/dose-occurrences/${occurrenceId}/confirm`,{action:"taken",idempotencyKey:randomUUID()}),200);
      status(await request(group.owner,"PUT",`/medication-plans/${plan.planId}`,{version:1,timeSlots:["09:00"],medicineName:"新药",dosageText:"2片"}),200);
      status(await request(group.owner,"POST",`/medication-plans/${plan.planId}/pause`,{version:2}),200);
      const current=status(await request(group.owner,"GET",`/medication-plans/schedule?date=${shanghaiToday()}`),200);
      assert.equal(current.entries.length,1); assert.equal(current.entries[0].occurrenceId,occurrenceId);
      assert.equal(current.entries[0].medicineName,"原药"); assert.equal(current.entries[0].status,"taken");
    });

    await t.test("R01: editing dosage keeps exactly one active future occurrence and re-materialises (A->B->A)", async () => {
      const group = await family();
      const self = await selfProfile(group.owner);
      const plan = status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: self.id, medicineName: "早晚药", dosageText: "1 粒",
        timeSlots: ["08:00"], startDate: "2026-01-01",
      }), 201);
      const tomorrow = shanghaiDate(1);

      const first = status(await request(group.owner, "GET", `/medication-plans/schedule?date=${tomorrow}`), 200);
      assert.equal(first.entries.length, 1, JSON.stringify(first));
      assert.equal(first.entries[0].dosageText, "1 粒");
      const idA = first.entries[0].occurrenceId;

      // 仅改剂量（时间点不变）：作废未来 pending，重新物化出新活动实例。
      status(await request(group.owner, "PUT", `/medication-plans/${plan.planId}`, { version: 1, dosageText: "2 粒" }), 200);
      const second = status(await request(group.owner, "GET", `/medication-plans/schedule?date=${tomorrow}`), 200);
      assert.equal(second.entries.length, 1, "同一时间点在改剂量后仍应恰有 1 条安排");
      assert.equal(second.entries[0].dosageText, "2 粒");
      const idB = second.entries[0].occurrenceId;
      assert.notEqual(idB, idA, "作废后应物化出新实例 ID");

      // 改回原剂量（A→B→A）：仍能再次物化，不被旧唯一键吞掉。
      status(await request(group.owner, "PUT", `/medication-plans/${plan.planId}`, { version: 2, dosageText: "1 粒" }), 200);
      const third = status(await request(group.owner, "GET", `/medication-plans/schedule?date=${tomorrow}`), 200);
      assert.equal(third.entries.length, 1);
      assert.equal(third.entries[0].dosageText, "1 粒");
      const idC = third.entries[0].occurrenceId;
      assert.notEqual(idC, idB);

      const active = (await pool.query(
        "SELECT count(*)::int AS count FROM dose_occurrences WHERE plan_id = $1 AND dose_date = $2 AND superseded_at IS NULL",
        [plan.planId, tomorrow],
      )).rows[0].count;
      assert.equal(active, 1, "活动实例唯一（部分唯一索引）");
      const superseded = (await pool.query(
        "SELECT count(*)::int AS count FROM dose_occurrences WHERE id = ANY($1::uuid[]) AND superseded_at IS NOT NULL",
        [[idA, idB]],
      )).rows[0].count;
      assert.equal(superseded, 2, "被替换的旧实例保留并标记作废");
    });

    await t.test("R02: a superseded occurrence cannot be newly confirmed (409)", async () => {
      const group = await family();
      const self = await selfProfile(group.owner);
      const plan = status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: self.id, medicineName: "改期药", dosageText: "1 粒",
        timeSlots: ["08:00"], startDate: "2026-01-01",
      }), 201);
      const tomorrow = shanghaiDate(1);
      const before = status(await request(group.owner, "GET", `/medication-plans/schedule?date=${tomorrow}`), 200);
      const staleId = before.entries[0].occurrenceId;

      status(await request(group.owner, "PUT", `/medication-plans/${plan.planId}`, { version: 1, dosageText: "3 粒" }), 200);
      const denied = await request(group.owner, "POST", `/dose-occurrences/${staleId}/confirm`, {
        action: "taken", idempotencyKey: `k-${randomUUID()}`,
      });
      assert.equal(denied.statusCode, 409, denied.body);
      assert.equal(denied.json().error.code, "OCCURRENCE_SUPERSEDED");

      // 新的活动实例仍可确认。
      const after = status(await request(group.owner, "GET", `/medication-plans/schedule?date=${tomorrow}`), 200);
      const ok = status(await request(group.owner, "POST", `/dose-occurrences/${after.entries[0].occurrenceId}/confirm`, {
        action: "taken", idempotencyKey: `k-${randomUUID()}`,
      }), 200);
      assert.equal(ok.status, "taken");
    });

    await t.test("R03: pause/end does not hide past schedule", async () => {
      const group = await family();
      const self = await selfProfile(group.owner);
      const plan = status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: self.id, medicineName: "历史药", dosageText: "1 粒",
        timeSlots: ["08:00"], startDate: "2026-01-01",
      }), 201);
      const yesterday = shanghaiDate(-1);
      // 直接落一条昨天已服用的实例（模拟昨天物化并确认过）。
      const slot = (await pool.query(
        "SELECT id FROM plan_time_slots WHERE plan_id = $1 AND archived_at IS NULL ORDER BY time_of_day LIMIT 1",
        [plan.planId],
      )).rows[0];
      const careProfileId = self.id;
      await pool.query(
        `INSERT INTO dose_occurrences (family_id, plan_id, slot_id, care_profile_id, dose_date, time_of_day, status,
                                       medicine_name_snapshot, dosage_text_snapshot, care_profile_name_snapshot, plan_version_snapshot)
         VALUES ($1, $2, $3, $4, $5::date, '08:00:00', 'taken', '历史药', '1 粒', '我', 1)`,
        [group.id, plan.planId, slot.id, careProfileId, yesterday],
      );

      const beforePause = status(await request(group.owner, "GET", `/medication-plans/schedule?date=${yesterday}`), 200);
      assert.equal(beforePause.entries.length, 1, "暂停前昨天应有 1 条历史");

      status(await request(group.owner, "POST", `/medication-plans/${plan.planId}/pause`, { version: 1 }), 200);
      const afterPause = status(await request(group.owner, "GET", `/medication-plans/schedule?date=${yesterday}`), 200);
      assert.equal(afterPause.entries.length, 1, "暂停后昨天历史仍可见");
      assert.equal(afterPause.entries[0].status, "taken");

      status(await request(group.owner, "POST", `/medication-plans/${plan.planId}/end`, { version: 2 }), 200);
      const afterEnd = status(await request(group.owner, "GET", `/medication-plans/schedule?date=${yesterday}`), 200);
      assert.equal(afterEnd.entries.length, 1, "结束后昨天历史仍可见");
    });

    await t.test("R04: today's taken occurrence keeps its snapshot after the plan is edited", async () => {
      const group = await family();
      const self = await selfProfile(group.owner);
      const plan = status(await request(group.owner, "POST", "/medication-plans", {
        careProfileId: self.id, medicineName: "药A", dosageText: "1 粒",
        timeSlots: ["08:00"], startDate: "2026-01-01",
      }), 201);
      const today = shanghaiToday();
      const schedule = status(await request(group.owner, "GET", `/medication-plans/schedule?date=${today}`), 200);
      assert.equal(schedule.entries.length, 1);
      const occId = schedule.entries[0].occurrenceId;
      status(await request(group.owner, "POST", `/dose-occurrences/${occId}/confirm`, { action: "taken", idempotencyKey: `k-${randomUUID()}` }), 200);

      // 改药名与剂量：已确认实例不作废，今日仍显示当时的快照。
      status(await request(group.owner, "PUT", `/medication-plans/${plan.planId}`, { version: 1, medicineName: "药B", dosageText: "9 粒" }), 200);
      const after = status(await request(group.owner, "GET", `/medication-plans/schedule?date=${today}`), 200);
      const taken = after.entries.find((item) => item.occurrenceId === occId);
      assert.ok(taken, "今日已服用记录不应消失");
      assert.equal(taken.medicineName, "药A", "今日 taken 显示原药名快照");
      assert.equal(taken.dosageText, "1 粒", "今日 taken 显示原剂量快照");
      assert.equal(taken.snapshotComplete, true);
      assert.equal(taken.status, "taken");
    });

    await t.test("R06: concurrent self profile creation yields exactly one linked profile", async () => {
      const group = await family();
      const [a, b] = await Promise.all([
        request(group.owner, "POST", "/care-profiles/self", { displayName: "我" }),
        request(group.owner, "POST", "/care-profiles/self", { displayName: "我" }),
      ]);
      assert.ok([200, 201].includes(a.statusCode), a.body);
      assert.ok([200, 201].includes(b.statusCode), b.body);
      assert.equal(a.json().id, b.json().id, "并发本人档案应回读同一 ID");
      assert.equal(a.json().isPrivate, true);
      const count = (await pool.query(
        "SELECT count(*)::int AS count FROM care_profiles WHERE family_id = $1 AND linked_user_id = $2",
        [group.id, group.owner.id],
      )).rows[0].count;
      assert.equal(count, 1, "同一家庭同一账号只允许一个本人档案");
    });
  } finally {
    if (app !== undefined) await app.close();
    await fixture.close();
  }
});


// Synthetic-only inventory binding repair; independent sessions avoid auth rate limits.
test("real PostgreSQL: plan edit preserves explicit medicine identity and current authorization", {
  skip: !url && !required ? "TEST_DATABASE_URL absent: optional local PostgreSQL suite" : false,
  concurrency: 1,
}, async (t) => {
  assert.ok(url, "REQUIRE_POSTGRES_TESTS=1 requires TEST_DATABASE_URL");
  const fixture = await isolatedPostgres(url);
  const { pool, database } = fixture;
  let app;
  let beforeTransaction;
  try {
    await applyMigrations(pool);
    app = await buildServer({ database: { ...database, async withTransaction(fn) {
      if (beforeTransaction) { const change = beforeTransaction; beforeTransaction = null; await change(); }
      return database.withTransaction(fn);
    } }, logger: false });
    const request = (who, method, path, payload) => app.inject({ method, url: `/api/v1${path}`, headers: { authorization: `Bearer ${who.token}` }, ...(payload === undefined ? {} : { payload }) });
    async function group() {
      const id = randomUUID();
      const users = [];
      for (let i = 0; i < 2; i++) {
        const userId = randomUUID();
        await pool.query("INSERT INTO users(id,openid) VALUES($1,$2)", [userId, `synthetic-edit-${userId}`]);
        users.push({ id: userId, ...await issueSessionToken(database, userId) });
      }
      const [owner, member] = users;
      await pool.query("INSERT INTO families(id,name,created_by) VALUES($1,'Synthetic binding family',$2)", [id, owner.id]);
      for (const [who, role] of [[owner, "owner"], [member, "member"]]) await pool.query("INSERT INTO family_members(family_id,user_id,role) VALUES($1,$2,$3)", [id, who.id, role]);
      const profileId = randomUUID();
      await pool.query("INSERT INTO care_profiles(id,family_id,display_name,created_by) VALUES($1,$2,'Synthetic profile',$3)", [profileId, id, owner.id]);
      await pool.query("INSERT INTO care_grants(family_id,care_profile_id,member_user_id,can_manage,created_by) VALUES($1,$2,$3,true,$4)", [id, profileId, member.id, owner.id]);
      const medicineIds = [randomUUID(), randomUUID()];
      for (const medicineId of medicineIds) await pool.query("INSERT INTO medicines(id,family_id,name,created_by,updated_by) VALUES($1,$2,'Same inventory name',$3,$3)", [medicineId, id, owner.id]);
      const plan = status(await request(owner, "POST", "/medication-plans", { careProfileId: profileId, medicineId: medicineIds[0], medicineName: "Original label", dosageText: "Original text", timeSlots: ["08:00"], startDate: "2026-01-01" }), 201);
      const edit = (payload, who = owner) => request(who, "PUT", `/medication-plans/${plan.planId}`, { version: 1, ...payload });
      const detail = async () => status(await request(owner, "GET", `/medication-plans/${plan.planId}`), 200).plan;
      return { id, owner, member, profileId, medicineIds, plan, edit, detail };
    }

    await t.test("deleted existing binding rejects explicit ID, survives omitted dose/time edits, and allows null unlink", async () => {
      const g = await group();
      await pool.query("UPDATE medicines SET deleted_at=now() WHERE id=$1", [g.medicineIds[0]]);
      status(await g.edit({ medicineId: g.medicineIds[0], dosageText: "Must not persist" }), 404);
      assert.equal((await g.detail()).version, 1);
      status(await g.edit({ dosageText: "Changed user-entered text", timeSlots: ["09:00", "20:00"] }), 200);
      const preserved = await g.detail();
      assert.equal(preserved.medicineId, g.medicineIds[0]); assert.equal(preserved.medicineName, "Original label");
      assert.equal(preserved.dosageText, "Changed user-entered text"); assert.deepEqual(preserved.timeSlots, ["09:00", "20:00"]);
      assert.equal(preserved.version, 2);
      status(await g.edit({ version: 2, medicineId: null, medicineName: "Manual replacement" }), 200);
      const detail = await g.detail();
      assert.equal(detail.medicineId, null); assert.equal(detail.medicineName, "Manual replacement");
      assert.equal(detail.version, 3);
    });

    await t.test("explicit identity switches inventory without inferring identity or replacing entered label", async () => {
      const g = await group();
      status(await g.edit({ medicineId: ` ${g.medicineIds[1].toUpperCase()} `, medicineName: "Chosen label" }), 200);
      const detail = await g.detail();
      assert.equal(detail.medicineId, g.medicineIds[1]); assert.equal(detail.medicineName, "Chosen label");
      status(await g.edit({ version: 2, medicineId: null }), 200);
      assert.equal((await g.detail()).medicineId, null);
      status(await g.edit({ version: 3, medicineId: g.medicineIds[0] }), 200);
      assert.equal((await g.detail()).medicineId, g.medicineIds[0]);
    });

    await t.test("foreign, missing and deleted IDs are rejected atomically; malformed values return 400", async () => {
      const g = await group(); const other = await group();
      await pool.query("UPDATE medicines SET deleted_at=now() WHERE id=$1", [g.medicineIds[1]]);
      for (const medicineId of [other.medicineIds[0], randomUUID(), g.medicineIds[1]]) status(await g.edit({ medicineId, medicineName: "Must not persist", timeSlots: ["09:00"] }), 404);
      for (const medicineId of ["bad-id", "", false, 1, []]) status(await g.edit({ medicineId }), 400);
      const detail = await g.detail();
      assert.equal(detail.medicineId, g.medicineIds[0]); assert.equal(detail.medicineName, "Original label");
      assert.equal(detail.version, 1); assert.deepEqual(detail.timeSlots, ["08:00"]);
    });

    await t.test("medicine deleted after preflight is rejected by the current transaction", async () => {
      const g = await group();
      beforeTransaction = () => pool.query("UPDATE medicines SET deleted_at=now() WHERE id=$1", [g.medicineIds[1]]);
      status(await g.edit({ medicineId: g.medicineIds[1] }), 404);
      assert.equal((await g.detail()).version, 1);
    });

    await t.test("rebinding preserves historical snapshots and rematerializes only future pending instances", async () => {
      const g = await group(); const today = shanghaiToday(); const tomorrow = shanghaiDate(1);
      const past = status(await request(g.owner, "GET", `/medication-plans/schedule?date=${today}`), 200).entries[0];
      status(await request(g.owner, "POST", `/dose-occurrences/${past.occurrenceId}/confirm`, { action: "taken", idempotencyKey: randomUUID() }), 200);
      const future = status(await request(g.owner, "GET", `/medication-plans/schedule?date=${tomorrow}`), 200).entries[0];
      status(await g.edit({ medicineId: g.medicineIds[1], medicineName: "New label", dosageText: "New text" }), 200);
      const historical = status(await request(g.owner, "GET", `/medication-plans/schedule?date=${today}`), 200).entries.find(row => row.occurrenceId === past.occurrenceId);
      assert.equal(historical.status, "taken"); assert.equal(historical.medicineName, "Original label"); assert.equal(historical.dosageText, "Original text");
      const next = status(await request(g.owner, "GET", `/medication-plans/schedule?date=${tomorrow}`), 200).entries;
      assert.equal(next.length, 1); assert.notEqual(next[0].occurrenceId, future.occurrenceId); assert.equal(next[0].medicineName, "New label");
      assert.equal((await g.detail()).medicineId, g.medicineIds[1]);
      status(await request(g.owner, "POST", `/dose-occurrences/${future.occurrenceId}/confirm`, { action: "taken", idempotencyKey: randomUUID() }), 409);
    });

    for (const change of ["membership", "grant", "profile"]) {
      await t.test(`revoked ${change} while edit waits on the family lock cannot rebind`, async () => {
        const g = await group();
        const [, edited] = await contend(fixture, /SELECT id FROM families WHERE/, () => database.withTransaction(async (tx) => {
          await tx.query("SELECT id FROM families WHERE id=$1 FOR UPDATE", [g.id]);
          if (change === "membership") await tx.query("DELETE FROM family_members WHERE family_id=$1 AND user_id=$2", [g.id, g.member.id]);
          if (change === "grant") await tx.query("DELETE FROM care_grants WHERE care_profile_id=$1 AND member_user_id=$2", [g.profileId, g.member.id]);
          if (change === "profile") await tx.query("UPDATE care_profiles SET archived_at=now() WHERE id=$1", [g.profileId]);
        }), () => g.edit({ medicineId: g.medicineIds[1] }, g.member));
        status(edited, change === "grant" ? 403 : 404);
        const row = (await pool.query("SELECT medicine_id,version FROM medication_plans WHERE id=$1", [g.plan.planId])).rows[0];
        assert.equal(row.medicine_id, g.medicineIds[0]); assert.equal(row.version, 1);
      });
    }

    for (const change of ["membership", "grant", "profile"]) {
      await t.test(`revoked ${change} after preflight is rechecked before rebinding`, async () => {
        const g = await group();
        beforeTransaction = () => change === "membership"
          ? pool.query("DELETE FROM family_members WHERE family_id=$1 AND user_id=$2", [g.id, g.member.id])
          : change === "grant"
            ? pool.query("DELETE FROM care_grants WHERE care_profile_id=$1 AND member_user_id=$2", [g.profileId, g.member.id])
            : pool.query("UPDATE care_profiles SET archived_at=now() WHERE id=$1", [g.profileId]);
        status(await g.edit({ medicineId: g.medicineIds[1] }, g.member), change === "grant" ? 403 : 404);
        const row = (await pool.query("SELECT medicine_id,version FROM medication_plans WHERE id=$1", [g.plan.planId])).rows[0];
        assert.equal(row.medicine_id, g.medicineIds[0]); assert.equal(row.version, 1);
      });
    }

    await t.test("edit holds management authorization through its medicine check until commit", async () => {
      const g = await group();
      const [edited] = await contend(fixture, /SELECT id FROM medicines WHERE|DELETE FROM care_grants WHERE/, () => g.edit({ medicineId: g.medicineIds[1] }, g.member), () => database.withTransaction(async (tx) => {
        await tx.query("DELETE FROM care_grants WHERE care_profile_id=$1 AND member_user_id=$2", [g.profileId, g.member.id]);
      }));
      status(edited, 200); assert.equal((await g.detail()).medicineId, g.medicineIds[1]);
      status(await g.edit({ version: 2, medicineId: null }, g.member), 403);
      assert.equal((await g.detail()).version, 2);
    });

    await t.test("medicine deletion winning its row lock is rechecked before rebinding", async () => {
      const g = await group();
      const [, edited] = await contend(fixture, /SELECT id FROM medicines WHERE/, () => database.withTransaction(async (tx) => {
        await tx.query("SELECT id FROM medicines WHERE id=$1 FOR UPDATE", [g.medicineIds[1]]);
        await tx.query("UPDATE medicines SET deleted_at=now() WHERE id=$1", [g.medicineIds[1]]);
      }), () => g.edit({ medicineId: g.medicineIds[1] }));
      status(edited, 404); assert.equal((await g.detail()).version, 1);
    });

    await t.test("concurrent rebinding keeps optimistic-version isolation", async () => {
      const g = await group();
      const responses = await Promise.all([g.edit({ medicineId: g.medicineIds[1] }), g.edit({ medicineId: null })]);
      assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 409]);
      const expectedId = responses[0].statusCode === 200 ? g.medicineIds[1] : null;
      const detail = await g.detail(); assert.equal(detail.version, 2); assert.equal(detail.medicineId, expectedId);
    });
  } finally {
    if (app) await app.close();
    await fixture.close();
  }
});
