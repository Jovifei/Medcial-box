import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers';
import { loadService, makeSessionScopeModule } from './runtime.mjs';

const payload = () => ({ schemaVersion: 1, revision: 0, medicineVersion: 3, idempotencyKey: 'key-one',
  photos: [{ photoId: 'photo-1', sequence: 2, status: 'recognized', fields: { name: '合成药' }, warnings: ['请核对'] }],
  fieldSources: { name: { source: 'recognized', photoIds: ['photo-1'], reviewed: false } },
  batchSources: [{ batchId: 'batch-1', field: 'expiry', source: 'manual', photoIds: [], reviewed: true }],
});
function harness() {
  const storage = new Map(), calls = [];
  let generation = 1, failWrites = false, failRemovals = false;
  const scope = makeSessionScopeModule({ userId: 'u', familyId: 'a' });
  const api = {
    getRecognitionEvidence: async () => ({ evidence: null, capabilities: { coverPhotoVersionGuard: true } }),
    saveRecognitionEvidence: async (_id, body) => ({ evidence: { ...body, revision: body.revision + 1,
      currentMedicineVersion: body.medicineVersion, stale: false,
      photos: body.photos.map(photo => ({ ...photo, available: true })),
      batchSources: body.batchSources.map(source => ({ ...source, batchAvailable: true })) } }),
  };
  const wx = { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => {
    if (failWrites) throw Error('quota'); storage.set(key, structuredClone(value));
  }, removeStorageSync: key => { if (failRemovals) throw Error('storage'); storage.delete(key); } };
  const service = loadService('services/recognition-evidence-sync.ts', { wx, modules: {
    './session-scope': scope,
    './api': { api: { getRecognitionEvidence: (...args) => { calls.push('GET'); return api.getRecognitionEvidence(...args); },
      saveRecognitionEvidence: (...args) => { calls.push('POST'); return api.saveRecognitionEvidence(...args); } },
      captureSessionIdentity: () => ({ token: 't', generation }), isCurrentSession: value => value.generation === generation },
  } });
  return { ...service, api, calls, storage, scope, setGeneration: value => { generation = value; },
    failStorage: () => { failWrites = true; }, failRemoval: value => { failRemovals = value; } };
}

test('unavailable durable storage never sends a request', async () => {
  const h = harness(); h.failStorage();
  assert.equal((await h.queueRecognitionEvidence('m', payload())).status, 'storage_failed');
  assert.deepEqual(h.calls, []);
});
test('unsupported or unconfirmed capability retains the exact original payload without posting', async () => {
  const h = harness(); h.api.getRecognitionEvidence = async () => ({ evidence: null });
  const original = payload(); const result = await h.queueRecognitionEvidence('m', original);
  assert.equal(result.status, 'pending'); assert.equal(result.reason, 'capability_unconfirmed');
  assert.deepEqual(h.calls, ['GET']); original.photos[0].fields.name = 'changed';
  const pending = h.getPendingRecognitionEvidence('m');
  assert.equal(pending.payload.photos[0].fields.name, '合成药');
  pending.payload.photos[0].fields.name = 'mutated reading';
  assert.equal(h.getPendingRecognitionEvidence('m').payload.photos[0].fields.name, '合成药');
});
test('network retry reuses exact key and payload, then clears only its own record', async () => {
  const h = harness(); let sent; h.api.saveRecognitionEvidence = async (_id, body) => { sent = JSON.stringify(body); throw Error('network'); };
  const result = await h.queueRecognitionEvidence('m', payload()); assert.equal(result.status, 'pending');
  const existing = await h.queueRecognitionEvidence('m', { ...payload(), idempotencyKey: 'key-two' });
  assert.equal(existing.status, 'existing'); assert.deepEqual(h.calls, ['GET', 'POST']);
  h.api.saveRecognitionEvidence = async (_id, body) => { assert.equal(JSON.stringify(body), sent); return { evidence: { ...body,
    revision: body.revision + 1, currentMedicineVersion: body.medicineVersion, stale: false,
    photos: body.photos.map(photo => ({ ...photo, available: true })),
    batchSources: body.batchSources.map(source => ({ ...source, batchAvailable: true })) } }; };
  assert.equal((await h.retryRecognitionEvidence('m')).status, 'synced');
  assert.equal(h.getPendingRecognitionEvidence('m'), null);
});
test('409, stale or mismatched receipts retain records and never claim success', async () => {
  for (const outcome of ['conflict', 'stale', 'mismatch']) {
    const h = harness(); h.api.saveRecognitionEvidence = async (_id, body) => {
      if (outcome === 'conflict') throw { statusCode: 409 };
      return { evidence: { ...body, revision: body.revision + 1, currentMedicineVersion: body.medicineVersion + (outcome === 'stale' ? 1 : 0),
        stale: outcome === 'stale', fieldSources: outcome === 'mismatch' ? {} : body.fieldSources,
        photos: body.photos.map(photo => ({ ...photo, available: true })),
        batchSources: body.batchSources.map(source => ({ ...source, batchAvailable: true })) } };
    };
    const result = await h.queueRecognitionEvidence('m', payload());
    assert.equal(result.status, 'pending'); assert.equal(result.reason, outcome === 'mismatch' ? 'receipt_mismatch' : outcome);
    assert.ok(h.getPendingRecognitionEvidence('m'));
  }
});
test('late acknowledgement cannot erase a replacement or cross family identity', async () => {
  const h = harness(); let resolvePost;
  h.api.saveRecognitionEvidence = (_id, body) => new Promise(resolve => { resolvePost = () => resolve({ evidence: {
    ...body, revision: 1, currentMedicineVersion: 3, stale: false,
    photos: body.photos.map(photo => ({ ...photo, available: true })),
    batchSources: body.batchSources.map(source => ({ ...source, batchAvailable: true })) } }); });
  const p = h.queueRecognitionEvidence('m', payload()); await new Promise(resolve => setImmediate(resolve));
  h.scope.writeSessionScope({ userId: 'u', familyId: 'b' }); h.setGeneration(2); resolvePost();
  assert.equal((await p).status, 'identity_changed'); assert.equal(h.getPendingRecognitionEvidence('m'), null);
  h.scope.writeSessionScope({ userId: 'u', familyId: 'a' }); assert.ok(h.getPendingRecognitionEvidence('m'));
});
test('a late receipt cannot delete another page’s newer stored intent', async () => {
  const h = harness(); let resolvePost;
  h.api.saveRecognitionEvidence = (_id, body) => new Promise(resolve => { resolvePost = () => resolve({ evidence: {
    ...body, revision: 1, currentMedicineVersion: 3, stale: false,
    photos: body.photos.map(photo => ({ ...photo, available: true })),
    batchSources: body.batchSources.map(source => ({ ...source, batchAvailable: true })) } }); });
  const pending = h.queueRecognitionEvidence('m', payload()); await new Promise(resolve => setImmediate(resolve));
  const key = [...h.storage.keys()][0];
  h.storage.set(key, { medicineId: 'm', payload: { ...payload(), idempotencyKey: 'newer-record' } });
  resolvePost(); assert.equal((await pending).status, 'pending');
  assert.equal(h.getPendingRecognitionEvidence('m').payload.idempotencyKey, 'newer-record');
});
test('404 capability and a household change during capability lookup never issue POST', async () => {
  for (const outcome of ['404', 'changed']) {
    const h = harness(); let resolveGet;
    if (outcome === '404') h.api.getRecognitionEvidence = async () => { throw { statusCode: 404 }; };
    else h.api.getRecognitionEvidence = () => new Promise(resolve => { resolveGet = resolve; });
    const pending = h.queueRecognitionEvidence('m', payload());
    if (outcome === 'changed') {
      await new Promise(resolve => setImmediate(resolve)); h.scope.writeSessionScope({ userId: 'u', familyId: 'b' });
      resolveGet({ capabilities: { coverPhotoVersionGuard: true }, evidence: null });
    }
    const result = await pending;
    assert.equal(result.status, outcome === '404' ? 'pending' : 'identity_changed');
    assert.deepEqual(h.calls, ['GET']);
  }
});
test('a successful response cannot be claimed cleared if durable removal fails', async () => {
  const h = harness(); h.failRemoval(true);
  const result = await h.queueRecognitionEvidence('m', payload());
  assert.equal(result.status, 'pending'); assert.equal(result.reason, 'storage_error');
  assert.ok(h.getPendingRecognitionEvidence('m'));
  h.failRemoval(false);
  assert.equal((await h.retryRecognitionEvidence('m')).status, 'synced');
  assert.equal(h.getPendingRecognitionEvidence('m'), null);
});
test('exported receipt matcher requires matching full intent, current version and non-stale result', async () => {
  const h = harness(); const original = payload();
  const { evidence } = await h.api.saveRecognitionEvidence('m', original);
  assert.equal(h.recognitionEvidenceReceiptMatches(original, evidence), true);
  assert.equal(h.recognitionEvidenceReceiptMatches(original, { ...evidence, stale: true }), false);
  assert.equal(h.recognitionEvidenceReceiptMatches(original, { ...evidence, currentMedicineVersion: 4 }), false);
  assert.equal(h.recognitionEvidenceReceiptMatches(original, { ...evidence, batchSources: [] }), false);
  assert.equal(h.recognitionEvidenceReceiptMatches(original, null), false);
});
