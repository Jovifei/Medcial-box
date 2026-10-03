// A07 提醒成员关系复核：真实 PostgreSQL。
// 独立文件运行：登录速率限制器是进程本地的（30 次/分钟，按客户端地址共享），
// 与 integration-pg.test.mjs 合并运行会耗尽配额，因此这里占用独立的进程配额。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { applyMigrations } from "../dist/db/migrations.js";
import { buildServer } from "../dist/app.js";
import { dispatchDueReminderMessages } from "../dist/jobs/reminder-scheduler.js";
import { createReminderTemplateConfig } from "../dist/services/subscribe-messages.js";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { isolatedPostgres } from "./helpers/isolated-pg.mjs";

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

function status(response, expected) {
  assert.equal(response.statusCode, expected, response.body);
  return expected === 204 ? null : response.json();
}

test("real PostgreSQL: removed members never receive queued reminders (A07)", {
  skip: !url && !required ? "TEST_DATABASE_URL absent: optional local PostgreSQL suite" : false,
  concurrency: 1,
}, async (t) => {
  assert.ok(url, "REQUIRE_POSTGRES_TESTS=1 requires TEST_DATABASE_URL; real PostgreSQL cannot be skipped");
  const fixture = await isolatedPostgres(url);
  const { pool, database } = fixture;
  const gateway = createTestGateway();
  const reminderConfig = createReminderTemplateConfig({
    appId: "synthetic-app-id",
    appSecret: "synthetic-secret",
    templateId: "synthetic-reminder-template",
  });
  let app;
  try {
    await applyMigrations(pool);
    app = await buildServer({ database, wechatGateway: gateway, reminderTemplateConfig: reminderConfig, logger: { level: "error" } });
    const request = (user, method, path, payload) => app.inject({ method, url: `/api/v1${path}`, headers: { authorization: `Bearer ${user.token}` }, ...(payload === undefined ? {} : { payload }) });
    async function user() {
      const code = randomUUID();
      gateway.registerCode(code, `a07-${code}`);
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

    await t.test("member reminder time is respected before the old global 09:00 window", async () => {
      const {owner,members:[member]}=await family(1);
      status(await request(owner,"POST","/medicines",{name:"时刻药",batches:[{quantity:1,unit:"box",expiry:{value:shanghaiDate(0),precision:"day"}}]}),201);
      for(const u of [owner,member])status(await request(u,"POST","/notifications/subscribe",{acceptedTemplateIds:["synthetic-reminder-template"]}),200);
      status(await request(member,"PUT","/notification-preferences",{stockReminderTime:"07:35",channels:["wechat"]}),200);
      const when=new Date(`${shanghaiDate(0)}T00:00:00Z`);
      const result=await dispatchDueReminderMessages(database,{async send(){return{messageId:"test"}}},reminderConfig,when);
      assert.equal(result.queued,1);
      const rows=(await pool.query("SELECT user_id FROM reminder_deliveries WHERE user_id=ANY($1::uuid[])",[[owner.id,member.id]])).rows;
      assert.deepEqual(rows.map(r=>r.user_id),[member.id]);
      for(const u of [owner,member]) status(await request(u,"PUT","/notification-preferences",{stockReminderTime:"07:35",channels:[]}),200);
    });
    await t.test("creator must transfer shared care before leaving and old authority does not revive", async () => {
      const {owner,members:[member]}=await family(1);
      const care=status(await request(member,"POST","/care-profiles",{displayName:"孩子"}),201);
      status(await request(member,"POST",`/care-profiles/${care.id}/grants`,{memberUserId:owner.id,canManage:true}),200);
      const privateSelf=status(await request(member,"POST","/care-profiles/self",{}),201);
      const privatePlan=status(await request(member,"POST","/medication-plans",{careProfileId:privateSelf.id,medicineName:"隐私药",dosageText:"1片",timeSlots:["08:00"],startDate:"2026-01-01"}),201);
      status(await request(member,"POST","/families/leave"),409);
      status(await request(member,"POST",`/care-profiles/${care.id}/transfer-management`,{memberUserId:owner.id}),200);
      status(await request(member,"POST","/families/leave"),204);
      const invite=status(await request(owner,"POST","/families/invitations"),201);
      status(await request(member,"POST","/families/invitations/accept",{code:invite.invitationCode}),200);
      assert.equal(status(await request(member,"GET","/care-profiles"),200).careProfiles.length,0);
      status(await request(member,"GET",`/medication-plans/${privatePlan.planId}`),404);
      const fresh=status(await request(member,"POST","/care-profiles/self",{}),201);
      assert.notEqual(fresh.id,privateSelf.id);
      assert.equal(status(await request(owner,"GET","/care-profiles"),200).careProfiles[0].id,care.id);
    });

    await t.test("removed member receives nothing and grants are released", async () => {
      const { owner, members: [member], id: familyId } = await family(1);
      status(await request(owner, "POST", "/medicines", {
        name: "提醒成员测试药",
        batches: [{ quantity: 2, unit: "box", expiry: { value: shanghaiDate(0), precision: "day" }, storageLocation: "药箱" }],
      }), 201);
      // 两位成员都授权订阅，确保"没有发送"不是因为缺少可用授权。
      status(await request(owner, "POST", "/notifications/subscribe", { acceptedTemplateIds: ["synthetic-reminder-template"] }), 200);
      status(await request(member, "POST", "/notifications/subscribe", { acceptedTemplateIds: ["synthetic-reminder-template"] }), 200);

      const memberOpenid = (await pool.query("SELECT openid FROM users WHERE id = $1", [member.id])).rows[0].openid;
      const firstRecipients = [];
      // 让该成员的首次投递失败：任务留在 failed 等待重试，这正是审核复现的场景
      // （已排队任务属于后来的 removed-user）。
      const first = await dispatchDueReminderMessages(database, {
        send: async (message) => {
          if (message.openid === memberOpenid) throw new Error("synthetic gateway failure");
          firstRecipients.push(message.openid);
          return { messageId: `a07-${firstRecipients.length}` };
        },
      }, reminderConfig, reminderDispatchNow());
      assert.equal(first.sent, 1, JSON.stringify(first));
      assert.equal(first.failed, 1, JSON.stringify(first));
      const retryRow = (await pool.query(
        "SELECT status, next_attempt_at FROM reminder_deliveries WHERE family_id = $1 AND user_id = $2",
        [familyId, member.id],
      )).rows;
      assert.equal(retryRow.length, 1, JSON.stringify(retryRow));
      assert.equal(retryRow[0].status, "failed", "member delivery must still be pending a retry");

      // owner 移除成员后：尚未送达的任务与授权都必须失效，重试不得再发给他。
      status(await request(owner, "DELETE", `/families/members/${member.membershipId}`), 204);
      const afterRemoval = [];
      const second = await dispatchDueReminderMessages(database, {
        send: async (message) => {
          afterRemoval.push(message.openid);
          return { messageId: `a07-post-${afterRemoval.length}` };
        },
      }, reminderConfig, new Date(reminderDispatchNow().getTime() + 15 * 60_000));
      assert.deepEqual(afterRemoval, [], `removed member must not be messaged: ${JSON.stringify(afterRemoval)}`);
      assert.equal(second.sent, 0, JSON.stringify(second));

      // 已成功发送的历史保留为 sent（正常的送达记录）；关键是此后不再有待发送任务。
      const pending = (await pool.query(
        "SELECT status, last_error_code FROM reminder_deliveries WHERE family_id = $1 AND user_id = $2 AND status IN ('queued', 'failed', 'sending')",
        [familyId, member.id],
      )).rows;
      assert.deepEqual(pending, [], `no pending delivery may remain for a removed member: ${JSON.stringify(pending)}`);
      const blockedRows = (await pool.query(
        "SELECT last_error_code FROM reminder_deliveries WHERE family_id = $1 AND user_id = $2 AND status = 'blocked' AND last_error_code = 'NOT_A_MEMBER'",
        [familyId, member.id],
      )).rows;
      assert.equal(blockedRows.length, 1, `the retried delivery must be blocked as NOT_A_MEMBER: ${JSON.stringify(blockedRows)}`);
      const grants = (await pool.query(
        "SELECT consumed_at FROM wechat_subscription_grants WHERE family_id = $1 AND user_id = $2",
        [familyId, member.id],
      )).rows;
      assert.ok(grants.every((row) => row.consumed_at !== null), "departed member grants must not stay usable");
      const ownerStillMember = (await pool.query(
        "SELECT count(*)::int AS count FROM family_members WHERE family_id = $1 AND user_id = $2",
        [familyId, owner.id],
      )).rows[0].count;
      assert.equal(ownerStillMember, 1, "owner membership is untouched by the member removal");
    });

    await t.test("member who leaves is not messaged either", async () => {
      const { owner, members: [member], id: familyId } = await family(1);
      status(await request(owner, "POST", "/medicines", {
        name: "退出成员测试药",
        batches: [{ quantity: 2, unit: "box", expiry: { value: shanghaiDate(0), precision: "day" } }],
      }), 201);
      status(await request(member, "POST", "/notifications/subscribe", { acceptedTemplateIds: ["synthetic-reminder-template"] }), 200);
      const memberOpenid = (await pool.query("SELECT openid FROM users WHERE id = $1", [member.id])).rows[0].openid;
      // 同样让该成员首次投递失败，留下待重试任务。
      const before = [];
      await dispatchDueReminderMessages(database, {
        send: async (message) => {
          if (message.openid === memberOpenid) throw new Error("synthetic gateway failure");
          before.push(message.openid);
          return { messageId: `leave-${before.length}` };
        },
      }, reminderConfig, reminderDispatchNow());
      assert.equal((await pool.query(
        "SELECT count(*)::int AS count FROM reminder_deliveries WHERE family_id = $1 AND user_id = $2 AND status = 'failed'",
        [familyId, member.id],
      )).rows[0].count, 1, "the member's delivery must be pending a retry before leaving");
      status(await request(member, "POST", "/families/leave"), 204);
      const after = [];
      await dispatchDueReminderMessages(database, {
        send: async (message) => { after.push(message.openid); return { messageId: `leave-post-${after.length}` }; },
      }, reminderConfig, new Date(reminderDispatchNow().getTime() + 15 * 60_000));
      assert.deepEqual(after, [], `member who left must not be messaged: ${JSON.stringify(after)}`);
      const pending = (await pool.query(
        "SELECT status, last_error_code FROM reminder_deliveries WHERE family_id = $1 AND user_id = $2 AND status IN ('queued', 'failed', 'sending')",
        [familyId, member.id],
      )).rows;
      assert.deepEqual(pending, [], `leaving must cancel queued deliveries: ${JSON.stringify(pending)}`);
    });
    await t.test("stale milestone retries are cancelled instead of delivered (A08)", async () => {
      const { owner } = await family(0);
      const medicine = status(await request(owner, "POST", "/medicines", {
        name: "过时提醒测试药",
        batches: [{ quantity: 2, unit: "box", expiry: { value: shanghaiDate(30), precision: "day" } }],
      }), 201);
      status(await request(owner, "POST", "/notifications/subscribe", { acceptedTemplateIds: ["synthetic-reminder-template"] }), 200);

      // 10 月 1 日：距离 10 月 31 日还有 30 天 → 命中"30 天后到期"里程碑，首次投递失败留下重试。
      const labels = [];
      const first = await dispatchDueReminderMessages(database, {
        send: async (message) => {
          labels.push(message.eventLabel);
          throw new Error("synthetic gateway failure");
        },
      }, reminderConfig, reminderDispatchNow());
      assert.equal(first.queued, 1, JSON.stringify(first));
      assert.equal(first.failed, 1, JSON.stringify(first));
      assert.deepEqual(labels, ["30 天后到期"]);
      const queuedRow = (await pool.query(
        "SELECT status, days_before, deadline_date::text AS deadline FROM reminder_deliveries WHERE medicine_id = $1",
        [medicine.id],
      )).rows;
      assert.equal(queuedRow.length, 1);
      assert.equal(queuedRow[0].status, "failed");
      assert.equal(queuedRow[0].deadline, shanghaiDate(30));

      // 10 月 3 日重试：只剩 28 天，已经不是"30 天后到期"这件事，不得补发。
      const lateLabels = [];
      const second = await dispatchDueReminderMessages(database, {
        send: async (message) => {
          lateLabels.push(message.eventLabel);
          return { messageId: "late" };
        },
      }, reminderConfig, new Date(reminderDispatchNow().getTime() + 2 * 24 * 3600_000));
      assert.deepEqual(lateLabels, [], `a stale milestone must not be delivered: ${JSON.stringify(lateLabels)}`);
      assert.equal(second.sent, 0, JSON.stringify(second));
      const rows = (await pool.query(
        "SELECT status, last_error_code FROM reminder_deliveries WHERE medicine_id = $1",
        [medicine.id],
      )).rows;
      assert.equal(rows.length, 1, "the stale event must not spawn a replacement");
      assert.equal(rows[0].status, "blocked");
      assert.equal(rows[0].last_error_code, "STALE_MILESTONE");
    });
  } finally {
    if (app !== undefined) await app.close();
    await fixture.close();
  }
});
