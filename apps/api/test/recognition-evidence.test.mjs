import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { validateRecognitionEvidenceDocument, validateRecognitionEvidenceSave,
  recognitionEvidenceHash } from "../dist/services/recognition-evidence.js";
import { validateFamilyMedicineBackup } from "../dist/services/backup-snapshot.js";

const onePhoto = (sequence) => ({ photoId: randomUUID(), sequence, status: "recognized", fields: { name: "测试" } });
const document = () => ({ schemaVersion: 1, photos: [onePhoto(1)], fieldSources: {} });

test("evidence admits 100 photos but rejects document and per-photo UTF-8 byte overflow", () => {
  const hundred = { schemaVersion: 1, photos: Array.from({ length: 100 }, (_, i) => onePhoto(i + 1)), fieldSources: {} };
  assert.equal(validateRecognitionEvidenceDocument(hundred)?.photos.length, 100);
  assert.equal(validateRecognitionEvidenceDocument({ ...hundred, photos: [...hundred.photos, onePhoto(101)] }), null);
  const tooMuchOne = document();
  tooMuchOne.photos[0].fields.name = "药".repeat(11_000);
  assert.equal(validateRecognitionEvidenceDocument(tooMuchOne), null);
  const tooMuchTotal = { schemaVersion: 1, photos: Array.from({ length: 9 }, (_, i) => ({
    ...onePhoto(i + 1), fields: { name: "x".repeat(29_200) },
  })), fieldSources: {} };
  assert.equal(validateRecognitionEvidenceDocument(tooMuchTotal), null);
});

test("selected photo sources must have a matching recognized field and each number stays unique", () => {
  const data = document();
  const first = data.photos[0];
  data.fieldSources = { name: { source: "recognized", photoIds: [first.photoId], reviewed: false },
    manufacturer: { source: "catalog", photoIds: [], reviewed: false } };
  assert.ok(validateRecognitionEvidenceDocument(data));
  assert.equal(validateRecognitionEvidenceDocument({ ...data, photos: [{ ...first, status: "failed" }] }), null);
  assert.equal(validateRecognitionEvidenceDocument({ ...data, photos: [{ ...first, fields: {} }] }), null);
  assert.equal(validateRecognitionEvidenceDocument({ ...data, photos: [first, onePhoto(1)] }), null);
  assert.equal(validateRecognitionEvidenceDocument({ ...data, fieldSources: {
    name: { source: "manual", photoIds: [first.photoId], reviewed: true },
  } }), null);
});

test("a photo removed before upload remains an explicit unavailable source", () => {
  const data = document();
  data.fieldSources = { lotNumber: { source: "removed", photoIds: [], reviewed: true } };
  assert.deepEqual(validateRecognitionEvidenceDocument(data)?.fieldSources, data.fieldSources);
  data.fieldSources.lotNumber.photoIds = [data.photos[0].photoId];
  assert.equal(validateRecognitionEvidenceDocument(data), null);
});

test("idempotency hashes equivalent field maps identically and binds the medicine version", () => {
  const base = document();
  const photo = base.photos[0];
  const request = { ...base, revision: 0, medicineVersion: 1, idempotencyKey: "1234567890abcdef" };
  const first = validateRecognitionEvidenceSave({ ...request, photos: [{ ...photo, fields: { name: "测试", brand: "品牌" } }] });
  const reordered = validateRecognitionEvidenceSave({ ...request, photos: [{ ...photo, fields: { brand: "品牌", name: "测试" } }] });
  const changed = validateRecognitionEvidenceSave({ ...request, medicineVersion: 2, photos: [{ ...photo, fields: { name: "测试", brand: "品牌" } }] });
  assert.ok(first && reordered && changed);
  assert.equal(recognitionEvidenceHash(first), recognitionEvidenceHash(reordered));
  assert.notEqual(recognitionEvidenceHash(first), recognitionEvidenceHash(changed));
});

test("old backups remain valid while unsafe fields inside or beside evidence are rejected", () => {
  const backup = { schemaVersion: 2, backupId: randomUUID(), exportedAt: new Date().toISOString(),
    familyName: "合成家庭", inventorySettings: { stocktakeInterval: "monthly", lastStocktakeAt: null, nextStocktakeAt: null },
    medicines: [{ name: "合成药", batches: [] }] };
  assert.equal(validateFamilyMedicineBackup(backup).ok, true);
  const evidence = document();
  const withEvidence = { ...backup, medicines: [{ ...backup.medicines[0], recognitionEvidence: evidence }] };
  const parsed = validateFamilyMedicineBackup(withEvidence);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value.medicines[0].recognitionEvidence, evidence);
  assert.equal(validateFamilyMedicineBackup({ ...backup, medicines: [{ ...backup.medicines[0], photoBytes: "secret" }] }).ok, false);
  assert.equal(validateFamilyMedicineBackup({ ...backup, medicines: [{ ...backup.medicines[0],
    recognitionEvidence: { ...evidence, sessionToken: "secret" } }] }).ok, false);
  assert.equal(validateFamilyMedicineBackup({ ...backup, medicines: [{ ...backup.medicines[0],
    recognitionEvidence: { ...evidence, photos: [{ ...evidence.photos[0], imageBase64: "secret" }] } }] }).ok, false);
});
