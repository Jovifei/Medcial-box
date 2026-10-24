import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { loadApi, loadPage, loadService, makePageContext, makeSessionScopeModule } from './runtime.mjs';

// Run the production transport and auth/me scope transition together. Only the
// HTTP response and native file picker are synthetic; no real account is used.
function fixture({ role = 'owner' } = {}) {
  const scope = makeSessionScopeModule({ userId: 'synthetic-user', familyId: 'A' });
  const storage = new Map([['home_medicine_session_token', 'synthetic-token']]);
  const writes = [];
  const toasts = [];
  let serverFamily = 'A';
  let holdFamily = null;
  let holdMutation = null;
  let authReads = 0;
  const transport = loadApi({ modules: { './session-scope': scope }, wx: {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    request(options) {
      const path = new URL(options.url).pathname;
      if (path === '/api/v1/auth/me') {
        authReads += 1;
        options.success({ statusCode: 200, data: {
          user: { id: 'synthetic-user', hasFamily: true }, family: { id: serverFamily },
        } });
      } else if (path === '/api/v1/families/current') {
        const reply = () => options.success({ statusCode: 200, data: {
          family: { id: serverFamily, name: `${serverFamily}-private`, role, members: [{ id: `${serverFamily}-member` }] },
        } });
        if (holdFamily) holdFamily(reply); else reply();
      } else if (path === '/api/v1/families/settings') {
        if (options.method !== 'GET') writes.push({ family: options.header['x-family-id'], settings: options.data });
        options.success({ statusCode: 200, data: { settings: options.method === 'GET'
          ? { stocktakeInterval: 'monthly' } : options.data } });
      } else {
        writes.push({ path, family: options.header['x-family-id'] });
        if (holdMutation) { holdMutation(options); return; }
        throw new Error(`Unexpected synthetic request: ${path}`);
      }
    },
  } });
  const auth = loadService('services/auth.ts', { modules: { './api': transport, './session-scope': scope } });
  const pageFor = (path, nativeWx = {}) => makePageContext(loadPage(path, { modules: {
    '../../services/api': transport,
    '../../services/auth': auth,
    '../../services/session-scope': scope,
    '../../services/temporary-share-files': {
      temporaryShareScope: () => scope.scopedStorageKey('temporary-share'),
      recoverTemporaryShareFiles: async () => {}, cleanupTemporaryShareFile: async () => true,
      registerTemporaryShareFile: () => true,
    },
  }, wx: {
    showToast: options => toasts.push(options.title),
    chooseMessageFile: options => options.success({ tempFiles: [{ path: '/synthetic.json', name: 'synthetic.json' }] }),
    getFileSystemManager: () => ({ readFile: options => options.success({ data: '{}' }) }),
    ...nativeWx,
  } }).definition);
  return { transport, scope, writes, toasts, pageFor, authReads: () => authReads,
    setServerFamily: value => { serverFamily = value; },
    holdFamily: callback => { holdFamily = callback; },
    holdMutation: callback => { holdMutation = callback; },
  };
}

for (const action of ['create', 'preview', 'restore']) {
  test(`backup ${action}: own auth/me family change clears private state and busy without onShow`, async () => {
    const f = fixture();
    const page = f.pageFor('pages/backup-restore/backup-restore.ts');
    page.setData({ backupJson: 'A-private-export', statusText: 'A-private-status' });
    if (action === 'restore') {
      page.backupOperationIdentity = f.transport.captureSessionIdentity();
      page.backupOperationScope = f.scope.scopedStorageKey('temporary-share');
      page.pendingImportPayload = { schemaVersion: 1, backupId: 'synthetic' };
      page.pendingConfirmationToken = 'synthetic-confirmation';
      page.setData({ importPreview: { valid: true }, restoreAllowed: true });
    }
    f.setServerFamily('B');
    if (action === 'create') await page.onCreateBackup();
    if (action === 'preview') await page.onChooseImport();
    if (action === 'restore') await page.onConfirmRestore();
    assert.equal(f.scope.readSessionScope().familyId, 'B');
    assert.equal(page.data.busy, false);
    assert.equal(page.data.backupJson, '');
    assert.equal(page.data.importPreview, null);
    assert.equal(page.pendingImportPayload, null);
    assert.equal(page.pendingConfirmationToken, null);
    assert.match(page.data.errorMessage, /家庭.*变化/);
    assert.equal(f.writes.length, 0, 'old-household operation must stop before backup or restore dispatch');
  });
}

test('family settings cannot submit A input after auth/me switches to B', async () => {
  const f = fixture();
  const page = f.pageFor('pages/family-settings/family-settings.ts');
  await page.refresh();
  assert.equal(page.data.familyName, 'A-private');
  f.setServerFamily('B');
  await page.onIntervalChange({ detail: { value: 0 } });
  assert.equal(f.scope.readSessionScope().familyId, 'B');
  assert.equal(f.writes.length, 0, 'A form must not dispatch an update with B x-family-id');
  assert.equal(page.data.settings, null);
  assert.equal(page.data.familyName, '');
  assert.equal(page.data.members.length, 0);
  assert.equal(page.data.saving, false);
});

test('family settings clears A while a fresh B read is pending, and only enables B after it resolves', async () => {
  const f = fixture();
  const page = f.pageFor('pages/family-settings/family-settings.ts');
  await page.refresh();
  f.setServerFamily('B');
  f.transport.beginSessionTransition();
  f.scope.writeSessionScope({ userId: 'synthetic-user', familyId: 'B' });
  let completeFamily;
  f.holdFamily(reply => { completeFamily = reply; });
  const refresh = page.refresh();
  await tick();
  assert.equal(page.data.settings, null);
  assert.equal(page.data.familyName, '');
  await page.onIntervalChange({ detail: { value: 0 } });
  assert.equal(f.writes.length, 0);
  completeFamily();
  await refresh;
  assert.equal(page.data.familyName, 'B-private');
  await page.onIntervalChange({ detail: { value: 0 } });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].family, 'B');
  assert.equal(f.writes[0].settings.stocktakeInterval, 'weekly');
  assert.equal(page.data.saving, false);
});

test('same-family settings still saves the requested interval once', async () => {
  const f = fixture();
  const page = f.pageFor('pages/family-settings/family-settings.ts');
  await page.refresh();
  await page.onIntervalChange({ detail: { value: 0 } });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].family, 'A');
  assert.equal(page.data.settings.stocktakeInterval, 'weekly');
  assert.equal(page.data.saving, false);
});

for (const action of ['interval', 'remove', 'transfer', 'leave']) {
  test(`displayed A family settings cannot ${action} after external switch to B without onShow`, async () => {
    const f = fixture({ role: action === 'leave' ? 'member' : 'owner' });
    const page = f.pageFor('pages/family-settings/family-settings.ts');
    await page.refresh();
    assert.equal(page.data.familyName, 'A-private');
    f.setServerFamily('B');
    f.transport.beginSessionTransition();
    f.scope.writeSessionScope({ userId: 'synthetic-user', familyId: 'B' });
    if (action === 'interval') await page.onIntervalChange({ detail: { value: 0 } });
    else if (action === 'leave') await page.onLeaveFamily();
    else await page.onManageMember({ currentTarget: { dataset: { id: 'A-member', action } } });
    assert.equal(f.writes.length, 0, 'displayed A action cannot operate under B identity');
    assert.equal(page.data.familyName, '');
    assert.equal(page.data.settings, null);
    assert.equal(page.data.members.length, 0);
  });
}

test('an old management error cannot toast or refresh a newly displayed B family', async () => {
  const f = fixture();
  const page = f.pageFor('pages/family-settings/family-settings.ts');
  await page.refresh();
  let completeMutation;
  f.holdMutation(options => { completeMutation = () => options.success({ statusCode: 403,
    data: { error: { code: 'FORBIDDEN', message: 'synthetic old family error' } } }); });
  const pending = page.onManageMember({ currentTarget: { dataset: { id: 'A-member', action: 'remove' } } });
  await tick();
  f.setServerFamily('B');
  f.transport.beginSessionTransition();
  f.scope.writeSessionScope({ userId: 'synthetic-user', familyId: 'B' });
  await page.refresh();
  const reads = f.authReads();
  completeMutation();
  await pending;
  assert.equal(page.data.familyName, 'B-private');
  assert.equal(f.toasts.length, 0);
  assert.equal(f.authReads(), reads);
});

test('successful leave clears the family view before navigation completes', async () => {
  const f = fixture({ role: 'member' });
  let visibleAtNavigation;
  let page;
  page = f.pageFor('pages/family-settings/family-settings.ts', { reLaunch: options => {
    visibleAtNavigation = { path: options.url, familyName: page.data.familyName, settings: page.data.settings };
  } });
  await page.refresh();
  f.holdMutation(options => options.success({ statusCode: 200, data: null }));
  await page.onLeaveFamily();
  assert.deepEqual(visibleAtNavigation, { path: '/pages/family-entry/family-entry', familyName: '', settings: null });
});

for (const action of ['create-failure', 'preview-cancel']) {
  test(`backup ${action} clears an old A export after external B switch without onShow`, async () => {
    const f = fixture();
    const page = f.pageFor('pages/backup-restore/backup-restore.ts', {
      chooseMessageFile: options => options.fail({ errMsg: 'synthetic cancel' }),
    });
    f.holdMutation(options => options.success({ statusCode: 200,
      data: { backupId: 'A-private', exportedAt: '2026-10-24T00:00:00Z', medicines: [] } }));
    await page.onCreateBackup();
    assert.match(page.data.backupJson, /A-private/);
    f.setServerFamily('B');
    f.transport.beginSessionTransition();
    f.scope.writeSessionScope({ userId: 'synthetic-user', familyId: 'B' });
    f.holdMutation(options => options.success({ statusCode: 500,
      data: { error: { code: 'UNAVAILABLE', message: 'synthetic failure' } } }));
    if (action === 'create-failure') await page.onCreateBackup();
    else await page.onChooseImport();
    assert.equal(page.data.backupJson, '');
    assert.equal(page.data.busy, false);
  });
}

test('old backup busy cannot block B operation or let its late failure overwrite B receipt', async () => {
  const f = fixture();
  const page = f.pageFor('pages/backup-restore/backup-restore.ts');
  let oldRequest;
  f.holdMutation(options => { oldRequest = options; });
  const oldOperation = page.onCreateBackup();
  await tick();
  f.setServerFamily('B');
  f.transport.beginSessionTransition();
  f.scope.writeSessionScope({ userId: 'synthetic-user', familyId: 'B' });
  f.holdMutation(options => options.success({ statusCode: 200,
    data: { backupId: 'B-current', exportedAt: '2026-10-24T00:00:00Z', medicines: [] } }));
  await page.onCreateBackup();
  oldRequest.success({ statusCode: 500, data: { error: { code: 'UNAVAILABLE', message: 'synthetic A failure' } } });
  await oldOperation;
  assert.equal(page.data.busy, false);
  assert.match(page.data.backupJson, /B-current/);
  assert.equal(page.data.errorMessage, '');
});

test('an old management response clears its invalidated A view without onShow', async () => {
  const f = fixture();
  const page = f.pageFor('pages/family-settings/family-settings.ts');
  await page.refresh();
  let completeMutation;
  f.holdMutation(options => { completeMutation = () => options.success({ statusCode: 403,
    data: { error: { code: 'FORBIDDEN', message: 'synthetic old family error' } } }); });
  const pending = page.onManageMember({ currentTarget: { dataset: { id: 'A-member', action: 'remove' } } });
  await tick();
  f.setServerFamily('B');
  f.transport.beginSessionTransition();
  f.scope.writeSessionScope({ userId: 'synthetic-user', familyId: 'B' });
  completeMutation();
  await pending;
  assert.equal(page.data.familyName, '');
  assert.equal(page.data.members.length, 0);
  assert.equal(f.toasts.length, 0);
});

test('old family management modal cannot leave A displayed after a B switch', async () => {
  const f = fixture();
  let confirm;
  const page = f.pageFor('pages/family-settings/family-settings.ts', {
    showModal: options => { confirm = () => options.success({ confirm: true }); },
  });
  await page.refresh();
  const pending = page.onManageMember({ currentTarget: { dataset: { id: 'A-member', action: 'remove' } } });
  await tick();
  f.setServerFamily('B');
  f.transport.beginSessionTransition();
  f.scope.writeSessionScope({ userId: 'synthetic-user', familyId: 'B' });
  confirm();
  await pending;
  assert.equal(f.writes.length, 0);
  assert.equal(page.data.familyName, '');
  assert.equal(page.data.members.length, 0);
});

test('a late A backup response clears its old export and busy after external B switch without onShow', async () => {
  const f = fixture();
  const page = f.pageFor('pages/backup-restore/backup-restore.ts');
  f.holdMutation(options => options.success({ statusCode: 200,
    data: { backupId: 'A-private-export', exportedAt: '2026-10-24T00:00:00Z', medicines: [] } }));
  await page.onCreateBackup();
  assert.match(page.data.backupJson, /A-private-export/);
  let oldRequest;
  f.holdMutation(options => { oldRequest = options; });
  const pending = page.onCreateBackup();
  await tick();
  f.setServerFamily('B');
  f.transport.beginSessionTransition();
  f.scope.writeSessionScope({ userId: 'synthetic-user', familyId: 'B' });
  oldRequest.success({ statusCode: 200,
    data: { backupId: 'A-late-export', exportedAt: '2026-10-24T00:00:00Z', medicines: [] } });
  await pending;
  assert.equal(page.data.backupJson, '');
  assert.equal(page.data.busy, false);
  assert.equal(page.data.errorMessage, '');
});
