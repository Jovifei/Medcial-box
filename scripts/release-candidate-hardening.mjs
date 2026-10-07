#!/usr/bin/env node
// Delivery-stage audit helper. This does not replace real devices/platforms.
// It validates repository-side invariants before handing a candidate to local QA.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}

const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
check("node-engine", pkg.engines?.node?.includes(">=22") === true, pkg.engines?.node ?? "missing");
check("local-trial-script", typeof pkg.scripts?.["dev:local-trials"] === "string", pkg.scripts?.["dev:local-trials"] ?? "missing");
check("mini-release-gate", typeof pkg.scripts?.["check:miniprogram:package"] === "string", pkg.scripts?.["check:miniprogram:package"] ?? "missing");

const project = await readJson("apps/miniprogram/project.config.json");
check("mini-url-check", project.setting?.urlCheck === true, String(project.setting?.urlCheck));
check("mini-no-trial-base", project.libVersion !== "trial", project.libVersion ?? "missing");

const android = await readFile(resolve(root, "apps/flutter/pubspec.yaml"), "utf8");
const version = /version:\s*([^\n]+)/.exec(android)?.[1]?.trim();
check("android-version-present", Boolean(version), version ?? "missing");

const result = {
  ok: checks.every((item) => item.ok),
  generatedAt: new Date().toISOString(),
  checks,
  limitations: [
    "Does not access WeChat backend configuration.",
    "Does not prove two-device acceptance, notification delivery, signing, HTTPS or production restore.",
  ],
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
