import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers';
import { startLeafletPhotoCleanup } from '../dist/jobs/leaflet-photo-cleanup.js';

function harness(t, enabled) {
  const previous = process.env.LEAFLET_PHOTO_CLEANUP_ENABLED;
  if (enabled === undefined) delete process.env.LEAFLET_PHOTO_CLEANUP_ENABLED;
  else process.env.LEAFLET_PHOTO_CLEANUP_ENABLED = enabled;
  t.after(() => {
    if (previous === undefined) delete process.env.LEAFLET_PHOTO_CLEANUP_ENABLED;
    else process.env.LEAFLET_PHOTO_CLEANUP_ENABLED = previous;
  });
  const calls = { timers: 0, clears: 0, queries: 0, transactions: 0, removes: 0, unrefs: 0 };
  let tick;
  const timer = { unref() { calls.unrefs++; } };
  t.mock.method(globalThis, 'setInterval', (callback) => { calls.timers++; tick = callback; return timer; });
  t.mock.method(globalThis, 'clearInterval', (value) => { assert.equal(value, timer); calls.clears++; });
  const database = {
    async query() { calls.queries++; return { rows: [], rowCount: 0 }; },
    async withTransaction() { calls.transactions++; throw new Error('No candidates in synthetic startup test'); },
  };
  const store = { async remove() { calls.removes++; } };
  return { calls, database, store, tick: () => tick() };
}

for (const value of [undefined, '', 'false', 'FALSE', '0', '1', 'TRUE', 'true ']) {
  test(`private photo cleanup is inert unless explicitly enabled: ${String(value)}`, t => {
    const h = harness(t, value);
    const stop = startLeafletPhotoCleanup(h.database, h.store);
    stop();
    stop();
    assert.deepEqual(h.calls, { timers: 0, clears: 0, queries: 0, transactions: 0, removes: 0, unrefs: 0 });
  });
}

test('explicit true enables the original immediate sweep and periodic sweep, and returns a timer stop', async t => {
  const h = harness(t, 'true');
  const stop = startLeafletPhotoCleanup(h.database, h.store);
  await new Promise(setImmediate);
  assert.deepEqual(h.calls, { timers: 1, clears: 0, queries: 1, transactions: 0, removes: 0, unrefs: 1 });
  h.tick();
  await new Promise(setImmediate);
  assert.equal(h.calls.queries, 2);
  stop();
  assert.equal(h.calls.clears, 1);
});
