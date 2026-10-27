import assert from 'node:assert/strict';
import test from 'node:test';
import { loadService } from './runtime.mjs';

const { mergeRecognitionEvidence } = loadService('services/recognition-evidence-merge.ts');
const ids = { old: '11111111-1111-4111-8111-111111111111', first: '22222222-2222-4222-8222-222222222222',
  second: '33333333-3333-4333-8333-333333333333', batch: '44444444-4444-4444-8444-444444444444',
  historicalBatch: '55555555-5555-4555-8555-555555555555' };
function fixture() {
  return { existing: { schemaVersion: 1, revision: 2, medicineVersion: 4, currentMedicineVersion: 5, stale: true,
    photos: [{ photoId: ids.old, sequence: 3, status: 'recognized', fields: { brand: '旧品牌' }, available: false, warnings: ['旧警告'] }],
    fieldSources: { brand: { source: 'recognized', photoIds: [ids.old], reviewed: true }, name: { source: 'manual', photoIds: [], reviewed: true } },
    batchSources: [{ batchId: ids.batch, field: 'lotNumber', source: 'manual', photoIds: [], reviewed: true, batchAvailable: true },
      { batchId: null, historicalBatchRef: ids.historicalBatch, field: 'expiry', source: 'removed', photoIds: [], reviewed: true, batchAvailable: false }] },
  uploadedPhotos: [
    { clientPhotoId: 'local-b', photoId: ids.second, sequence: 9, review: { status: 'recognized', fields: { expiryValue: '2030-01', expiryPrecision: 'month' }, warnings: [] } },
    { clientPhotoId: 'local-a', photoId: ids.first, sequence: 2, review: { status: 'recognized', fields: { name: '合成药', lotNumber: 'SYN' }, warnings: ['新警告'] } },
  ], photoIdMap: { 'local-a': ids.first, 'local-b': ids.second },
  fieldSources: { name: { source: 'recognized', photoIds: ['local-a'], reviewed: false } },
  batchSources: [{ batchId: ids.batch, field: 'expiry', source: 'recognized', photoIds: ['local-b'], reviewed: false }],
  revision: 2, medicineVersion: 5, idempotencyKey: 'synthetic-key-00001' };
}

test('merge preserves history, appends stable image numbers and maps every selected source', () => {
  const input = fixture(), before = JSON.stringify(input), result = mergeRecognitionEvidence(input);
  assert.equal(result.ok, true); const { payload } = result;
  assert.equal(JSON.stringify(input), before); assert.equal(Object.isFrozen(payload), true);
  assert.deepEqual(Array.from(payload.photos, p => [p.photoId, p.sequence]), [[ids.old, 3], [ids.first, 5], [ids.second, 12]]);
  assert.equal(payload.photos[0].warnings[0], '旧警告'); assert.equal(payload.photos[1].warnings[0], '新警告');
  assert.equal(Object.hasOwn(payload.photos[0], 'available'), false);
  assert.equal(payload.fieldSources.brand.photoIds[0], ids.old); assert.equal(payload.fieldSources.brand.reviewed, true);
  assert.equal(payload.fieldSources.name.photoIds[0], ids.first); assert.equal(payload.fieldSources.name.reviewed, false);
  assert.equal(payload.batchSources.length, 3); assert.equal(payload.batchSources[2].photoIds[0], ids.second);
  assert.equal(payload.batchSources.some(item => Object.hasOwn(item, 'batchAvailable')), false);
});
test('removing the middle local photo never renumbers later photos', () => {
  const input = fixture(); input.existing = null; input.revision = 0;
  input.uploadedPhotos[0].sequence = 3; input.uploadedPhotos[1].sequence = 1;
  const result = mergeRecognitionEvidence(input);
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.payload.photos, photo => photo.sequence), [1, 3]);
});
test('batch sources replace only the same batch and field and retain historical entries', () => {
  const input = fixture(); input.batchSources = [{ batchId: ids.batch, field: 'lotNumber', source: 'recognized', photoIds: ['local-a'], reviewed: true }];
  const result = mergeRecognitionEvidence(input); assert.equal(result.ok, true);
  assert.equal(result.payload.batchSources.length, 2);
  assert.equal(result.payload.batchSources[0].photoIds[0], ids.first);
  assert.equal(result.payload.batchSources[1].historicalBatchRef, ids.historicalBatch);
});
test('legacy unbound sources remain unchanged while new photos are appended', () => {
  const input = fixture();
  input.existing.photos[0].fields.lotNumber = '旧批号';
  input.existing.fieldSources.lotNumber = { source: 'recognized', photoIds: [ids.old], reviewed: true };
  const result = mergeRecognitionEvidence(input);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.payload.fieldSources.lotNumber)), input.existing.fieldSources.lotNumber);
  assert.equal(result.payload.photos.length, 3);
  input.fieldSources.lotNumber = { source: 'manual', photoIds: [], reviewed: true };
  assert.equal(mergeRecognitionEvidence(input).reason, 'INVALID_FIELD', 'legacy claims cannot be added or changed');
});
test('missing mappings and invalid fields fail explicitly without losing old evidence', () => {
  const missing = fixture(); delete missing.photoIdMap['local-a'];
  assert.equal(mergeRecognitionEvidence(missing).reason, 'MISSING_PHOTO_MAPPING');
  for (const field of ['leafletText', 'rawOcrText', 'lotNumber', 'expiryValue', 'expiryPrecision', 'unknownField']) {
    const input = fixture(); input.fieldSources = { [field]: { source: 'manual', photoIds: [], reviewed: true } };
    const result = mergeRecognitionEvidence(input); assert.equal(result.ok, false); assert.equal(result.reason, 'INVALID_FIELD');
  }
  const invalid = fixture(); invalid.uploadedPhotos[0].review.fields.unknownField = 'bad';
  assert.equal(mergeRecognitionEvidence(invalid).reason, 'INVALID_FIELD');
});
test('cross-device OCR original is retained as per-photo text, never a selected medicine source', () => {
  const input = fixture(); input.uploadedPhotos[1].review.fields.rawOcrText = '药盒原始文字\n请对照包装核对';
  const result = mergeRecognitionEvidence(input);
  assert.equal(result.ok, true);
  assert.equal(result.payload.photos[1].fields.rawOcrText, '药盒原始文字\n请对照包装核对');
  input.uploadedPhotos[1].review.fields.rawOcrText = '';
  assert.equal(mergeRecognitionEvidence(input).reason, 'INVALID_FIELD');
});
test('revision mismatch, duplicate photos and unrecognized claims fail instead of being silently rewritten', () => {
  const rev = fixture(); rev.revision = 1; assert.equal(mergeRecognitionEvidence(rev).reason, 'REVISION_MISMATCH');
  const duplicate = fixture(); duplicate.uploadedPhotos[0].photoId = ids.old; duplicate.photoIdMap['local-b'] = ids.old;
  assert.equal(mergeRecognitionEvidence(duplicate).reason, 'PHOTO_CONFLICT');
  const unrecognized = fixture(); unrecognized.uploadedPhotos[1].review.status = 'failed';
  assert.equal(mergeRecognitionEvidence(unrecognized).reason, 'INVALID_SOURCE');
});
test('unknown source properties and conflicting selections fail instead of discarding data or claiming agreement', () => {
  const unknown = fixture(); unknown.existing.fieldSources.brand.futureData = 'keep me';
  assert.equal(mergeRecognitionEvidence(unknown).reason, 'INVALID_SOURCE');
  const conflict = fixture(); conflict.uploadedPhotos[0].review.fields.name = '不同的药';
  conflict.fieldSources.name.photoIds.push('local-b');
  assert.equal(mergeRecognitionEvidence(conflict).reason, 'INVALID_SOURCE');
});
