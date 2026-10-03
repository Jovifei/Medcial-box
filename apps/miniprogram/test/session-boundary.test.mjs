import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
const test = (name, run) => nodeTest(name, { timeout: 1500 }, run);
import { loadApi, loadService, loadPage, makePageContext } from './runtime.mjs';

function fixture({ removeFails = false } = {}) {
  const storage = new Map();
  const requests = [];
  const downloads = [];
  const logins = [];
  const wx = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync(key) {
      if (removeFails) throw new Error('storage unavailable');
      storage.delete(key);
    },
    request: (request) => requests.push(request),
    downloadFile: (request) => downloads.push(request),
    login: (request) => logins.push(request),
  };
  const scope = loadService('services/session-scope.ts', { wx });
  const service = loadApi({ wx, modules: { './session-scope': scope } });
  const auth = loadService('services/auth.ts', { wx, modules: { './api': service, './session-scope': scope } });
  const signIn = (token, userId = token) => {
    service.storeToken(token);
    scope.writeSessionScope({ userId, familyId: `family-${userId}` });
  };
  return { service, auth, scope, requests, downloads, logins, storage, signIn };
}
const response = (request, statusCode, data = {}) => request.success({ statusCode, data });
const unauthorized = (request) => response(request, 401, { error: { code: 'UNAUTHORIZED', message: 'Expired' } });
const stale = (promise) => assert.rejects(promise, (error) => error.code === 'STALE_SESSION' && error.statusCode !== 401);


test('late old-session 401 preserves the new token and draft owner', async () => {
  const f = fixture(); f.signIn('old');
  const rejected = stale(f.service.api.getAuthMe());
  f.signIn('new'); unauthorized(f.requests[0]); await rejected;
  assert.equal(f.service.readToken(), 'new');
  assert.equal(f.scope.readSessionScope().userId, 'new');
});

test('late successful data is rejected after identity changes, including token A to B to A', async () => {
  for (const reuse of [false, true]) {
    const f = fixture(); f.signIn('a');
    const rejected = stale(f.service.api.listMedicines());
    f.signIn('b'); if (reuse) f.signIn('a');
    response(f.requests[0], 200, { medicines: [{ id: 'old-private-record' }] });
    await rejected;
  }
});

test('current-session 401 still clears both credentials and draft scope', async () => {
  const f = fixture(); f.signIn('current');
  const rejected = assert.rejects(f.service.api.getAuthMe(), (error) => error.code === 'UNAUTHORIZED');
  unauthorized(f.requests[0]); await rejected;
  assert.equal(f.service.readToken(), '');
  assert.equal(f.scope.readSessionScope(), null);
});

test('anonymous login failure cannot invalidate an existing authenticated session', async () => {
  const f = fixture(); f.signIn('current');
  const rejected = assert.rejects(f.service.api.login('invalid-code'));
  unauthorized(f.requests[0]); await rejected;
  assert.equal(f.service.readToken(), 'current');
  assert.equal(f.scope.readSessionScope().userId, 'current');
});

test('late private-photo 401 or success never clears or returns data to the new identity', async () => {
  for (const statusCode of [200, 401]) {
    const f = fixture(); f.signIn('old');
    const rejected = stale(f.service.api.downloadLeafletPhoto('medicine', 'photo'));
    f.signIn('new'); f.downloads[0].success({ statusCode, tempFilePath: 'wxfile://old-private-photo' });
    await rejected; assert.equal(f.service.readToken(), 'new');
  }
});

test('failed persistent removal cannot resurrect the old token or scope in this process', () => {
  const f = fixture({ removeFails: true }); f.signIn('old');
  f.service.clearToken();
  assert.equal(f.service.readToken(), '');
  assert.equal(f.scope.readSessionScope(), null);
});

test('late auth/me success cannot replace the new user and family draft scope', async () => {
  const f = fixture(); f.signIn('old');
  const rejected = stale(f.auth.ensureLoggedIn());
  f.signIn('new'); response(f.requests[0], 200, { user: { id: 'old' }, family: { id: 'family-old' } });
  await rejected;
  assert.equal(f.service.readToken(), 'new');
  assert.equal(f.scope.readSessionScope().userId, 'new');
  assert.equal(f.logins.length, 0);
});

test('late auth/me 401 never clears the new session or starts interactive login', async () => {
  const f = fixture(); f.signIn('old');
  const rejected = stale(f.auth.ensureLoggedIn());
  f.signIn('new'); unauthorized(f.requests[0]); await rejected;
  assert.equal(f.service.readToken(), 'new'); assert.equal(f.logins.length, 0);
});

test('a new session accepted between 401 callback and auth catch is preserved', async () => {
  const f = fixture(); f.signIn('old');
  const rejected = stale(f.auth.ensureLoggedIn());
  unauthorized(f.requests[0]); f.signIn('new'); await rejected;
  assert.equal(f.service.readToken(), 'new');
  assert.equal(f.scope.readSessionScope().userId, 'new');
  assert.equal(f.logins.length, 0);
});

test('current expired session can still perform the existing interactive login fallback', async () => {
  const f = fixture(); f.signIn('old');
  const restored = f.auth.ensureLoggedIn(); unauthorized(f.requests[0]); await tick();
  assert.equal(f.logins.length, 1); f.logins[0].success({ code: 'fresh-code' });
  response(f.requests[1], 200, { token: 'fresh', expiresAt: 'future', user: { hasFamily: true } });
  assert.equal(await restored, 'fresh'); assert.equal(f.service.readToken(), 'fresh');
});

test('noninteractive expired session does not silently start WeChat login', async () => {
  const f = fixture(); f.signIn('old');
  const rejected = assert.rejects(f.auth.ensureLoggedIn({ allowInteractive: false }), (error) => error.statusCode === 401);
  unauthorized(f.requests[0]); await rejected;
  assert.equal(f.logins.length, 0); assert.equal(f.scope.readSessionScope(), null);
});

test('pending wx.login callback after logout cannot exchange or restore credentials', async () => {
  const f = fixture(); const rejected = stale(f.auth.loginWithWechat());
  await f.auth.logout(); f.logins[0].success({ code: 'obsolete-code' }); await rejected;
  assert.equal(f.requests.length, 0); assert.equal(f.service.readToken(), '');
});

test('pending login exchange after logout cannot restore its returned token', async () => {
  const f = fixture(); const rejected = stale(f.auth.loginWithWechat());
  f.logins[0].success({ code: 'obsolete-code' }); await f.auth.logout();
  response(f.requests[0], 200, { token: 'obsolete', expiresAt: 'future', user: { hasFamily: true } });
  await rejected; assert.equal(f.service.readToken(), '');
});

test('the latest of overlapping login attempts wins even when the old exchange returns first', async () => {
  const f = fixture(); const older = stale(f.auth.loginWithWechat());
  f.logins[0].success({ code: 'older' });
  const newer = f.auth.loginWithWechat(); f.logins[1].success({ code: 'newer' });
  response(f.requests[0], 200, { token: 'older', expiresAt: 'future', user: { hasFamily: true } }); await older;
  response(f.requests[1], 200, { token: 'newer', expiresAt: 'future', user: { hasFamily: true } });
  assert.equal((await newer).token, 'newer'); assert.equal(f.service.readToken(), 'newer');
});

test('late logout completion or failure cannot clear a newly accepted identity', async () => {
  for (const statusCode of [200, 401, 500]) {
    const f = fixture(); f.signIn('old');
    const ending = f.auth.logout().catch(() => {});
    f.signIn('new'); response(f.requests[0], statusCode); await ending;
    assert.equal(f.service.readToken(), 'new');
    assert.equal(f.scope.readSessionScope().userId, 'new');
  }
});


test('auth/me resolved just before a token switch cannot write the previous scope', async () => {
  const f = fixture(); f.signIn('old');
  const rejected = stale(f.auth.ensureLoggedIn());
  response(f.requests[0], 200, { user: { id: 'old' }, family: { id: 'family-old' } });
  f.signIn('new'); await rejected;
  assert.equal(f.scope.readSessionScope().userId, 'new');
});

test('older wx.login callback is rejected before exchange after a newer login starts', async () => {
  const f = fixture(); const older = stale(f.auth.loginWithWechat());
  const newer = f.auth.loginWithWechat();
  f.logins[0].success({ code: 'older' }); await older;
  assert.equal(f.requests.length, 0);
  f.logins[1].success({ code: 'newer' });
  response(f.requests[0], 200, { token: 'newer', expiresAt: 'future', user: { hasFamily: true } });
  assert.equal((await newer).token, 'newer');
});

test('late network failures from JSON and photo requests stay non-401 stale errors', async () => {
  const f = fixture(); f.signIn('old');
  const json = stale(f.service.api.getAuthMe());
  const photo = stale(f.service.api.downloadLeafletPhoto('medicine', 'photo'));
  f.signIn('new'); f.requests[0].fail(); f.downloads[0].fail();
  await Promise.all([json, photo]); assert.equal(f.service.readToken(), 'new');
});

test('current offline logout still clears local credentials and scope', async () => {
  const f = fixture(); f.signIn('old');
  const rejected = assert.rejects(f.auth.logout(), (error) => error.code === 'NETWORK_ERROR');
  f.requests[0].fail(); await rejected;
  assert.equal(f.service.readToken(), ''); assert.equal(f.scope.readSessionScope(), null);
});

test('both logout pages leave a newer identity and its navigation alone', async () => {
  for (const path of ['pages/account-settings/account-settings.ts', 'pages/invite/invite.ts']) {
    const f = fixture(); f.signIn('old'); const routes = [];
    const { definition } = loadPage(path, {
      modules: { '../../services/api': f.service, '../../services/auth': f.auth },
      wx: { reLaunch: (options) => routes.push(options.url) },
    });
    const page = makePageContext(definition); const ending = page.onLogout();
    await tick(); assert.equal(f.requests.length, 1);
    f.signIn('new'); response(f.requests[0], 200, { revoked: true }); await ending;
    assert.equal(f.service.readToken(), 'new'); assert.deepEqual(routes, []);
  }
});


test('a parallel current-session 401 does not strand an otherwise current logout', async () => {
  const f = fixture(); f.signIn('old');
  const ending = f.auth.logout();
  const expired = assert.rejects(f.service.api.getAuthMe(), (error) => error.code === 'UNAUTHORIZED');
  unauthorized(f.requests[1]); await expired;
  response(f.requests[0], 200, { revoked: true }); await ending;
  assert.equal(f.service.readToken(), ''); assert.equal(f.scope.readSessionScope(), null);
});

test('logout cannot displace a newer pending login even before it receives a token', async () => {
  const f = fixture(); f.signIn('old');
  const ending = stale(f.auth.logout());
  const login = f.auth.loginWithWechat();
  f.service.clearToken(); response(f.requests[0], 200); await ending;
  // The explicit clear also invalidates the pending login; settle it for the test.
  const rejected = stale(login); f.logins[0].success({ code: 'cancelled-code' }); await rejected;
});


test('successful create/join/leave invalidates old family reads without revoking the token', async () => {
  for (const change of [(api) => api.createFamily('new family'), (api) => api.acceptInvitation('code'), (api) => api.leaveFamily()]) {
    const f = fixture(); f.signIn('same-token', 'same-user');
    const previous = stale(f.auth.ensureLoggedIn());
    const changing = change(f.service.api); response(f.requests[1], 200); await changing;
    assert.equal(f.service.readToken(), 'same-token'); assert.equal(f.scope.readSessionScope(), null);
    const fresh = f.auth.ensureLoggedIn();
    response(f.requests[2], 200, { user: { id: 'same-user' }, family: null }); await fresh;
    response(f.requests[0], 200, { user: { id: 'same-user' }, family: { id: 'old-family' } }); await previous;
    assert.equal(f.scope.readSessionScope().familyId, '');
  }
});

test('rejected family changes preserve the existing scope and valid pending reads', async () => {
  const f = fixture(); f.signIn('same-token', 'same-user');
  const reading = f.auth.ensureLoggedIn();
  const rejected = assert.rejects(f.service.api.leaveFamily()); response(f.requests[1], 409); await rejected;
  response(f.requests[0], 200, { user: { id: 'same-user' }, family: { id: 'family-same-user' } }); await reading;
  assert.equal(f.scope.readSessionScope().familyId, 'family-same-user');
});
