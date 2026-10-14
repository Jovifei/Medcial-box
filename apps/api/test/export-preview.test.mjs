import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setImmediate } from 'node:timers';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../../miniprogram/pages/export-preview/export-preview.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function harness({ unavailable = false, auth, cleanupFailures = 0 } = {}) {
  const requests = [], copies = [], writes = [], shares = [], toasts = [], removed = [];
  let page;
  class ApiError extends Error {}
  const wx = {
    env: { USER_DATA_PATH: '/sandbox' },
    showToast: value => toasts.push(value), showModal() {}, navigateBack() {},
    setClipboardData: value => copies.push(value),
    getFileSystemManager: () => ({ writeFile: value => writes.push(value), unlink: value => {
      removed.push(value);
      if (cleanupFailures-- > 0) value.fail({ errMsg: 'file in use' });
      else value.success();
    } }),
    ...(unavailable ? {} : { shareFileMessage: value => shares.push(value) }),
  };
  vm.runInNewContext(compiled, {
    exports: {}, wx, Page: value => { page = value; },
    require: name => name.endsWith('/auth') ? { ensureLoggedIn: () => auth?.promise ?? Promise.resolve() } :
      name.endsWith('/session-scope') ? { scopedStorageKey: kind => kind + ':synthetic-user:synthetic-family' } : {
      ApiError,
      captureSessionIdentity: () => ({ token: 'synthetic-session', generation: 1 }),
      isCurrentSession: identity => identity.token === 'synthetic-session' && identity.generation === 1,
      api: { exportMarkdown: options => { const request = deferred(); requests.push({ ...request, options }); return request.promise; } },
    },
  });
  page.setData = value => Object.assign(page.data, value);
  const respond = (index, markdown = 'public') => requests[index].resolve({ markdown, generatedAt: 'now' });
  return { page, requests, copies, writes, shares, toasts, removed, respond };
}

for (const action of ['onCopy', 'onShareFile']) {
  for (const order of ['old-first', 'new-first']) {
    test(`${action}: toggle invalidates private action (${order})`, async () => {
      const h = harness(); h.page.data.includePersonalDosage = true;
      const actionDone = h.page[action](); await tick();
      h.page.onTogglePersonalDosage({ detail: { value: false } }); await tick();
      const old = async () => { h.respond(0, 'private'); await tick(); };
      const fresh = async () => { h.respond(1); await tick(); };
      if (order === 'old-first') { await old(); await fresh(); } else { await fresh(); await old(); }
      assert.equal(h.copies.length + h.writes.length + h.shares.length, 0);
      await actionDone;
      assert.equal(h.page.data.markdown, 'public');
      assert.equal(h.copies.length + h.writes.length + h.shares.length, 0);
      assert.equal(h.page.data.lastAction, '');
    });
  }
}

test('toggle clears old preview immediately, even when replacement fails', async () => {
  const h = harness(); h.page.data.markdown = 'private'; h.page.data.generatedAt = 'old';
  h.page.onToggleStorageLocation({ detail: { value: false } });
  assert.equal(h.page.data.markdown, ''); assert.equal(h.page.data.generatedAt, '');
  await tick(); h.requests[0].reject(new Error('network')); await tick();
  assert.equal(h.page.data.markdown, ''); assert.equal(h.page.data.loading, false);
});

test('toggle while writing prevents stale share and copy fallback', async () => {
  const h = harness(); const done = h.page.onShareFile(); await tick(); h.respond(0, 'private'); await tick();
  assert.equal(h.writes.length, 1);
  h.page.onToggleArchived({ detail: { value: true } }); await tick();
  h.writes[0].success(); await done;
  assert.equal(h.shares.length + h.copies.length, 0);
  h.respond(1); await tick();
});

test('overlapping action clicks are ignored until first action settles', async () => {
  const h = harness(); const done = h.page.onCopy();
  const second = h.page.onShareFile(); const third = h.page.onCopy(); await tick();
  assert.equal(h.requests.length, 1);
  h.respond(0); await tick(); h.copies[0].success(); await Promise.all([done, second, third]);
  assert.equal(h.page.data.actionBusy, false);
});

test('generation failure never falls back or claims success', async () => {
  const h = harness(); const done = h.page.onShareFile(); await tick();
  h.requests[0].reject(new Error('network')); await tick();
  assert.equal(h.requests.length, 1); await done;
  assert.equal(h.copies.length, 0); assert.equal(h.page.data.lastAction, '');
  assert.equal(h.toasts.at(-1).icon, 'none');
});

for (const clipboardFails of [false, true]) {
  test(`unavailable share falls back to copy; clipboard failure=${clipboardFails}`, async () => {
    const h = harness({ unavailable: true }); const done = h.page.onShareFile(); await tick();
    h.respond(0); await tick();
    // Implementations may discover availability before or after the file write.
    h.writes[0]?.success(); await tick();
    assert.equal(h.copies.length, 1);
    h.copies[0][clipboardFails ? 'fail' : 'success']({ errMsg: 'clipboard denied' }); await done;
    assert.equal(h.page.data.lastAction.includes('已复制'), !clipboardFails);
    assert.equal(h.toasts.at(-1).icon, clipboardFails ? 'none' : 'success');
  });
}

test('cancelled share copies the same current snapshot', async () => {
  const h = harness(); const done = h.page.onShareFile(); await tick(); h.respond(0); await tick();
  h.writes[0].success(); await tick(); h.shares[0].fail({ errMsg: 'shareFileMessage:fail cancel' }); await tick();
  assert.equal(h.requests.length, 1); assert.equal(h.copies[0].data, 'public');
  h.copies[0].success(); await done; assert.match(h.page.data.lastAction, /已复制/);
});

test('action snapshot survives auth delay; obsolete request is never submitted', async () => {
  const auth = deferred(); const h = harness({ auth }); const done = h.page.onCopy();
  h.page.onToggleArchived({ detail: { value: true } }); auth.resolve(); await tick();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].options.includeArchived, true);
  h.respond(0); await done; await tick(); assert.equal(h.copies.length, 0);
});

test('successful shares use separate temporary filenames', async () => {
  const h = harness();
  for (let n = 0; n < 2; n++) {
    const done = h.page.onShareFile(); await tick(); h.respond(n); await tick();
    h.writes[n].success(); await tick(); h.shares[n].success(); await done;
  }
  assert.notEqual(h.writes[0].filePath, h.writes[1].filePath);
});


test('older preview cannot overwrite newer action result', async () => {
  const h = harness(); const preview = h.page.refresh(); await tick();
  const action = h.page.onCopy(); await tick(); h.respond(1, 'current'); await tick();
  h.respond(0, 'old'); await preview;
  assert.equal(h.page.data.markdown, 'current'); assert.equal(h.copies[0].data, 'current');
  h.copies[0].success(); await action;
});

test('stale network failures are silent and do not end newer loading state', async () => {
  const h = harness(); const action = h.page.onCopy(); await tick();
  h.page.onTogglePersonalDosage({ detail: { value: true } }); await tick();
  h.requests[0].reject(new Error('obsolete failure')); await action;
  assert.equal(h.toasts.length, 0); assert.equal(h.page.data.loading, true);
  h.respond(1); await tick(); assert.equal(h.page.data.loading, false);
});

test('file write failure reports failure without clipboard fallback', async () => {
  const h = harness(); const done = h.page.onShareFile(); await tick(); h.respond(0); await tick();
  h.writes[0].fail({ errMsg: 'disk full' }); await done;
  assert.equal(h.copies.length + h.shares.length, 0);
  assert.equal(h.removed[0].filePath, h.writes[0].filePath);
  assert.equal(h.page.data.lastAction, ''); assert.equal(h.toasts.at(-1).icon, 'none');
});

test('toggle after share dispatch is locked until native action settles', async () => {
  const h = harness(); const done = h.page.onShareFile(); await tick(); h.respond(0); await tick();
  h.writes[0].success(); await tick();
  assert.equal(h.page.data.nativeActionPending, true);
  h.page.onToggleStorageLocation({ detail: { value: false } }); await tick();
  assert.equal(h.page.data.includeStorageLocation, true);
  assert.equal(h.requests.length, 1);
  h.page.onShow();
  assert.equal(h.requests.length, 1);
  h.shares[0].fail({ errMsg: 'cancel' }); await tick();
  h.copies[0].success(); await done;
  assert.equal(h.copies.length, 1);
  assert.equal(h.page.data.nativeActionPending, false);
});

test('clipboard dispatch locks options until callback', async () => {
  const h = harness(); const done = h.page.onCopy(); await tick(); h.respond(0); await tick();
  assert.equal(h.page.data.nativeActionPending, true);
  h.page.onToggleArchived({ detail: { value: true } }); await tick();
  assert.equal(h.page.data.includeArchived, false);
  assert.equal(h.requests.length, 1);
  h.copies[0].success(); await done;
  assert.equal(h.page.data.lastAction, '已复制当前文本');
  assert.equal(h.page.data.nativeActionPending, false);
});

test('unload invalidates generation and releases action lock', async () => {
  const h = harness(); const done = h.page.onShareFile(); await tick();
  h.page.onUnload(); h.respond(0); await done;
  assert.equal(h.writes.length + h.shares.length + h.copies.length, 0);
  assert.equal(h.page.data.actionBusy, false);
});

test('temporary file cleanup is awaited before action settles', async () => {
  const h = harness(); const done = h.page.onShareFile(); await tick(); h.respond(0); await tick();
  h.writes[0].success(); await tick(); h.shares[0].success(); await done;
  assert.equal(h.removed.length, 1);
  assert.equal(h.removed[0].filePath, h.writes[0].filePath);
});

test('failed temporary file cleanup warns and retries on next show', async () => {
  const h = harness({ cleanupFailures: 1 });
  const done = h.page.onShareFile(); await tick(); h.respond(0); await tick();
  h.writes[0].success(); await tick(); h.shares[0].success(); await done;
  assert.match(h.page.data.lastAction, /清理失败/);
  assert.equal(h.toasts.at(-1).icon, 'none');
  const showing = h.page.onShow(); await tick(); h.respond(1); await showing;
  assert.equal(h.removed.length, 2);
  assert.equal(h.removed[0].filePath, h.removed[1].filePath);
});
