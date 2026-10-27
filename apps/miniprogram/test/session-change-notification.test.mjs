import assert from 'node:assert/strict';
import test from 'node:test';
import { loadApi, loadService } from './runtime.mjs';

function fixture(initialScope = null, request) {
  const storage = new Map();
  if (initialScope) storage.set('home_medicine_session_scope', initialScope);
  const wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: key => storage.delete(key),
    ...(request ? { request } : {}),
  };
  const scope = loadService('services/session-scope.ts', { wx });
  const api = loadApi({ wx, modules: { './session-scope': scope } });
  return { scope, api, storage };
}

test('scope listeners see actual changes, not a repeat write of the same identity', () => {
  const f = fixture({ userId: 'synthetic-u', familyId: 'a' });
  const observed = [];
  const unsubscribe = f.scope.subscribeSessionChanges(() => observed.push(f.scope.readSessionScope()?.familyId ?? null));
  f.scope.writeSessionScope({ userId: 'synthetic-u', familyId: 'a' });
  assert.deepEqual(observed, []);
  f.scope.writeSessionScope({ userId: 'synthetic-u', familyId: 'b' });
  f.scope.clearSessionScope();
  f.scope.clearSessionScope();
  assert.deepEqual(observed, ['b', null]);
  unsubscribe(); unsubscribe();
  f.scope.writeSessionScope({ userId: 'synthetic-u', familyId: 'c' });
  assert.deepEqual(observed, ['b', null]);
});

test('session generation changes notify even with unchanged scope and listener failures are isolated', () => {
  const f = fixture();
  f.api.storeToken('synthetic-token');
  f.scope.writeSessionScope({ userId: 'synthetic-u', familyId: 'a' });
  const original = f.api.captureSessionIdentity();
  const seen = [];
  f.scope.subscribeSessionChanges(() => { throw Error('synthetic listener failure'); });
  f.scope.subscribeSessionChanges(() => seen.push({ stale: !f.api.isCurrentSession(original), family: f.scope.readSessionScope()?.familyId ?? null }));
  f.api.beginSessionTransition();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].stale, true);
  assert.equal(seen[0].family, 'a');
  f.api.storeToken('synthetic-replacement');
  assert.equal(seen.length, 3);
  assert.equal(seen[1].family, 'a');
  assert.equal(seen[2].family, null);
});

test('scope is not silently changed by mutating a caller-owned object', () => {
  const f = fixture();
  const scope = { userId: 'synthetic-u', familyId: 'a' };
  f.scope.writeSessionScope(scope);
  scope.familyId = 'b';
  assert.equal(f.scope.readSessionScope().familyId, 'a');
  const returned = f.scope.readSessionScope();
  returned.familyId = 'c';
  assert.equal(f.scope.readSessionScope().familyId, 'a');
});

test('a real transport 401 immediately notifies after clearing the current scope', async () => {
  let pendingRequest;
  const f = fixture(null, request => { pendingRequest = request; });
  f.api.storeToken('synthetic-token');
  f.scope.writeSessionScope({ userId: 'synthetic-u', familyId: 'a' });
  const identity = f.api.captureSessionIdentity();
  const events = [];
  f.scope.subscribeSessionChanges((...args) => events.push({ args: args.length, scope: f.scope.readSessionScope(), current: f.api.isCurrentSession(identity) }));
  const pending = f.api.api.listMedicines();
  pendingRequest.success({ statusCode: 401, data: { error: { code: 'UNAUTHORIZED', message: 'synthetic expiration' } } });
  await assert.rejects(pending, error => error.statusCode === 401);
  assert.equal(events.length, 2);
  assert.ok(events.every(event => event.args === 0), 'notifications do not expose credentials or account data');
  assert.equal(events[0].scope.familyId, 'a');
  assert.equal(events[1].scope, null);
  assert.ok(events.every(event => event.current === false));
});
