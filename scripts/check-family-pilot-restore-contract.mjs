import fs from "node:fs";
import crypto from "node:crypto";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/check-family-pilot-restore-contract.mjs <restore-evidence.json>");
  process.exit(2);
}

const evidence = JSON.parse(fs.readFileSync(file, "utf8"));

function fail(message) {
  console.error(`paired restore contract failed: ${message}`);
  process.exit(1);
}

if (!evidence.candidate || !evidence.candidate.sha || !evidence.candidate.rootTree) {
  fail("missing candidate SHA/root tree binding");
}
if (!Array.isArray(evidence.records) || evidence.records.length === 0) {
  fail("missing restored records");
}

for (const record of evidence.records) {
  if (!record.medicineId || !record.batchId || !record.photoIds?.length || !record.receiptIds?.length) {
    fail("missing medicine-batch-photo-receipt pairing");
  }
  if (!record.photoHashes || !record.photoHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash))) {
    fail("invalid photo hash evidence");
  }
}

const digest = crypto.createHash("sha256")
  .update(JSON.stringify(evidence.records))
  .digest("hex");

if (evidence.expectedPairDigest && evidence.expectedPairDigest !== digest) {
  fail("paired evidence digest mismatch");
}

console.log("paired restore evidence PASS");
console.log(JSON.stringify({
  candidate: evidence.candidate.sha,
  rootTree: evidence.candidate.rootTree,
  records: evidence.records.length,
  pairDigest: digest,
  environment: evidence.environment ?? "synthetic",
}, null, 2));
