#!/usr/bin/env node
// Repository-side lifecycle audit. It validates executable hooks, not production uptime.
import { readFile } from "node:fs/promises";

const files = [
  "scripts/start-local-trials.mjs",
  "scripts/dev-simulator-server.mjs",
];

const checks = [];
for (const file of files) {
  try {
    const text = await readFile(file, "utf8");
    checks.push({ file, ok: true, health: /health\/local-app-trial/.test(text), shutdown: /SIGINT|SIGTERM|close/.test(text) });
  } catch (error) {
    checks.push({ file, ok: false, error: error.code ?? "read_failed" });
  }
}

const result = {
  ok: checks.every((item) => item.ok && item.health && item.shutdown),
  checks,
  limits: [
    "Does not claim a service stayed alive after a machine reboot.",
    "Does not claim production uptime or external HTTPS availability.",
  ],
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
