// P2 家庭共享合成测试：owner 邀请、一次性消费、过期/复用/无效、已有家庭拒绝、
// owner 移除成员即时失效、移除后成员列表更新、备注可见性、导出遵守可见性。
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePool } from "./helpers/fake-pool.mjs";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import {
  batchRow,
  createApp,
  familyRow,
  medicineRow,
  membershipRow,
  noteRow,
  sha256hex,
  scriptMultiUserSessions,
} from "./helpers/app.mjs";

const OWNER_TOKEN = "1".repeat(64);
const MEMBER_TOKEN = "2".repeat(64);

async function twoUserApp(pool) {
  const gateway = createTestGateway({
    "js-owner": "openid-owner",
    "js-member": "openid-member",
  });
  const sessions = scriptMultiUserSessions(pool, [
    { token: OWNER_TOKEN, userId: "user-1", openid: "openid-owner", membership: membershipRow({ id: "membership-1", role: "owner", user_id: "user-1" }) },
    { token: MEMBER_TOKEN, userId: "user-2", openid: "openid-member", membership: membershipRow({ id: "membership-2", role: "member", user_id: "user-2" }) },
  ]);
  const app = await createApp(pool, gateway);
  return { app, sessions };
}

function ownerHeader() {
  return { headers: { authorization: `Bearer ${OWNER_TOKEN}` } };
}

function memberHeader() {
  return { headers: { authorization: `Bearer ${MEMBER_TOKEN}` } };
}

function seedMedicines(pool, rows = [], batchRows = []) {
  pool.always(/FROM medicines WHERE family_id/, { rows, rowCount: rows.length });
  pool.always(/FROM medicine_batches WHERE family_id/, { rows: batchRows, rowCount: batchRows.length });
}

test("only the owner can create invitations (member gets 403 OWNER_ONLY)", async () => {
  const pool = createFakePool();
  const { app } = await twoUserApp(pool);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/families/invitations",
      ...memberHeader(),
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "OWNER_ONLY");
    assert.equal(pool.callsMatching(/INSERT INTO family_invites/).length, 0);
  } finally {
    await app.close();
  }
});

test("owner invitation stores only the sha256 hash and expires in 72 hours", async () => {
  const pool = createFakePool();
  const { app } = await twoUserApp(pool);
  try {
    pool.always(/INSERT INTO family_invites/, {
      rows: [{
        id: "invite-1",
        family_id: "family-1",
        token_hash: "placeholder",
        created_by: "user-1",
        expires_at: new Date(Date.now() + 72 * 3600_000).toISOString(),
        used_at: null,
        used_by: null,
        created_at: new Date().toISOString(),
      }],
      rowCount: 1,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/families/invitations",
      ...ownerHeader(),
    });
    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.match(body.invitationCode, /^[0-9a-f]{32}$/);
    assert.match(body.expiresAt, /^\d{4}-\d{2}-\d{2}T/);

    // 库内只存哈希，绝不落明文；有效期约 72 小时。
    const insert = pool.callsMatching(/INSERT INTO family_invites/)[0];
    assert.equal(insert.params[1], sha256hex(body.invitationCode));
    assert.notEqual(insert.params[1], body.invitationCode);
    const expiresAt = new Date(body.expiresAt).getTime();
    const hours = (expiresAt - Date.now()) / 3600_000;
    assert.ok(hours > 71 && hours <= 72, `expiresAt should be ~72h ahead, got ${hours}h`);
  } finally {
    await app.close();
  }
});

test("a logged-in user without a family accepts a valid invitation as member", async () => {
  const pool = createFakePool();
  const gateway = createTestGateway({ "js-nobody": "openid-nobody" });
  scriptMultiUserSessions(pool, [
    { token: OWNER_TOKEN, userId: "user-1", openid: "openid-owner", membership: membershipRow({ id: "membership-1", role: "owner", user_id: "user-1" }) },
    { token: "3".repeat(64), userId: "user-9", openid: "openid-nobody", membership: null },
  ]);
  const app = await createApp(pool, gateway);
  try {
    const code = "valid-invite-code";
    pool.always(/FROM family_invites WHERE token_hash/, (sql, params) => {
      return params[0] === sha256hex(code)
        ? { rows: [{ id: "invite-1", family_id: "family-1", token_hash: params[0], created_by: "user-1", expires_at: new Date(Date.now() + 3600_000).toISOString(), used_at: null, used_by: null, created_at: new Date().toISOString() }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    });
    pool.on(/UPDATE family_invites SET/, {
      rows: [{ id: "invite-1", family_id: "family-1", used_at: new Date().toISOString(), used_by: "user-9" }],
      rowCount: 1,
    });
    pool.on(/INSERT INTO family_members/, {
      rows: [{ id: "membership-9", family_id: "family-1", user_id: "user-9", role: "member", joined_at: new Date().toISOString() }],
      rowCount: 1,
    });
    pool.always(/FROM families WHERE id/, { rows: [familyRow({ id: "family-1" })], rowCount: 1 });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/families/invitations/accept",
      headers: { authorization: "Bearer " + "3".repeat(64) },
      payload: { code },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.family.id, "family-1");
    assert.equal(body.membership.role, "member");

    const insert = pool.callsMatching(/INSERT INTO family_members/)[0];
    assert.equal(insert.params[0], "family-1");
    assert.equal(insert.params[1], "user-9");
    assert.equal(insert.params[2], "member");
    assert.equal(pool.callsMatching(/BEGIN/).length, 1);
    assert.equal(pool.callsMatching(/COMMIT/).length, 1);
  } finally {
    await app.close();
  }
});

test("an already-used invitation is rejected with 410 INVITATION_USED", async () => {
  const pool = createFakePool();
  const { app } = await twoUserApp(pool);
  try {
    // user-9 无家庭，拿到已被消费过的邀请。
    scriptMultiUserSessions(pool, [
      { token: "3".repeat(64), userId: "user-9", openid: "openid-nobody", membership: null },
    ]);
    const code = "used-invite-code";
    pool.always(/FROM family_invites WHERE token_hash/, (sql, params) => {
      return params[0] === sha256hex(code)
        ? { rows: [{ id: "invite-1", family_id: "family-1", token_hash: params[0], created_by: "user-1", expires_at: new Date(Date.now() + 3600_000).toISOString(), used_at: new Date().toISOString(), used_by: "user-2", created_at: new Date().toISOString() }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/families/invitations/accept",
      headers: { authorization: "Bearer " + "3".repeat(64) },
      payload: { code },
    });
    assert.equal(response.statusCode, 410);
    assert.equal(response.json().error.code, "INVITATION_USED");
    assert.equal(pool.callsMatching(/INSERT INTO family_members/).length, 0);
  } finally {
    await app.close();
  }
});

test("an expired invitation is rejected with 410 INVITATION_EXPIRED", async () => {
  const pool = createFakePool();
  const { app } = await twoUserApp(pool);
  try {
    scriptMultiUserSessions(pool, [
      { token: "3".repeat(64), userId: "user-9", openid: "openid-nobody", membership: null },
    ]);
    const code = "stale-invite-code";
    pool.always(/FROM family_invites WHERE token_hash/, (sql, params) => {
      return params[0] === sha256hex(code)
        ? { rows: [{ id: "invite-1", family_id: "family-1", token_hash: params[0], created_by: "user-1", expires_at: new Date(Date.now() - 1000).toISOString(), used_at: null, used_by: null, created_at: new Date().toISOString() }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/families/invitations/accept",
      headers: { authorization: "Bearer " + "3".repeat(64) },
      payload: { code },
    });
    assert.equal(response.statusCode, 410);
    assert.equal(response.json().error.code, "INVITATION_EXPIRED");
  } finally {
    await app.close();
  }
});

test("an unknown invitation code is a 404 that leaks nothing; blank code is 400", async () => {
  const pool = createFakePool();
  const { app } = await twoUserApp(pool);
  try {
    scriptMultiUserSessions(pool, [
      { token: "3".repeat(64), userId: "user-9", openid: "openid-nobody", membership: null },
    ]);
    pool.always(/FROM family_invites WHERE token_hash/, { rows: [], rowCount: 0 });

    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/families/invitations/accept",
      headers: { authorization: "Bearer " + "3".repeat(64) },
      payload: { code: "not-a-real-code" },
    });
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.json().error.code, "NOT_FOUND");

    const blank = await app.inject({
      method: "POST",
      url: "/api/v1/families/invitations/accept",
      headers: { authorization: "Bearer " + "3".repeat(64) },
      payload: { code: "   " },
    });
    assert.equal(blank.statusCode, 400);
    assert.equal(blank.json().error.code, "VALIDATION_ERROR");
  } finally {
    await app.close();
  }
});

test("a user already in a family cannot accept another invitation (409, invite not consumed)", async () => {
  const pool = createFakePool();
  const { app } = await twoUserApp(pool);
  try {
    const code = "any-valid-code";
    pool.always(/FROM family_invites WHERE token_hash/, (sql, params) => {
      return params[0] === sha256hex(code)
        ? { rows: [{ id: "invite-1", family_id: "family-2", token_hash: params[0], created_by: "user-3", expires_at: new Date(Date.now() + 3600_000).toISOString(), used_at: null, used_by: null, created_at: new Date().toISOString() }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    });

    // user-2 已在 family-1（twoUserApp 脚本）。
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/families/invitations/accept",
      ...memberHeader(),
      payload: { code },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "ALREADY_IN_FAMILY");
    assert.equal(pool.callsMatching(/INSERT INTO family_members/).length, 0);
    assert.equal(pool.callsMatching(/UPDATE family_invites SET/).length, 0);
  } finally {
    await app.close();
  }
});

test("after acceptance the new member can read the family inventory", async () => {
  const pool = createFakePool();
  const { app } = await twoUserApp(pool);
  try {
    seedMedicines(pool, [medicineRow({ id: "m-1", name: "家庭共享药" })], [
      batchRow({ id: "b-1", medicine_id: "m-1", quantity: 1 }),
    ]);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/medicines",
      ...memberHeader(),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().medicines.length, 1);
    assert.equal(response.json().medicines[0].name, "家庭共享药");
  } finally {
    await app.close();
  }
});

test("owner removing a member revokes access for that member's existing token immediately", async () => {
  const pool = createFakePool();
  const { app, sessions } = await twoUserApp(pool);
  try {
    pool.always(/FROM family_members WHERE id/, {
      rows: [membershipRow({ id: "membership-2", role: "member", user_id: "user-2" })],
      rowCount: 1,
    });
    pool.on(/DELETE FROM family_members/, { rows: [{ id: "membership-2" }], rowCount: 1 });

    const removal = await app.inject({
      method: "DELETE",
      url: "/api/v1/families/members/membership-2",
      ...ownerHeader(),
    });
    assert.equal(removal.statusCode, 204);

    const removalCall = pool.callsMatching(/DELETE FROM family_members/)[0];
    assert.deepEqual(removalCall.params, ["membership-2", "family-1"]);

    // 被移除成员的原令牌：成员关系查不到 → 404 FAMILY_NOT_FOUND（会话不撤销，从设计文档）。
    sessions.removeMembership("user-2");
    const revoked = await app.inject({
      method: "GET",
      url: "/api/v1/medicines",
      ...memberHeader(),
    });
    assert.equal(revoked.statusCode, 404);
    assert.equal(revoked.json().error.code, "FAMILY_NOT_FOUND");
  } finally {
    await app.close();
  }
});

test("removal updates the member list seen by GET /families/current", async () => {
  const pool = createFakePool();
  const { app } = await twoUserApp(pool);
  try {
    pool.always(/FROM families WHERE id/, { rows: [familyRow({ id: "family-1" })], rowCount: 1 });
    pool.always(/FROM family_members fm/, {
      rows: [
        membershipRow({ id: "membership-1", role: "owner", user_id: "user-1", nickname: null }),
      ],
      rowCount: 1,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/families/current",
      ...ownerHeader(),
    });
    assert.equal(response.statusCode, 200);
    const members = response.json().family.members;
    assert.equal(members.length, 1);
    assert.equal(members[0].role, "owner");
    // 成员身份展示（审核修复 #6）：昵称缺省 → 按加入顺序稳定标签；本人标注。
    assert.equal(members[0].displayName, "成员 1");
    assert.equal(members[0].isSelf, true);
  } finally {
    await app.close();
  }
});

test("non-owner cannot remove members; owner/self and owner removal are forbidden", async () => {
  const pool = createFakePool();
  const { app } = await twoUserApp(pool);
  try {
    // 成员尝试移除 → 403 OWNER_ONLY（查成员之前先校验角色）。
    const memberAttempt = await app.inject({
      method: "DELETE",
      url: "/api/v1/families/members/membership-1",
      ...memberHeader(),
    });
    assert.equal(memberAttempt.statusCode, 403);
    assert.equal(memberAttempt.json().error.code, "OWNER_ONLY");

    // owner 移除自己 → 403 FORBIDDEN（D3）。
    pool.always(/FROM family_members WHERE id/, {
      rows: [membershipRow({ id: "membership-1", role: "owner", user_id: "user-1" })],
      rowCount: 1,
    });
    const selfRemoval = await app.inject({
      method: "DELETE",
      url: "/api/v1/families/members/membership-1",
      ...ownerHeader(),
    });
    assert.equal(selfRemoval.statusCode, 403);
    assert.equal(selfRemoval.json().error.code, "FORBIDDEN");

    // owner 移除另一个 owner（防御）→ 403。
    pool.always(/FROM family_members WHERE id/, {
      rows: [membershipRow({ id: "membership-9", role: "owner", user_id: "user-9" })],
      rowCount: 1,
    });
    const ownerRemoval = await app.inject({
      method: "DELETE",
      url: "/api/v1/families/members/membership-9",
      ...ownerHeader(),
    });
    assert.equal(ownerRemoval.statusCode, 403);
    assert.equal(ownerRemoval.json().error.code, "FORBIDDEN");

    // 不存在的成员 → 404。
    pool.always(/FROM family_members WHERE id/, { rows: [], rowCount: 0 });
    const missing = await app.inject({
      method: "DELETE",
      url: "/api/v1/families/members/membership-404",
      ...ownerHeader(),
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "NOT_FOUND");
  } finally {
    await app.close();
  }
});

test("private notes stay invisible to others (404 on edit); family notes are readable but read-only", async () => {
  const pool = createFakePool();
  const { app } = await twoUserApp(pool);
  try {
    pool.always(/FROM medicines WHERE id/, { rows: [medicineRow({ id: "m-1" })], rowCount: 1 });
    // 备注属 owner（user-1）：他人的 owned 查询按 user_id 绑定 → user-2 查不到。
    pool.always(/FROM dosage_notes WHERE id/, (sql, params) => {
      return params[3] === "user-1"
        ? { rows: [noteRow({ id: "n-1", user_id: "user-1", visibility: "family", version: 1 })], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    });
    pool.always(/FROM dosage_notes WHERE medicine_id/, (sql, params) => {
      // 列表可见性：viewer=user-2 时仅 family 可见备注出现。
      return params[2] === "user-1"
        ? { rows: [noteRow({ id: "n-1", user_id: "user-1", visibility: "family" })], rowCount: 1 }
        : { rows: [noteRow({ id: "n-1", user_id: "user-1", visibility: "family" })], rowCount: 1 };
    });

    // 他人（member）尝试编辑 family 可见备注 → 404（owned 查询绑 user_id）。
    const foreignEdit = await app.inject({
      method: "PUT",
      url: "/api/v1/medicines/m-1/dosage-notes/n-1",
      ...memberHeader(),
      payload: { content: "试图修改他人备注", version: 1 },
    });
    assert.equal(foreignEdit.statusCode, 404);

    // member 能读 family 可见备注，isMine=false。
    const memberRead = await app.inject({
      method: "GET",
      url: "/api/v1/medicines/m-1/dosage-notes",
      ...memberHeader(),
    });
    assert.equal(memberRead.statusCode, 200);
    const notes = memberRead.json().notes;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].isMine, false);

    // 私有备注不在列表脚本中（真实库由 SQL 过滤），这里验证谓词存在。
    const listQuery = pool.callsMatching(/FROM dosage_notes WHERE medicine_id/)[0];
    assert.match(listQuery.sql, /user_id = \$3 OR visibility = 'family'/);
  } finally {
    await app.close();
  }
});

test("markdown export respects note visibility per viewer", async () => {
  const pool = createFakePool();
  const { app } = await twoUserApp(pool);
  try {
    seedMedicines(pool, [medicineRow({ id: "m-1", name: "共享药" })], [
      batchRow({ id: "b-1", medicine_id: "m-1", quantity: 1 }),
    ]);
    // 按查看者过滤：owner 看到本人（含私有）+ 家庭成员备注；member 只看到 family 可见的那些。
    pool.always(/FROM dosage_notes WHERE medicine_id/, (sql, params) => {
      const viewer = params[2];
      const rows =
        viewer === "user-1"
          ? [
              noteRow({ id: "n-1", user_id: "user-1", visibility: "private", content: "我的私有剂量" }),
              noteRow({ id: "n-2", user_id: "user-2", visibility: "family", content: "饭后服用" }),
            ]
          : [
              noteRow({ id: "n-2", user_id: "user-2", visibility: "family", content: "饭后服用" }),
              noteRow({ id: "n-3", user_id: "user-1", visibility: "family", content: "每晚一片" }),
            ];
      return { rows, rowCount: rows.length };
    });

    const ownerExport = await app.inject({
      method: "POST",
      url: "/api/v1/exports/markdown",
      ...ownerHeader(),
      payload: { includePersonalDosage: true },
    });
    assert.equal(ownerExport.statusCode, 200);
    assert.ok(ownerExport.json().markdown.includes("- 本人：我的私有剂量"));
    assert.ok(ownerExport.json().markdown.includes("- 家庭成员：饭后服用"));

    const memberExport = await app.inject({
      method: "POST",
      url: "/api/v1/exports/markdown",
      ...memberHeader(),
      payload: { includePersonalDosage: true },
    });
    assert.equal(memberExport.statusCode, 200);
    const memberMarkdown = memberExport.json().markdown;
    assert.ok(memberMarkdown.includes("- 本人：饭后服用"), "member sees own family note as 本人");
    assert.ok(memberMarkdown.includes("- 家庭成员：每晚一片"), "member sees owner's family note as 家庭成员");
    assert.equal(memberMarkdown.includes("我的私有剂量"), false, "owner 私有备注不进 member 导出");
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// D3 决策更新（2026-09-24）：成员自助退出 + 所有权转让
// ---------------------------------------------------------------------------

test("member can leave the family and immediately loses access", async () => {
  const pool = createFakePool();
  const { app, sessions } = await twoUserApp(pool);
  try {
    pool.always(/DELETE FROM family_members WHERE user_id/, {
      rows: [{ id: "membership-2" }],
      rowCount: 1,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/families/leave",
      ...memberHeader(),
    });
    assert.equal(response.statusCode, 204);
    assert.equal(pool.callsMatching(/DELETE FROM family_members WHERE user_id/).length, 1);

    // 退出后成员关系消失：同一令牌的后续请求立即 404 FAMILY_NOT_FOUND。
    sessions.removeMembership("user-2");
    const after = await app.inject({
      method: "GET",
      url: "/api/v1/medicines",
      ...memberHeader(),
    });
    assert.equal(after.statusCode, 404);
    assert.equal(after.json().error.code, "FAMILY_NOT_FOUND");
  } finally {
    await app.close();
  }
});

test("owner cannot leave while other members exist (must transfer first)", async () => {
  const pool = createFakePool();
  const { app } = await twoUserApp(pool);
  try {
    pool.always(/COUNT\(\*\)::int AS count FROM family_members/, {
      rows: [{ count: 2 }],
      rowCount: 1,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/families/leave",
      ...ownerHeader(),
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "OWNER_CANNOT_LEAVE");
    assert.equal(pool.callsMatching(/DELETE FROM family_members/).length, 0);
  } finally {
    await app.close();
  }
});

test("owner cannot leave a family with no other members until P4 defines dissolution", async () => {
  const pool = createFakePool();
  const { app } = await twoUserApp(pool);
  try {
    pool.always(/COUNT\(\*\)::int AS count FROM family_members/, {
      rows: [{ count: 1 }],
      rowCount: 1,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/families/leave",
      ...ownerHeader(),
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "OWNER_CANNOT_LEAVE");
    assert.equal(pool.callsMatching(/DELETE FROM family_members/).length, 0);
  } finally {
    await app.close();
  }
});

test("owner transfer swaps roles in one transaction and the ex-owner can leave", async () => {
  const pool = createFakePool();
  const ownerMembership = membershipRow({ id: "membership-1", role: "owner", user_id: "user-1" });
  const gateway = createTestGateway({
    "js-owner": "openid-owner",
    "js-member": "openid-member",
  });
  scriptMultiUserSessions(pool, [
    { token: OWNER_TOKEN, userId: "user-1", openid: "openid-owner", membership: ownerMembership },
    { token: MEMBER_TOKEN, userId: "user-2", openid: "openid-member", membership: membershipRow({ id: "membership-2", role: "member", user_id: "user-2" }) },
  ]);
  const app = await createApp(pool, gateway);
  try {
    // 转让事务先 FOR UPDATE 锁家庭行（审核修复 #4 的并发串行化）。
    pool.always(/FROM families WHERE id = \$1 FOR UPDATE/, {
      rows: [{ id: "family-1" }],
      rowCount: 1,
    });
    pool.always(/FROM family_members WHERE id = \$1 AND family_id/, {
      rows: [membershipRow({ id: "membership-2", role: "member", user_id: "user-2" })],
      rowCount: 1,
    });
    pool.always(/UPDATE family_members SET role = \$3 WHERE id = \$1 AND family_id = \$2/, {
      rows: [membershipRow({ id: "membership-2", role: "owner", user_id: "user-2" })],
      rowCount: 1,
    });
    pool.always(/UPDATE family_members SET role = \$3 WHERE user_id = \$1 AND family_id = \$2/, {
      rows: [membershipRow({ id: "membership-1", role: "member", user_id: "user-1" })],
      rowCount: 1,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/families/members/membership-2/transfer-ownership",
      ...ownerHeader(),
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.membership.id, "membership-2");
    assert.equal(body.membership.role, "owner");
    assert.equal(pool.callsMatching(/UPDATE family_members SET role/).length, 2);

    // 转让后原 owner 变为普通成员，即可自助退出。
    ownerMembership.role = "member";
    pool.always(/DELETE FROM family_members WHERE user_id/, {
      rows: [{ id: "membership-1" }],
      rowCount: 1,
    });
    const leave = await app.inject({
      method: "POST",
      url: "/api/v1/families/leave",
      ...ownerHeader(),
    });
    assert.equal(leave.statusCode, 204);
  } finally {
    await app.close();
  }
});

test("only the owner can transfer ownership (member gets 403 OWNER_ONLY)", async () => {
  const pool = createFakePool();
  const { app } = await twoUserApp(pool);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/families/members/membership-1/transfer-ownership",
      ...memberHeader(),
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "OWNER_ONLY");
    assert.equal(pool.callsMatching(/UPDATE family_members SET role/).length, 0);
  } finally {
    await app.close();
  }
});

test("transfer rejects self-target and unknown members", async () => {
  const pool = createFakePool();
  const { app } = await twoUserApp(pool);
  try {
    // 转让事务先 FOR UPDATE 锁家庭行。
    pool.always(/FROM families WHERE id = \$1 FOR UPDATE/, {
      rows: [{ id: "family-1" }],
      rowCount: 1,
    });
    // 第一次查找命中 owner 自己的成员关系 → 自转让 400；
    // 第二次查找为空 → 目标不存在 404。
    pool.on(/FROM family_members WHERE id = \$1 AND family_id/, {
      rows: [membershipRow({ id: "membership-1", role: "owner", user_id: "user-1" })],
      rowCount: 1,
    });
    const selfResponse = await app.inject({
      method: "POST",
      url: "/api/v1/families/members/membership-1/transfer-ownership",
      ...ownerHeader(),
    });
    assert.equal(selfResponse.statusCode, 400);
    assert.equal(selfResponse.json().error.code, "VALIDATION_ERROR");

    pool.on(/FROM family_members WHERE id = \$1 AND family_id/, { rows: [], rowCount: 0 });
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/families/members/membership-x/transfer-ownership",
      ...ownerHeader(),
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "NOT_FOUND");
  } finally {
    await app.close();
  }
});
