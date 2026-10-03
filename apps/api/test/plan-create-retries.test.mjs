import assert from "node:assert/strict";
import test from "node:test";
import { createApp, scriptMultiUserSessions, authHeader, TOKEN } from "./helpers/app.mjs";
import { createFakePool } from "./helpers/fake-pool.mjs";

const path = "/api/v1/medication-plans";
const payload = (extra = {}) => ({ careProfileId: "profile-1", medicineName: "Synthetic medicine", dosageText: "User-entered text", timeSlots: ["20:00", "08:00"], startDate: "2026-10-01", idempotencyKey: "synthetic-plan-key-0001", ...extra });

async function fixture() {
  const database = createFakePool();
  scriptMultiUserSessions(database, [{ token: TOKEN, userId: "user-1", openid: "synthetic", membership: { id: "membership-1", family_id: "family-1", role: "owner" } }]);
  const state = { member: true, profile: true, manager: true, medicine: true, receipts: new Map(), inserts: 0, failSlot: false };
  database.always(/FROM families WHERE/, [{ id: "family-1" }]);
  database.always(/FROM family_members WHERE family_id/, () => state.member ? [{ id: "membership-1" }] : []);
  database.always(/FROM care_profiles WHERE id/, () => state.profile ? [{ id: "profile-1", display_name: "Synthetic profile", linked_user_id: null, created_by: "other-user" }] : []);
  database.always(/FROM care_grants WHERE/, () => [{ can_view: true, can_manage: state.manager }]);
  database.always(/FROM medicines WHERE/, () => state.medicine ? [{ id: "medicine-1" }] : []);
  database.always(/INSERT INTO medication_plans/, () => [{ id: `plan-${++state.inserts}` }]);
  database.always(/INSERT INTO plan_time_slots/, () => { if (state.failSlot) throw new Error("synthetic slot write failure"); return []; });
  database.always(/SELECT payload_hash, response FROM medication_plan_create_receipts/, (_sql, params) => {
    const receipt = state.receipts.get(JSON.stringify(params)); return receipt ? [receipt] : [];
  });
  database.always(/INSERT INTO medication_plan_create_receipts/, (_sql, params) => {
    state.receipts.set(JSON.stringify(params.slice(0, 3)), { payload_hash: params[3], response: JSON.parse(params[4]) }); return [];
  });
  const app = await createApp(database);
  const post = (data) => app.inject({ method: "POST", url: path, ...authHeader(), payload: data });
  return { app, database, state, post };
}

async function using(fn) { const f = await fixture(); try { await fn(f); } finally { await f.app.close(); } }
const expect = (response, code) => { assert.equal(response.statusCode, code, response.body); return response.json(); };

test("plan create validates optional key with the medicine-create compatibility boundary", async () => using(async ({ post, state }) => {
  for (const idempotencyKey of [null, 1, "", "a".repeat(15), "a".repeat(129), "with spaces and symbols!", " key-0000000000001", "key-0000000000001\n"]) expect(await post(payload({ idempotencyKey })), 400);
  assert.equal(state.inserts, 0);
  for (const idempotencyKey of ["a".repeat(16), "A_-".repeat(42) + "ab"]) expect(await post(payload({ idempotencyKey })), 201);
}));

test("same-key retry returns every original 201 field and writes once", async () => using(async ({ post, state, database }) => {
  const original = expect(await post(payload()), 201);
  assert.deepEqual(Object.keys(original).sort(), ["careProfileId", "planId", "status", "version"]);
  assert.deepEqual(expect(await post(payload()), 201), original);
  assert.equal(state.inserts, 1);
  assert.equal(database.callsMatching(/INSERT INTO plan_time_slots/).length, 2);
  assert.equal(state.receipts.size, 1);
}));

test("committed receipt recovers the original ACK after bound medicine deletion without rerunning creation preconditions", async () => using(async ({ post, state, database }) => {
  const data = payload({ medicineId: "medicine-1" });
  const original = expect(await post(data), 201);
  state.medicine = false;
  const medicineReads = database.callsMatching(/FROM medicines WHERE/).length;
  assert.deepEqual(expect(await post(data), 201), original);
  assert.equal(database.callsMatching(/FROM medicines WHERE/).length, medicineReads);
  assert.equal(state.inserts, 1);
  expect(await post({ ...data, idempotencyKey: "synthetic-plan-key-0002" }), 404);
  assert.equal(state.inserts, 1);
}));

test("canonical payload ignores field order, trim-only text differences and unordered schedule sets", async () => using(async ({ post, state }) => {
  const original = expect(await post(payload({ medicineId: "  ", weekdays: ["wed", "mon", "mon"], endDate: "" })), 201);
  const retry = payload({ medicineName: "  Synthetic medicine  ", dosageText: " User-entered text ", timeSlots: ["08:00", "20:00"], weekdays: ["mon", "wed"], medicineId: null, endDate: null, ignoredField: true });
  assert.deepEqual(expect(await post(Object.fromEntries(Object.entries(retry).reverse())), 201), original);
  assert.equal(state.inserts, 1);
}));

test("omitted weekdays and explicit full week have one normalized identity", async () => using(async ({ post, state }) => {
  const original = expect(await post(payload()), 201);
  assert.deepEqual(expect(await post(payload({ weekdays: ["sun", "sat", "fri", "thu", "wed", "tue", "mon"] })), 201), original);
  assert.equal(state.inserts, 1);
}));

test("same key with any changed accepted plan field returns 409 without new writes", async () => using(async ({ post, state }) => {
  expect(await post(payload()), 201);
  for (const change of [{ careProfileId: "profile-2" }, { medicineId: "medicine-1" }, { medicineName: "Changed" }, { dosageText: "Changed" }, { timeSlots: ["09:00"] }, { weekdays: ["mon"] }, { startDate: "2026-10-02" }, { endDate: "2026-10-31" }]) {
    const result = expect(await post(payload(change)), 409); assert.equal(result.error.code, "VERSION_CONFLICT");
  }
  assert.equal(state.inserts, 1);
}));

test("legacy keyless requests remain independent and do not create receipts", async () => using(async ({ post, state }) => {
  const data = payload(); delete data.idempotencyKey;
  const first = expect(await post(data), 201); const second = expect(await post(data), 201);
  assert.notEqual(first.planId, second.planId); assert.equal(state.receipts.size, 0);
}));

test("new key intentionally creates a separate plan", async () => using(async ({ post, state }) => {
  const first = expect(await post(payload()), 201);
  const second = expect(await post(payload({ idempotencyKey: "synthetic-plan-key-0002" })), 201);
  assert.notEqual(first.planId, second.planId); assert.equal(state.receipts.size, 2);
}));

for (const replay of [false, true]) {
  test(`transaction-current membership, management and profile${replay ? " protect receipt replay" : " plus medicine protect new creation"}`, async () => using(async ({ post, state, database }) => {
    const data = payload({ medicineId: "medicine-1" });
    if (replay) expect(await post(data), 201);
    const start = state.inserts;
    for (const [field, code] of [["member", 404], ["manager", 403], ["profile", 404], ...(!replay ? [["medicine", 404]] : [])]) {
      state[field] = false;
      expect(await post(data), code);
      state[field] = true;
      assert.equal(state.inserts, start);
    }
    const checks = database.callsMatching(/FROM (family_members WHERE family_id|care_profiles WHERE id|care_grants WHERE|medicines WHERE)/);
    assert.ok(checks.every((call) => /FOR SHARE/.test(call.sql)), "current authorization rows must stay locked until commit");
  }));
}

test("membership and authorization checks run after BEGIN and before receipt reads", async () => using(async ({ post, database }) => {
  expect(await post(payload({ medicineId: "medicine-1" })), 201);
  const index = (pattern) => database.calls.findIndex((call) => pattern.test(call.sql));
  assert.ok(index(/^BEGIN$/) < index(/FROM care_profiles WHERE id/));
  assert.ok(index(/FROM family_members WHERE family_id/) < index(/FROM medication_plan_create_receipts/));
  assert.ok(index(/FROM medication_plan_create_receipts/) < index(/FROM medicines WHERE/));
  assert.ok(index(/INSERT INTO medication_plan_create_receipts/) < index(/^COMMIT$/));
}));

test("failed slot insertion rolls back before a receipt can be recorded", async () => using(async ({ post, state, database }) => {
  state.failSlot = true;
  expect(await post(payload()), 500);
  assert.equal(state.receipts.size, 0);
  assert.equal(database.callsMatching(/^ROLLBACK$/).length, 1);
  assert.equal(database.callsMatching(/^COMMIT$/).length, 0);
}));
