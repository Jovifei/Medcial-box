#!/usr/bin/env node
// Source inventory only: these checks do not execute migration or recovery.
// Real app upgrade receipts remain device-only evidence.
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));

const checks = [];
function add(id, ok, scope, detail) {
  checks.push({ id, scope: "SOURCE_ONLY", subject: scope, automation: "RUN_BY_REPO", ok, detail });
}

async function exists(path, id, scope) {
  try { await access(resolve(root, path)); add(id, true, scope, "source available"); }
  catch (error) { add(id, false, scope, error.code ?? "missing"); }
}

await exists("apps/flutter/pubspec.yaml", "android-version-source", "client version contract");
await exists("apps/api/db/migrations", "migration-directory", "database upgrade");
await exists("apps/miniprogram/pages/medicine-edit/medicine-edit.ts", "draft-owner-source", "draft ownership");

try {
  const pubspec = await readFile(resolve(root, "apps/flutter/pubspec.yaml"), "utf8");
  add("android-version-readable", /version:\s*\d+\.\d+\.\d+\+\d+/.test(pubspec), "version migration", "version format accepted");
} catch (error) {
  add("android-version-readable", false, "version migration", error.code ?? "read_failed");
}

const deviceCases = [
  { id: "android-install-r", status: "NOT_PROVEN", reason: "requires installed app receipt" },
  { id: "session-restore", status: "NOT_PROVEN", reason: "requires real client storage" },
  { id: "draft-photo-restore", status: "NOT_PROVEN", reason: "requires device filesystem and private photo receipt" },
];

const result = { ok: checks.every((item) => item.ok), checks, deviceCases, limitations: [
  "Source presence checks do not execute migration or storage recovery.",
  "Does not read private photos or credentials.",
  "Does not claim real-device upgrade success.",
] };
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
