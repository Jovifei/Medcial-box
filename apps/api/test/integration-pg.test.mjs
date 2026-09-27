// Real PostgreSQL only. WeChat identity exchange alone is a fake gateway.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { applyMigrations } from "../dist/db/migrations.js";
import { buildServer } from "../dist/app.js";
import { createTestGateway } from "./helpers/fake-wechat.mjs";
import { isolatedPostgres, contend, bounded, signal } from "./helpers/isolated-pg.mjs";

const url = process.env.TEST_DATABASE_URL?.trim() ?? "";
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
  let app;
  try {
    await t.test("fresh schema applies exactly 001–005, catalog is scoped, second migrate is empty", async () => {
      assert.deepEqual(await applyMigrations(pool), ["001_bootstrap.sql", "002_core_inventory.sql", "003_family_invites.sql", "004_family_single_owner.sql", "005_add_created_at_columns.sql"]);
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
    app = await buildServer({ database, wechatGateway: gateway, logger: false });
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
