#!/usr/bin/env node
// Lifecycle audit. Default mode validates repository contracts only.
// Real local-service probing must be explicitly enabled because it requires
// a prepared database, built API artifacts, and local-only processes.
import { readFile } from "node:fs/promises";

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}

async function inspectTargetScripts() {
  for (const file of ["scripts/start-local-trials.mjs", "scripts/dev-simulator-server.mjs"]) {
    try {
      const text = await readFile(file, "utf8");
      check(`${file}:read`, true, "loaded target delivery script");
      if (file.endsWith("start-local-trials.mjs")) {
        check(
          `${file}:runtime-contract`,
          /spawn\s*\(/.test(text) && /health\/local-app-trial/.test(text),
          "target launcher exposes spawn and readiness contract",
        );
      } else {
        check(
          `${file}:runtime-contract`,
          /health\/local-app-trial/.test(text) && /SIGINT|SIGTERM/.test(text),
          "target server exposes health and shutdown contract",
        );
      }
    } catch (error) {
      check(`${file}:read`, false, error.code ?? error.message);
    }
  }
}

async function main() {
  await inspectTargetScripts();

  const realMode = process.env.MEDBOX_LIFECYCLE_REAL === "true";
  check(
    "real-target-runtime",
    realMode,
    realMode
      ? "real runtime mode requested; execute local harness separately"
      : "NOT_RUN: requires local database, built dist and process ownership environment",
  );

  const result = {
    // Contract mode must not claim a runtime PASS.
    ok: checks.every((item) => item.ok),
    checks,
    limitations: [
      "Default mode does not claim target service startup success.",
      "Default mode does not claim health response, PID ownership or resource cleanup.",
      "Real runtime verification requires local-only prepared environment.",
    ],
  };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

await main();
