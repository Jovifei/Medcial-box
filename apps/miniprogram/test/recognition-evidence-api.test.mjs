import assert from 'node:assert/strict';
import test from 'node:test';
import { loadApi } from './runtime.mjs';

test('evidence uses medicine-scoped endpoints and cover version is opt-in', async () => {
  const { api, requests } = loadApi();
  const payload = { schemaVersion: 1, revision: 0, medicineVersion: 2, idempotencyKey: 'synthetic-key', photos: [], fieldSources: {} };
  await api.getRecognitionEvidence('a/b'); await api.saveRecognitionEvidence('a/b', payload);
  await api.setMedicineCover('a/b', 'photo', 2); await api.setMedicineCover('a/b', null);
  assert.match(requests[0].url, /medicines\/a%2Fb\/recognition-evidence$/);
  assert.equal(requests[0].method, 'GET'); assert.equal(requests[1].method, 'POST');
  assert.equal(requests[1].data, payload); assert.equal(requests[2].data.version, 2);
  assert.equal(Object.hasOwn(requests[3].data, 'version'), false);
});
