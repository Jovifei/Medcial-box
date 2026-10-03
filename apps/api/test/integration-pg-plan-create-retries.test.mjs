// Synthetic-only PostgreSQL receipts, rollback and current-authorization probes.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { applyMigrations } from "../dist/db/migrations.js";
import { buildServer } from "../dist/app.js";
import { issueSessionToken } from "../dist/auth/session.js";
import { isolatedPostgres, contend } from "./helpers/isolated-pg.mjs";

const url = process.env.TEST_DATABASE_URL?.trim() ?? "";
const required = process.env.REQUIRE_POSTGRES_TESTS === "1";
const status = (response, expected = 201) => { assert.equal(response.statusCode, expected, response.body); return response.json(); };
const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

test("real PostgreSQL: plan creation receipts preserve retry identity and current authorization", {
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
    async function user() {
      const id = randomUUID(); await pool.query("INSERT INTO users(id,openid) VALUES($1,$2)", [id, `synthetic-plan-${id}`]);
      return { id, ...await issueSessionToken(database, id) };
    }
    async function group(existingOwner) {
      const owner = existingOwner ?? await user(); const member = await user(); const id = randomUUID();
      await pool.query("INSERT INTO families(id,name,created_by) VALUES($1,'Synthetic plan family',$2)", [id, owner.id]);
      for (const [who, role] of [[owner, "owner"], [member, "member"]]) await pool.query("INSERT INTO family_members(family_id,user_id,role) VALUES($1,$2,$3)", [id, who.id, role]);
      const profileId = randomUUID(); const medicineId = randomUUID();
      await pool.query("INSERT INTO care_profiles(id,family_id,display_name,created_by) VALUES($1,$2,'Synthetic patient',$3)", [profileId, id, owner.id]);
      await pool.query("INSERT INTO care_grants(family_id,care_profile_id,member_user_id,can_manage,created_by) VALUES($1,$2,$3,true,$4)", [id, profileId, member.id, owner.id]);
      await pool.query("INSERT INTO medicines(id,family_id,name,created_by,updated_by) VALUES($1,$2,'Synthetic medicine',$3,$3)", [medicineId, id, owner.id]);
      return { id, owner, member, profileId, medicineId };
    }
    function body(g, extra = {}) { return { careProfileId: g.profileId, medicineId: g.medicineId, medicineName: "Synthetic medicine", dosageText: "User-entered text", timeSlots: ["20:00", "08:00"], startDate: "2026-10-01", idempotencyKey: `plan-${randomUUID()}`, ...extra }; }
    const request = (who, method, path, payload) => app.inject({ method, url: `/api/v1${path}`, headers: { authorization: `Bearer ${who.token}` }, ...(payload === undefined ? {} : { payload }) });
    const create = (who, payload) => request(who, "POST", "/medication-plans", payload);
    async function counts(g) {
      return (await pool.query(`SELECT (SELECT count(*)::int FROM medication_plans WHERE family_id=$1) plans,
        (SELECT count(*)::int FROM plan_time_slots s JOIN medication_plans p ON p.id=s.plan_id WHERE p.family_id=$1) slots,
        (SELECT count(*)::int FROM medication_plan_create_receipts WHERE family_id=$1) receipts`, [g.id])).rows[0];
    }

    await t.test("migration 028 is additive, re-applicable and enforces scoped unique receipts", async () => {
      const applied = (await pool.query("SELECT name FROM schema_migrations WHERE name LIKE '028_%'")).rows.map(r => r.name);
      assert.deepEqual(applied, ["028_medication_plan_create_receipts.sql"]);
      assert.deepEqual(await applyMigrations(pool), []);
      const g = await group(); const data = body(g); status(await create(g.owner, data));
      await assert.rejects(pool.query("INSERT INTO medication_plan_create_receipts SELECT * FROM medication_plan_create_receipts WHERE family_id=$1", [g.id]), error => error.code === "23505");
    });

    await t.test("lost-response sequential retry returns complete original 201 after the plan changes", async () => {
      const g = await group(); const data = body(g);
      const first = status(await create(g.owner, data));
      assert.deepEqual(Object.keys(first).sort(), ["careProfileId", "planId", "status", "version"]);
      status(await request(g.owner, "POST", `/medication-plans/${first.planId}/pause`, { version: 1 }), 200);
      assert.deepEqual(status(await create(g.owner, data)), first);
      assert.equal((await pool.query("SELECT status FROM medication_plans WHERE id=$1", [first.planId])).rows[0].status, "paused");
      assert.deepEqual(await counts(g), { plans: 1, slots: 2, receipts: 1 });
    });

    await t.test("lost-response retry after linked medicine soft-delete recovers immutable ACK but new creation is rejected", async () => {
      const g = await group(); const data = body(g);
      const first = status(await create(g.owner, data));
      await pool.query("UPDATE medicines SET deleted_at=now() WHERE id=$1", [g.medicineId]);
      assert.deepEqual(status(await create(g.owner, data)), first);
      assert.deepEqual(await counts(g), { plans: 1, slots: 2, receipts: 1 });
      status(await create(g.owner, { ...data, idempotencyKey: randomUUID() }), 404);
      assert.deepEqual(await counts(g), { plans: 1, slots: 2, receipts: 1 });
      await pool.query("UPDATE care_profiles SET archived_at=now() WHERE id=$1", [g.profileId]);
      status(await create(g.owner, data), 404);
    });

    await t.test("canonical normalization handles trimmed text and ids, reordered slots and duplicate weekdays", async () => {
      const g = await group(); const data = body(g, { weekdays: ["wed", "mon", "mon"], endDate: "" });
      const first = status(await create(g.owner, data));
      const retry = { ...data, careProfileId: ` ${g.profileId.toUpperCase()} `, medicineId: ` ${g.medicineId.toUpperCase()} `, medicineName: " Synthetic medicine ", dosageText: " User-entered text ", startDate: " 2026-10-01 ", endDate: null, timeSlots: ["08:00", "20:00"], weekdays: ["mon", "wed"], ignoredField: "not stored" };
      assert.deepEqual(status(await create(g.owner, Object.fromEntries(Object.entries(retry).reverse()))), first);
      const row = (await pool.query("SELECT weekdays,medicine_name FROM medication_plans WHERE id=$1", [first.planId])).rows[0];
      assert.deepEqual(row.weekdays, ["mon", "wed"]); assert.equal(row.medicine_name, "Synthetic medicine");
      assert.deepEqual(await counts(g), { plans: 1, slots: 2, receipts: 1 });
    });

    await t.test("omitted optional values and explicit defaults share one identity", async () => {
      const g = await group(); const data = body(g); delete data.medicineId;
      const first = status(await create(g.owner, data));
      assert.deepEqual(status(await create(g.owner, { ...data, medicineId: " ", endDate: "", weekdays: [...weekdays].reverse() })), first);
      assert.deepEqual(await counts(g), { plans: 1, slots: 2, receipts: 1 });
    });

    await t.test("same key with changed normalized content conflicts, while a new key is explicit new intent", async () => {
      const g = await group(); const data = body(g); const first = status(await create(g.owner, data));
      const secondProfile = randomUUID();
      await pool.query("INSERT INTO care_profiles(id,family_id,display_name,created_by) VALUES($1,$2,'Second patient',$3)", [secondProfile, g.id, g.owner.id]);
      for (const change of [{ careProfileId: secondProfile }, { medicineId: null }, { medicineName: "Changed" }, { dosageText: "Changed" }, { timeSlots: ["09:00"] }, { weekdays: ["mon"] }, { startDate: "2026-10-02" }, { endDate: "2026-10-31" }]) {
        const result = status(await create(g.owner, { ...data, ...change }), 409); assert.equal(result.error.code, "VERSION_CONFLICT");
      }
      assert.deepEqual(await counts(g), { plans: 1, slots: 2, receipts: 1 });
      const second = status(await create(g.owner, { ...data, idempotencyKey: randomUUID() })); assert.notEqual(second.planId, first.planId);
    });

    await t.test("key validation rejects every invalid supplied type/shape before mutation", async () => {
      const g = await group();
      for (const idempotencyKey of [null, 1, {}, [], "", "a".repeat(15), "a".repeat(129), "this key contains spaces", " key-0000000000001", "key-0000000000001\n"]) status(await create(g.owner, body(g, { idempotencyKey })), 400);
      assert.deepEqual(await counts(g), { plans: 0, slots: 0, receipts: 0 });
      for (const idempotencyKey of ["a".repeat(16), "A_-".repeat(42) + "ab"]) status(await create(g.owner, body(g, { idempotencyKey })));
    });

    await t.test("legacy keyless calls intentionally remain independent", async () => {
      const g = await group(); const data = body(g); delete data.idempotencyKey;
      const first = status(await create(g.owner, data)); const second = status(await create(g.owner, data)); assert.notEqual(first.planId, second.planId);
      assert.deepEqual(await counts(g), { plans: 2, slots: 4, receipts: 0 });
    });

    await t.test("same key is independently scoped by user and by family", async () => {
      const g = await group(); const data = body(g); const first = status(await create(g.owner, data));
      const second = status(await create(g.member, data)); assert.notEqual(second.planId, first.planId);
      assert.deepEqual(await counts(g), { plans: 2, slots: 4, receipts: 2 });
      await pool.query("DELETE FROM family_members WHERE user_id=$1", [g.owner.id]);
      const next = await group(g.owner);
      const third = status(await create(g.owner, body(next, { idempotencyKey: data.idempotencyKey }))); assert.notEqual(third.planId, first.planId);
      assert.deepEqual(await counts(next), { plans: 1, slots: 2, receipts: 1 });
    });

    await t.test("real simultaneous same-key calls contend and produce exactly one plan and receipt", async () => {
      const g = await group(); const data = body(g);
      const results = await contend(fixture, /pg_advisory_xact_lock/, () => create(g.owner, data), () => create(g.owner, data));
      assert.deepEqual(status(results[0]), status(results[1]));
      assert.deepEqual(await counts(g), { plans: 1, slots: 2, receipts: 1 });
    });

    await t.test("real simultaneous changed-payload reuse waits then returns 409", async () => {
      const g = await group(); const data = body(g);
      const results = await contend(fixture, /pg_advisory_xact_lock/, () => create(g.owner, data), () => create(g.owner, { ...data, dosageText: "Changed" }));
      status(results[0]); status(results[1], 409);
      assert.deepEqual(await counts(g), { plans: 1, slots: 2, receipts: 1 });
    });

    for (const stage of ["slot", "receipt"]) {
      await t.test(`${stage} write failure rolls back plan, all slots and receipt; explicit retry succeeds`, async () => {
        const g = await group(); const data = body(g); let seen = 0;
        fixture.observe = async ({ sql, run }) => {
          if (stage === "slot" && /INSERT INTO plan_time_slots/.test(sql) && ++seen === 2) throw new Error("Synthetic second slot failure");
          if (stage === "receipt" && /INSERT INTO medication_plan_create_receipts/.test(sql)) throw new Error("Synthetic receipt failure");
          return run();
        };
        try { status(await create(g.owner, data), 500); } finally { fixture.observe = null; }
        assert.deepEqual(await counts(g), { plans: 0, slots: 0, receipts: 0 });
        status(await create(g.owner, data)); assert.deepEqual(await counts(g), { plans: 1, slots: 2, receipts: 1 });
      });
    }

    for (const replay of [false, true]) {
      for (const boundary of ["membership", "grant", "profile", "medicine", "manager"]) {
        await t.test(`${replay ? "replay" : "create"} handles ${boundary} changed after authentication and before transaction`, async () => {
          const g = await group(); const actor = boundary === "manager" ? g.owner : g.member; const data = body(g);
          if (replay) status(await create(actor, data));
          const changes = {
            membership: () => pool.query("DELETE FROM family_members WHERE user_id=$1", [actor.id]),
            grant: () => pool.query("DELETE FROM care_grants WHERE care_profile_id=$1 AND member_user_id=$2", [g.profileId, actor.id]),
            profile: () => pool.query("UPDATE care_profiles SET archived_at=now() WHERE id=$1", [g.profileId]),
            medicine: () => pool.query("UPDATE medicines SET deleted_at=now() WHERE id=$1", [g.medicineId]),
            manager: () => pool.query("UPDATE care_profiles SET managed_by=$1 WHERE id=$2", [g.member.id, g.profileId]),
          };
          beforeTransaction = changes[boundary];
          try { status(await create(actor, data), replay && boundary === "medicine" ? 201 : ["grant", "manager"].includes(boundary) ? 403 : 404); } finally { beforeTransaction = null; }
          assert.deepEqual(await counts(g), { plans: replay ? 1 : 0, slots: replay ? 2 : 0, receipts: replay ? 1 : 0 });
        });
      }
    }

    await t.test("private linked profiles reject other members even with historical manage grants", async () => {
      const g = await group(); await pool.query("UPDATE care_profiles SET linked_user_id=$1 WHERE id=$2", [g.member.id, g.profileId]);
      status(await create(g.owner, body(g)), 403);
      status(await create(g.member, body(g)));
      const other = await group(); status(await create(other.owner, body(g)), 404);
      status(await create(g.member, body(g, { medicineId: other.medicineId })), 404);
      assert.deepEqual(await counts(g), { plans: 1, slots: 2, receipts: 1 });
    });

    for (const replay of [false, true]) {
      await t.test(`${replay ? "replay" : "creation"} holds current management grant until commit against concurrent revocation`, async () => {
        const g = await group(); const data = body(g); if (replay) status(await create(g.member, data));
        const [created] = await contend(fixture, /FROM care_grants[\s\S]*FOR SHARE|DELETE FROM care_grants/, () => create(g.member, data), () => database.withTransaction(tx => tx.query("DELETE FROM care_grants WHERE care_profile_id=$1 AND member_user_id=$2", [g.profileId, g.member.id])));
        status(created);
        status(await create(g.member, data), 403);
        assert.deepEqual(await counts(g), { plans: 1, slots: 2, receipts: 1 });
      });
    }
  } finally { beforeTransaction = null; fixture.observe = null; if (app) await app.close(); await fixture.close(); }
});
