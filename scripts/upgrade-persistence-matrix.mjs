#!/usr/bin/env node
// Repository-side upgrade matrix. It verifies contracts available in git and
// leaves device-only receipts explicitly unproven.
import { access, readFile } from "node:fs/promises";

const checks = [];
async function exists(path, id, scope) {
  try {
    await access(path);
    checks.push({ id, scope, automation: "RUN_BY_REPO", ok: true });
  } catch {
    checks.push({ id, scope, automation: "RUN_BY_REPO", ok: false });
  }
}

await exists("apps/flutter/pubspec.yaml", "android-version-source", "client version contract exists");
await exists("apps/api/src", "api-contract-source", "api source exists for migration validation");
await exists("apps/miniprogram/pages/medicine-edit/medicine-edit.ts", "draft-owner-source", "draft ownership implementation exists");
await exists("scripts/start-local-trials.mjs", "local-recovery-tool", "local recovery tooling exists");

let migrations = "";
try {
  migrations = await readFile("apps/api/db/migrations/030_medicine_brand_and_purpose_tags.sql", "utf8");
} catch {}
checks.push({
  id: "latest-migration-source",
  scope: "migration source contains expected feature marker",
  automation: "RUN_BY_REPO",
  ok: migrations.includes("brand") || migrations.includes("purpose"),
});

const deviceCases = [
  { id: "android-install-r", scope: "existing install preserved", status: "NOT_PROVEN", reason: "requires installed app receipt" },
  { id: "session-restore", scope: "identity/session survives upgrade", status: "NOT_PROVEN", reason: "requires real client storage" },
  { id: "draft-photo-restore", scope: "draft and private photo ownership", status: "NOT_PROVEN", reason: "requires device filesystem" },
];

console.log(JSON.stringify({
  ok: checks.every((item) => item.ok),
  checks,
  deviceCases,
  limits: [
    "Does not read private photos or credentials.",
    "Does not claim real-device upgrade success.",
  ],
}, null, 2));
process.exitCode = checks.every((item) => item.ok) ? 0 : 1;
