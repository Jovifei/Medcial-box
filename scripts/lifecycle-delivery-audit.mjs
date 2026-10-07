#!/usr/bin/env node
// Repository-side lifecycle audit. It validates executable lifecycle contracts,
// not production uptime.
import { readFile } from "node:fs/promises";

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}

async function inspect(file, rules) {
  try {
    const text = await readFile(file, "utf8");
    for (const rule of rules) {
      check(`${file}:${rule.name}`, rule.test(text), rule.description);
    }
  } catch (error) {
    check(`${file}:read`, false, error.code ?? "read_failed");
  }
}

await inspect("scripts/start-local-trials.mjs", [
  {
    name: "spawn-service",
    test: (text) => /spawn\(/.test(text),
    description: "must contain executable child-process startup",
  },
  {
    name: "health-probe",
    test: (text) => /health\/local-app-trial/.test(text),
    description: "must contain readiness probe",
  },
  {
    name: "failure-surface",
    test: (text) => /throw new Error/.test(text),
    description: "must expose startup failure instead of false success",
  },
]);

await inspect("scripts/dev-simulator-server.mjs", [
  {
    name: "health-route",
    test: (text) => /health\/local-app-trial/.test(text),
    description: "must expose local trial health route",
  },
  {
    name: "shutdown-handler",
    test: (text) => /SIGINT|SIGTERM/.test(text),
    description: "must handle process shutdown",
  },
  {
    name: "resource-close",
    test: (text) => /close\(/.test(text),
    description: "must close owned resources",
  },
]);

const result = {
  ok: checks.every((item) => item.ok),
  checks,
  limitations: [
    "Does not claim uptime after machine reboot.",
    "Does not claim production HTTPS availability.",
  ],
};

console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
