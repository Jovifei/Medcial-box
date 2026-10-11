import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/check-family-pilot-upgrade-evidence.mjs <upgrade-evidence.json>");
  process.exit(2);
}

const evidence = JSON.parse(fs.readFileSync(file, "utf8"));
const fail = (message) => {
  console.error(`upgrade evidence failed: ${message}`);
  process.exit(1);
};

if (!evidence.before || !evidence.after || !evidence.candidate?.sha) {
  fail("missing candidate or before/after evidence");
}

const fields = ["medicineIds", "batchIds", "photoIds", "draftIds", "familyIds"];
for (const field of fields) {
  const before = JSON.stringify([...new Set(evidence.before[field] ?? [])].sort());
  const after = JSON.stringify([...new Set(evidence.after[field] ?? [])].sort());
  if (before !== after) fail(`ownership field changed: ${field}`);
}

if (evidence.before.ownerScope !== evidence.after.ownerScope) {
  fail("owner scope changed");
}

console.log("upgrade retention evidence PASS");
console.log(JSON.stringify({ candidate: evidence.candidate.sha, preserved: fields }, null, 2));
