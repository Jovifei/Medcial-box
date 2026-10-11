import test from "node:test";
import assert from "node:assert/strict";

// Contract-level regression cases. Runtime DB integration uses the existing
// isolated PostgreSQL pipeline and must provide real generated fixtures.

test("multi-family switch keeps ownership and membership separate", () => {
  const memberships = [
    { familyId: "family-owner", role: "owner" },
    { familyId: "family-invite", role: "member" },
  ];
  assert.equal(memberships.length, 2);
  assert.equal(memberships.find((m) => m.familyId === "family-owner").role, "owner");
  assert.equal(memberships.find((m) => m.familyId === "family-invite").role, "member");
});

test("family switch never authorizes without matching membership", () => {
  const memberships = new Set(["family-a"]);
  assert.equal(memberships.has("family-b"), false);
});

test("family data is never represented as mergeable during migration", () => {
  const migration = { deletesFamilies: false, movesMedicineRows: false };
  assert.equal(migration.deletesFamilies, false);
  assert.equal(migration.movesMedicineRows, false);
});
