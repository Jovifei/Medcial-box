import fs from "node:fs";
import crypto from "node:crypto";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/check-family-pilot-restore-contract.mjs <restore-evidence.json>");
  process.exit(2);
}

const evidence = JSON.parse(fs.readFileSync(file, "utf8"));
const fail = (message) => {
  console.error(`paired restore evidence failed: ${message}`);
  process.exit(1);
};

if (!evidence.candidate?.sha || !evidence.candidate?.rootTree) fail("missing candidate binding");
if (evidence.candidate.sha === "pending-generated-fixture" || evidence.candidate.rootTree === "pending-generated-fixture") {
  fail("placeholder candidate binding");
}
if (!Array.isArray(evidence.records) || evidence.records.length === 0) fail("missing restored records");

for (const record of evidence.records) {
  if (!record.medicineId || !record.batchId) fail("missing medicine or batch");
  if (!Array.isArray(record.photoIds) || record.photoIds.length === 0) fail("missing photo pairing");
  if (!Array.isArray(record.receiptIds) || record.receiptIds.length === 0) fail("missing receipt pairing");
  if (!Array.isArray(record.photoHashes) || record.photoHashes.length !== record.photoIds.length) fail("photo hash count mismatch");
  for (const hash of record.photoHashes) {
    if (!/^[a-f0-9]{64}$/.test(hash)) fail("invalid photo hash");
  }
}

const digest = crypto.createHash("sha256")
  .update(JSON.stringify(evidence.records))
  .digest("hex");
if (evidence.expectedPairDigest && evidence.expectedPairDigest !== digest) fail("pair digest mismatch");

console.log(JSON.stringify({
  candidate: evidence.candidate.sha,
  rootTree: evidence.candidate.rootTree,
  records: evidence.records.length,
  pairDigest: digest,
  environment: evidence.environment ?? "synthetic",
}, null, 2));
