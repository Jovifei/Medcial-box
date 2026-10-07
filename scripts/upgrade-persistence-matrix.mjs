#!/usr/bin/env node
// Repository-side upgrade matrix. It records what can be checked automatically
// and what still requires a real device/app/platform receipt.
const matrix = {
  generatedAt: new Date().toISOString(),
  cases: [
    { id: "android-install-r", scope: "existing install preserved", automation: "NOT_PROVEN", reason: "requires installed app receipt" },
    { id: "session-restore", scope: "identity/session survives upgrade", automation: "NOT_PROVEN", reason: "requires real client storage" },
    { id: "draft-photo-restore", scope: "draft and private photo ownership", automation: "NOT_PROVEN", reason: "requires device filesystem and private storage" },
    { id: "database-migration", scope: "postgres migration compatibility", automation: "RUN_BY_CI", reason: "covered by integration/backup workflows" },
  ],
  limits: [
    "This matrix does not claim successful upgrade of a real device.",
    "This matrix does not read local private photos or credentials.",
  ],
};
console.log(JSON.stringify(matrix, null, 2));
