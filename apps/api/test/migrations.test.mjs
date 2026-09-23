import assert from "node:assert/strict";
import test from "node:test";
import { orderMigrations } from "../dist/db/migrations.js";

test("migrations order by numeric prefix, not dictionary order", () => {
  const ordered = orderMigrations(["10_add_index.sql", "2_add_family.sql", "001_bootstrap.sql"]);
  assert.deepEqual(ordered, ["001_bootstrap.sql", "2_add_family.sql", "10_add_index.sql"]);
});

test("migrations with equal prefixes fall back to lexicographic order", () => {
  const ordered = orderMigrations(["002_b_later.sql", "002_a_early.sql", "003_next.sql"]);
  assert.deepEqual(ordered, ["002_a_early.sql", "002_b_later.sql", "003_next.sql"]);
});

test("migrations without a numeric prefix sort last", () => {
  const ordered = orderMigrations(["zz_tail.sql", "003_numbered.sql", "aa_tail.sql"]);
  assert.deepEqual(ordered, ["003_numbered.sql", "aa_tail.sql", "zz_tail.sql"]);
});
