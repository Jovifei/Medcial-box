import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function runEvidence(value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-restore-"));
  const file = path.join(dir, "evidence.json");
  fs.writeFileSync(file, JSON.stringify(value));
  return spawnSync("node", ["scripts/check-family-pilot-restore-contract.mjs", file], { encoding: "utf8" });
}

const base = {
  candidate: { sha: "abc123", rootTree: "tree123" },
  records: [{
    medicineId: "m1",
    batchId: "b1",
    photoIds: ["p1"],
    receiptIds: ["r1"],
    photoHashes: ["a".repeat(64)],
  }],
};

test("restore evidence accepts complete supplied pairing", () => {
  assert.equal(runEvidence(base).status, 0);
});

test("restore evidence rejects missing photo pairing", () => {
  assert.notEqual(runEvidence({ ...base, records: [{ ...base.records[0], photoIds: [], photoHashes: [] }] }).status, 0);
});

test("restore evidence rejects mismatched photo/hash cardinality", () => {
  assert.notEqual(runEvidence({ ...base, records: [{ ...base.records[0], photoIds: ["p1", "p2"] }] }).status, 0);
});

test("restore evidence rejects corrupt hash", () => {
  assert.notEqual(runEvidence({ ...base, records: [{ ...base.records[0], photoHashes: ["broken"] }] }).status, 0);
});

test("restore evidence rejects missing candidate tree", () => {
  assert.notEqual(runEvidence({ ...base, candidate: { sha: "abc123" } }).status, 0);
});
