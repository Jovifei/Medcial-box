import assert from "node:assert/strict";
import test from "node:test";
import { loadApi, loadPage, makePageContext } from "./runtime.mjs";

function fixture(contentScope, medicines = []) {
  return { schemaVersion: 2, contentScope, backupId: "synthetic", exportedAt: "2026-10-27T00:00:00Z", medicines };
}

test("default backup requests the complete evidence scope, inventory-only requires an explicit option", async () => {
  let result = fixture("inventory_and_recognition_evidence");
  const service = loadApi();
  service.wx.request = options => { service.requests.push(options); options.success({ statusCode: 200, data: result }); };
  await service.api.createJsonBackup();
  result = fixture("inventory_only");
  await service.api.createJsonBackup({ includeRecognitionEvidence: false });
  assert.deepEqual(JSON.parse(JSON.stringify(service.requests.map(request => request.data))),
    [{}, { includeRecognitionEvidence: false }]);
});

test("old, mislabelled, or scope-inconsistent responses are not shared as the selected backup", async () => {
  let result = { schemaVersion: 2, medicines: [] };
  const service = loadApi();
  service.wx.request = options => options.success({ statusCode: 200, data: result });
  await assert.rejects(service.api.createJsonBackup(), error => error.code === "BACKUP_SCOPE_UNCONFIRMED");
  await assert.rejects(service.api.createJsonBackup({ includeRecognitionEvidence: false }), error => error.code === "BACKUP_SCOPE_UNCONFIRMED");
  result = fixture("inventory_and_recognition_evidence");
  await assert.rejects(service.api.createJsonBackup({ includeRecognitionEvidence: false }), error => error.code === "BACKUP_SCOPE_UNCONFIRMED");
  result = fixture("inventory_only", [{ recognitionEvidence: { schemaVersion: 1 } }]);
  await assert.rejects(service.api.createJsonBackup({ includeRecognitionEvidence: false }), error => error.code === "BACKUP_SCOPE_UNCONFIRMED");
  result = { ...fixture("inventory_only"), schemaVersion: 1 };
  await assert.rejects(service.api.createJsonBackup({ includeRecognitionEvidence: false }), error => error.code === "BACKUP_SCOPE_UNCONFIRMED");
});

test("inventory-only UI uses the explicit option and identifies the resulting file", async () => {
  const calls = [];
  const identity = { token: "synthetic", generation: 1 };
  const { definition } = loadPage("pages/backup-restore/backup-restore.ts", {
    modules: {
      "../../services/api": { ApiError: class extends Error {}, captureSessionIdentity: () => identity,
        isCurrentSession: item => item === identity,
        api: { createJsonBackup: async options => { calls.push(options); return fixture("inventory_only"); } } },
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/temporary-share-files": { temporaryShareScope: () => "synthetic-scope", recoverTemporaryShareFiles: async () => {},
        registerTemporaryShareFile: () => true, cleanupTemporaryShareFile: async () => true },
    },
  });
  const page = makePageContext(definition);
  await page.onCreateInventoryBackup();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ includeRecognitionEvidence: false }]);
  assert.match(page.data.statusText, /仅库存备份已生成/);
  assert.equal(JSON.parse(page.data.backupJson).contentScope, "inventory_only");
});

test("an old API response is shown as an error before any backup file is shared", async () => {
  const service = loadApi();
  service.wx.request = options => options.success({ statusCode: 200, data: { schemaVersion: 2, backupId: "old", medicines: [] } });
  let shareCalls = 0;
  const { definition } = loadPage("pages/backup-restore/backup-restore.ts", {
    modules: {
      "../../services/api": service,
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/temporary-share-files": { temporaryShareScope: () => "synthetic-scope", recoverTemporaryShareFiles: async () => {},
        registerTemporaryShareFile: () => true, cleanupTemporaryShareFile: async () => true },
    },
    wx: { shareFileMessage: () => { shareCalls++; } },
  });
  const page = makePageContext(definition);
  await page.onCreateInventoryBackup();
  assert.equal(shareCalls, 0);
  assert.equal(page.data.backupJson, "");
  assert.match(page.data.errorMessage, /无法确认所选备份范围/);
});
