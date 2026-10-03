import assert from "node:assert/strict";
import test from "node:test";
import { createApp, scriptMultiUserSessions, authHeader, TOKEN } from "./helpers/app.mjs";
import { createFakePool } from "./helpers/fake-pool.mjs";

const originalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const replacementId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
async function using(fn) {
  const database = createFakePool();
  scriptMultiUserSessions(database, [{ token: TOKEN, userId: "user-1", openid: "synthetic", membership: { id: "membership-1", family_id: "family-1", role: "owner" } }]);
  const state = { medicineExists: true, conflict: false, member: true, profile: true, manager: true };
  database.always(/FROM medication_plans p JOIN care_profiles c/, [{ id: "plan-1", care_profile_id: "profile-1", medicine_id: originalId, medicine_name: "Original medicine", dosage_text: "User-entered text", weekdays: ["mon"], start_date: "2026-10-01", end_date: null, status: "active", version: 1, display_name: "Synthetic profile", linked_user_id: "user-1", created_by: "user-1" }]);
  database.always(/SELECT id, time_of_day::text/, [{ id: "slot-1", time_of_day: "08:00:00" }]);
  database.always(/FROM families WHERE/, [{ id: "family-1" }]);
  database.always(/FROM family_members WHERE family_id/, () => state.member ? [{ id: "membership-1" }] : []);
  database.always(/FROM care_profiles WHERE id/, () => state.profile ? [{ id: "profile-1", display_name: "Synthetic profile", linked_user_id: null, created_by: "other-user" }] : []);
  database.always(/FROM care_grants WHERE/, () => [{ can_view: true, can_manage: state.manager }]);
  database.always(/FROM medicines WHERE/, () => state.medicineExists ? [{ id: replacementId }] : []);
  database.always(/UPDATE medication_plans SET/, () => state.conflict ? [] : [{ version: 2 }]);
  const app = await createApp(database);
  const put = (payload) => app.inject({ method: "PUT", url: "/api/v1/medication-plans/plan-1", ...authHeader(), payload: { version: 1, ...payload } });
  try { await fn({ database, state, put }); } finally { await app.close(); }
}
const expect = (response, code) => { assert.equal(response.statusCode, code, response.body); return response.json(); };

// Observe the actual SQL contract, rather than inventing persistence in the fake pool.
function bindingWrite(database) {
  const call = database.callsMatching(/UPDATE medication_plans SET/)[0];
  assert.ok(call, "plan update must occur");
  const clause = call.sql.match(/medicine_id\s*=\s*CASE WHEN \$(\d+) THEN \$(\d+)::uuid ELSE medicine_id END/i);
  assert.ok(clause, "omission must preserve database binding; explicit null must unlink");
  return { supplied: call.params[Number(clause[1]) - 1], id: call.params[Number(clause[2]) - 1] };
}

test("plan update explicit null unlinks a manually renamed plan even after linked inventory deletion", async () => using(async ({ put, database, state }) => {
  state.medicineExists = false;
  expect(await put({ medicineId: null, medicineName: "Manual replacement" }), 200);
  assert.deepEqual(bindingWrite(database), { supplied: true, id: null });
  assert.equal(database.callsMatching(/FROM medicines WHERE/).length, 0);
}));

test("legacy plan update omission preserves binding without revalidating a deleted inventory item", async () => using(async ({ put, database, state }) => {
  state.medicineExists = false;
  expect(await put({ dosageText: "Changed user-entered text", timeSlots: ["09:00", "20:00"] }), 200);
  assert.deepEqual(bindingWrite(database), { supplied: false, id: null });
  assert.equal(database.callsMatching(/UPDATE medication_plans SET/)[0].params[3], "Changed user-entered text");
  assert.deepEqual(database.callsMatching(/INSERT INTO plan_time_slots/).map((call) => call.params[1]), ["09:00:00", "20:00:00"]);
  assert.equal(database.callsMatching(/FROM medicines WHERE/).length, 0);
}));

test("plan update links normalized explicit identity and locks current inventory in the same transaction", async () => using(async ({ put, database }) => {
  expect(await put({ medicineId: ` ${replacementId.toUpperCase()} `, medicineName: "User-entered label" }), 200);
  assert.deepEqual(bindingWrite(database), { supplied: true, id: replacementId });
  const [check] = database.callsMatching(/FROM medicines WHERE/);
  assert.deepEqual(check.params, [replacementId, "family-1"]);
  assert.match(check.sql, /family_id = \$2 AND deleted_at IS NULL FOR SHARE/);
  const index = (pattern) => database.calls.findIndex((call) => pattern.test(call.sql));
  assert.ok(index(/^BEGIN$/) < index(/FROM medicines WHERE/));
  assert.ok(index(/FROM medicines WHERE/) < index(/UPDATE medication_plans SET/));
  assert.ok(index(/UPDATE medication_plans SET/) < index(/^COMMIT$/));
}));

test("plan update rejects unavailable identity before plan, slot or occurrence writes", async () => using(async ({ put, database, state }) => {
  state.medicineExists = false;
  assert.equal(expect(await put({ medicineId: replacementId }), 404).error.code, "NOT_FOUND");
  assert.equal(database.callsMatching(/^(UPDATE|INSERT)/).length, 0);
}));

test("plan update explicitly resupplying the deleted existing binding is rejected without writes", async () => using(async ({ put, database, state }) => {
  state.medicineExists = false;
  assert.equal(expect(await put({ medicineId: originalId, dosageText: "Must not persist" }), 404).error.code, "NOT_FOUND");
  assert.deepEqual(database.callsMatching(/FROM medicines WHERE/)[0].params, [originalId, "family-1"]);
  assert.equal(database.callsMatching(/^(UPDATE|INSERT)/).length, 0);
}));

test("plan update rejects invalid medicineId types and malformed IDs without writing", async () => using(async ({ put, database }) => {
  for (const medicineId of ["", "  ", "not-a-uuid", 1, true, [], {}, `${replacementId}\nwrong`]) {
    assert.equal(expect(await put({ medicineId }), 400).error.code, "VALIDATION_ERROR");
  }
  assert.equal(database.callsMatching(/^(UPDATE|INSERT)/).length, 0);
}));

test("plan rebinding preserves version-conflict guard before touching schedules", async () => using(async ({ put, database, state }) => {
  state.conflict = true;
  assert.equal(expect(await put({ medicineId: replacementId }), 409).error.code, "VERSION_CONFLICT");
  assert.equal(database.callsMatching(/UPDATE plan_time_slots|INSERT INTO plan_time_slots|UPDATE dose_occurrences/).length, 0);
}));

for (const [field, code] of [["member", 404], ["profile", 404], ["manager", 403]]) {
  test(`plan rebinding rechecks current ${field} inside the transaction`, async () => using(async ({ put, database, state }) => {
    state[field] = false;
    expect(await put({ medicineId: replacementId }), code);
    assert.equal(database.callsMatching(/^(UPDATE|INSERT)/).length, 0);
  }));
}

test("plan update locks current family, membership, profile and grants before inventory and plan mutation", async () => using(async ({ put, database }) => {
  expect(await put({ medicineId: replacementId }), 200);
  const checks = database.callsMatching(/FROM (families WHERE|family_members WHERE family_id|care_profiles WHERE id|care_grants WHERE|medicines WHERE)/);
  assert.equal(checks.length, 5);
  assert.ok(checks.every((call) => /FOR SHARE/.test(call.sql)));
  const begin = database.calls.findIndex((call) => call.sql === "BEGIN");
  assert.ok(checks.every((call) => database.calls.indexOf(call) > begin));
}));
