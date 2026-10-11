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

test("family pilot restore evidence accepts supplied generated pairing", () => {
  const result = runEvidence(base);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /PASS/);
});

test("family pilot restore evidence rejects missing photo pairing", () => {
  const result = runEvidence({ ...base, records: [{ medicineId: "m1", batchId: "b1", photoIds: [], receiptIds: [], photoHashes: [] }] });
  assert.notEqual(result.status, 0);
});

test("family pilot restore evidence rejects candidate without tree binding", () => {
  const result = runEvidence({ ...base, candidate: { sha: "abc123" } });
  assert.notEqual(result.status, 0);
});
