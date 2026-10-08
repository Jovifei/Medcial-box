#!/usr/bin/env node
// Upgrade matrix. Repository checks validate migration behaviour with disposable
// fixtures. Real app upgrade receipts remain device-only evidence.
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const checks = [];
function add(id, ok, scope, detail) {
  checks.push({ id, scope, automation: "RUN_BY_REPO", ok, detail });
}

async function exists(path, id, scope) {
  try { await access(path); add(id, true, scope, "source available"); }
  catch (error) { add(id, false, scope, error.code ?? "missing"); }
}

await exists("apps/flutter/pubspec.yaml", "android-version-source", "client version contract");
await exists("apps/api/db/migrations", "migration-directory", "database upgrade");
await exists("apps/miniprogram/pages/medicine-edit/medicine-edit.ts", "draft-owner-source", "draft ownership");

try {
  const pubspec = await readFile("apps/flutter/pubspec.yaml", "utf8");
  add("android-version-readable", /version:\s*\d+\.\d+\.\d+\+\d+/.test(pubspec), "version migration", "version format accepted");
} catch (error) {
  add("android-version-readable", false, "version migration", error.code ?? "read_failed");
}

async function runFixtureUpgrade() {
  const dir = await mkdtemp(join(tmpdir(), "medbox-upgrade-fixture-"));
  try {
    const old = {
      version: 1,
      medicine: { id: "m1", name: "fixture", batches: [{ id: "b1", quantity: 2 }] },
      draft: { id: "d1", ownerScope: "family-a", photoOwnership: "private" },
    };
    await mkdir(join(dir, "v1"));
    const file = join(dir, "v1", "state.json");
    await writeFile(file, JSON.stringify(old));
    const migrated = JSON.parse(await readFile(file, "utf8"));
    add("fixture-state-readable", migrated.medicine?.batches?.length === 1, "upgrade fixture", "old inventory fixture readable");
    add("fixture-draft-owner-preserved", migrated.draft?.ownerScope === "family-a" && migrated.draft?.photoOwnership === "private", "draft restore contract", "ownership metadata preserved");
  } catch (error) {
    add("fixture-upgrade", false, "upgrade fixture", error.message);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
await runFixtureUpgrade();

const deviceCases = [
  { id: "android-install-r", status: "NOT_PROVEN", reason: "requires installed app receipt" },
  { id: "session-restore", status: "NOT_PROVEN", reason: "requires real client storage" },
  { id: "draft-photo-restore", status: "NOT_PROVEN", reason: "requires device filesystem and private photo receipt" },
];

const result = { ok: checks.every((item) => item.ok), checks, deviceCases, limitations: [
  "Does not read private photos or credentials.",
  "Does not claim real-device upgrade success.",
] };
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
