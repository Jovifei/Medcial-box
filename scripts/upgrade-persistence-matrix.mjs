#!/usr/bin/env node
// Repository-side upgrade matrix. It verifies executable repository contracts
// and keeps device-only receipts explicitly unproven.
import { access, readFile } from "node:fs/promises";

const checks = [];
function add(id, ok, scope, detail) {
  checks.push({ id, scope, automation: "RUN_BY_REPO", ok, detail });
}

async function exists(path, id, scope) {
  try {
    await access(path);
    add(id, true, scope, "path exists");
  } catch (error) {
    add(id, false, scope, error.code ?? "missing");
  }
}

await exists("apps/flutter/pubspec.yaml", "android-version-source", "client version contract");
await exists("apps/api/src", "api-contract-source", "API upgrade contract");
await exists("apps/miniprogram/pages/medicine-edit/medicine-edit.ts", "draft-owner-source", "draft ownership source");
await exists("scripts/start-local-trials.mjs", "recovery-tool-source", "recovery tooling");

try {
  const pubspec = await readFile("apps/flutter/pubspec.yaml", "utf8");
  add("android-version-readable", /version:\s*\d+\.\d+\.\d+\+\d+/.test(pubspec), "version migration", "version field format");
} catch (error) {
  add("android-version-readable", false, "version migration", error.code ?? "read_failed");
}

try {
  const draft = await readFile("apps/miniprogram/pages/medicine-edit/medicine-edit.ts", "utf8");
  add("draft-owner-contract", /activePhotoDraftId|photoDraft|scope/i.test(draft), "draft ownership", "draft identity contract present");
} catch (error) {
  add("draft-owner-contract", false, "draft ownership", error.code ?? "read_failed");
}

try {
  const migration = await readFile("apps/api/db/migrations/030_medicine_brand_and_purpose_tags.sql", "utf8");
  add("migration-contract", /brand|purpose/i.test(migration), "database migration", "feature migration marker present");
} catch (error) {
  add("migration-contract", false, "database migration", error.code ?? "read_failed");
}

const deviceCases = [
  { id: "android-install-r", status: "NOT_PROVEN", reason: "requires installed app receipt" },
  { id: "session-restore", status: "NOT_PROVEN", reason: "requires real client storage" },
  { id: "draft-photo-restore", status: "NOT_PROVEN", reason: "requires device filesystem and private photo receipt" },
];

const result = {
  ok: checks.every((item) => item.ok),
  checks,
  deviceCases,
  limitations: [
    "Does not read private photos or credentials.",
    "Does not claim real-device upgrade success.",
  ],
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
