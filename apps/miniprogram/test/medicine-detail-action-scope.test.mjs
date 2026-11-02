import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { loadApi, loadPage, loadService, makePageContext } from './runtime.mjs';

// The page, session scope, auth/me handling and HTTP transport are production
// modules. Only wx storage, UI callbacks and HTTP responses are synthetic.
function medicine(id) {
  const batch = (suffix, quantity) => ({
    id: id + '-' + suffix, lotNumber: null,
    expiry: { value: '2027-11-01', precision: 'day' }, quantity, unit: 'box',
    confirmedUnitsPerPackage: null, storageLocation: id + '-private-location',
    openedState: 'unopened', openedAt: null, afterOpeningLimit: null,
    expiryState: { state: 'ok', label: '有效期正常' }, version: 1,
  });
  return {
    id, name: id + '-private-name', specification: null, brand: null,
    manufacturer: null, approvalNumber: null, activeIngredients: [],
    populationTags: [], purposeTags: [], coverPhotoId: null,
    leaflet: { purposeSummary: null, packageUsageSummary: null,
      contraindicationsSummary: null, precautionsSummary: null,
      source: null, reviewStatus: 'unverified' },
    batches: [batch('single', 1), batch('split', 4)],
    lowStockThreshold: { quantity: 2, unit: 'box' },
    stockStatus: { state: 'ok', quantity: 5, unit: 'box' }, version: 1,
  };
}

async function fixture() {
  const storage = new Map([['home_medicine_session_token', 'synthetic-token']]);
  const storageWx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
  };
  const scope = loadService('services/session-scope.ts', { wx: storageWx });
  scope.writeSessionScope({ userId: 'synthetic-user', familyId: 'A' });
  const writes = [], reads = [], toasts = [], navigations = [], timers = [], modals = [], pendingMedicineReads = [];
  let serverFamily = 'A', authStatus = 200, loginCalls = 0;
  let holdWrites = false, holdModals = false, holdMedicineReads = false;
  const replyWrite = (request, statusCode = 200) => request.success({ statusCode,
    data: statusCode >= 400
      ? { error: { code: 'FORBIDDEN', message: 'synthetic old write error' } }
      : new URL(request.url).pathname.endsWith('/open-split')
        ? { openedBatch: { quantity: request.data.openedQuantity, unit: 'box' },
          remainingBatch: { quantity: 3 } }
        : {},
  });
  const transport = loadApi({ modules: { './session-scope': scope }, wx: {
    ...storageWx,
    request(options) {
      const path = new URL(options.url).pathname;
      if (path === '/api/v1/auth/me') {
        reads.push(path);
        options.success({ statusCode: authStatus, data: authStatus === 200
          ? { user: { id: 'synthetic-user', hasFamily: true }, family: { id: serverFamily } }
          : { error: { code: 'SESSION_EXPIRED', message: 'synthetic expired session' } } });
        return;
      }
      if (options.method === 'GET') {
        reads.push(path);
        const parts = path.split('/');
        const id = parts[4];
        let data;
        if (parts.length === 5 && parts[3] === 'medicines') data = medicine(id);
        else if (path.endsWith('/dosage-notes')) data = { notes: [
          { id: id + '-note', content: id + '-private-note', isMine: true },
        ] };
        else if (path.endsWith('/leaflet-photos')) data = { photos: [] };
        else throw new Error('Unexpected synthetic read: ' + path);
        const reply = () => options.success({ statusCode: 200, data });
        if (parts.length === 5 && parts[3] === 'medicines' && holdMedicineReads) pendingMedicineReads.push(reply);
        else reply();
        return;
      }
      writes.push({ path, method: options.method, family: options.header['x-family-id'],
        authorization: options.header.authorization, data: options.data, request: options });
      if (!holdWrites) replyWrite(options);
    },
  } });
  const auth = loadService('services/auth.ts', { modules: {
    './api': transport, './session-scope': scope,
  }, wx: { login() { loginCalls += 1; throw new Error('Unexpected interactive login'); } } });
  const { definition } = loadPage('pages/medicine-detail/medicine-detail.ts', { modules: {
    '../../services/api': transport, '../../services/auth': auth,
  }, wx: {
    showToast: options => toasts.push(options.title),
    showModal(options) { modals.push(options); if (!holdModals) options.success({ confirm: true }); },
    navigateBack: () => navigations.push('back'),
    reLaunch: options => navigations.push(options.url),
  }, setTimeoutFn: callback => { timers.push(callback); return timers.length; } });
  const page = makePageContext(definition);
  page.onLoad({ id: 'medicine-A' });
  await page.refresh();
  assert.equal(page.data.name, 'medicine-A-private-name', 'fixture must actually load the A view');
  const switchFamily = family => {
    serverFamily = family;
    transport.beginSessionTransition();
    scope.writeSessionScope({ userId: 'synthetic-user', familyId: family });
  };
  return { page, transport, scope, writes, reads, toasts, navigations, timers, modals,
    defaults: definition.data,
    setServerFamily: value => { serverFamily = value; },
    expireAuth: () => { authStatus = 401; },
    loginCalls: () => loginCalls,
    holdWrites: () => { holdWrites = true; },
    holdModals: () => { holdModals = true; },
    holdMedicineReads: () => { holdMedicineReads = true; },
    releaseMedicineReads() {
      holdMedicineReads = false;
      for (const reply of pendingMedicineReads.splice(0)) reply();
    },
    replyWrite: (index, statusCode) => replyWrite(writes[index].request, statusCode),
    switchFamily,
    async show(family, id) {
      switchFamily(family);
      page.setData({ medicineId: id });
      await page.refresh();
      assert.equal(page.data.name, id + '-private-name');
    },
  };
}

const actions = ['threshold', 'restock', 'opened', 'split', 'quantity', 'delete', 'archive', 'note', 'delete-note'];
const event = id => ({ currentTarget: { dataset: { id } } });
function prepare(page, action) {
  const id = page.data.medicineId;
  if (action === 'threshold') page.setData({ thresholdEnabled: true, thresholdQuantity: '3' });
  if (action === 'quantity') {
    page.onAdjustQuantity(event(id + '-single'));
    page.setData({ quantityPanelInput: '2' });
  }
  if (action === 'split') page.setData({ openingSplitBatchId: id + '-split',
    openingSplitQuantity: '1', openingSplitDate: '2026-11-01', openingSplitMode: 'none' });
  if (action === 'note') page.setData({ noteInput: id + '-new-private-note', noteVisibilityIndex: 0 });
}
function invoke(page, action) {
  const id = page.data.medicineId;
  if (action === 'threshold') return page.onSaveThreshold();
  if (action === 'restock') return page.onAddToRestock();
  if (action === 'opened') return page.onMarkOpened(event(id + '-single'));
  if (action === 'split') return page.onConfirmOpenSplit();
  if (action === 'quantity') return page.onSaveQuantityPanel();
  if (action === 'delete') return page.onDeleteMedicine();
  if (action === 'archive') return page.onArchiveMedicine();
  if (action === 'note') return page.onSubmitNote();
  return page.onDeleteNote(event(id + '-note'));
}

for (const action of actions) {
  test('detail ' + action + ': auth/me A to B cannot dispatch the old A write', async () => {
    const f = await fixture();
    prepare(f.page, action);
    f.setServerFamily('B');
    await invoke(f.page, action);
    assert.equal(f.scope.readSessionScope().familyId, 'B');
    assert.equal(f.writes.length, 0, 'old medicine ID must never be sent with B x-family-id');
    assert.equal(f.page.data.medicineSummary, null);
    assert.equal(f.page.data.name, '');
    assert.deepEqual(f.navigations, ['/pages/family-entry/family-entry'], 'owned scope loss must leave a recoverable page');
  });

  test('detail ' + action + ': displayed A cannot run after external B switch without onShow', async () => {
    const f = await fixture();
    prepare(f.page, action);
    const reads = f.reads.length;
    f.switchFamily('B');
    await invoke(f.page, action);
    assert.equal(f.writes.length, 0);
    assert.equal(f.reads.length, reads, 'stale displayed identity must stop before auth or business reads');
    assert.equal(f.page.data.medicineSummary, null);
    assert.deepEqual(f.navigations, [], 'an external identity transition must not trigger old-page navigation');
  });

  test('detail ' + action + ': current A action still dispatches once under A', async () => {
    const f = await fixture();
    prepare(f.page, action);
    await invoke(f.page, action);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].family, 'A');
    assert.equal(f.writes[0].authorization, 'Bearer synthetic-token');
    assert.equal(action === 'restock' ? f.writes[0].data.medicineId : f.writes[0].path.includes('medicine-A'),
      action === 'restock' ? 'medicine-A' : true);
    for (const key of ['savingThreshold', 'restockBusy', 'quantityPanelBusy', 'openingSplitBusy']) {
      assert.equal(f.page.data[key], false, key + ' must settle for the current operation');
    }
    assert.equal(f.page.data.busyBatchId, '');
  });
}

for (const action of ['opened', 'delete', 'archive', 'delete-note']) {
  test('detail ' + action + ': confirmation from a hidden page cannot write', async () => {
    const f = await fixture();
    prepare(f.page, action);
    f.holdModals();
    const pending = invoke(f.page, action);
    assert.equal(f.modals.length, 1);
    f.page.onHide();
    f.modals[0].success({ confirm: true });
    await pending;
    assert.equal(f.writes.length, 0);
    assert.equal(f.navigations.length, 0);
  });
}

for (const [action, busy] of [['threshold', 'savingThreshold'], ['restock', 'restockBusy'],
  ['opened', 'busyBatchId'], ['split', 'openingSplitBusy'], ['quantity', 'quantityPanelBusy'],
  ['note', 'noteSubmitting']]) {
  test('detail ' + action + ': old catch/finally cannot alter the new B action', async () => {
    const f = await fixture();
    f.holdWrites();
    prepare(f.page, action);
    const old = invoke(f.page, action);
    await tick();
    assert.equal(f.writes.length, 1);
    await f.show('B', 'medicine-B');
    prepare(f.page, action);
    const fresh = invoke(f.page, action);
    await tick();
    assert.equal(f.writes.length, 2, 'fresh B view must have released the old action lock');
    const busyValue = f.page.data[busy], before = f.toasts.length;
    assert.ok(busyValue);
    f.replyWrite(0, 403);
    await old;
    assert.equal(f.page.data.name, 'medicine-B-private-name');
    assert.equal(f.page.data[busy], busyValue, 'old finalizer must not release B busy state');
    assert.equal(f.toasts.length, before, 'old write error must not toast on B');
    f.replyWrite(1);
    await fresh;
    assert.equal(f.page.data[busy], busy === 'busyBatchId' ? '' : false);
  });
}

test('detail quantity: same-identity page reentry invalidates an old success and preserves the new input', async () => {
  const f = await fixture();
  f.holdWrites();
  prepare(f.page, 'quantity');
  const old = invoke(f.page, 'quantity');
  await tick();
  f.page.onHide();
  await f.page.refresh();
  prepare(f.page, 'quantity');
  f.page.setData({ quantityPanelInput: '3' });
  const fresh = invoke(f.page, 'quantity');
  await tick();
  assert.equal(f.writes.length, 2);
  f.replyWrite(0);
  await old;
  assert.equal(f.page.data.quantityPanelInput, '3');
  assert.equal(f.page.data.quantityPanelId, 'medicine-A-single');
  assert.equal(f.page.data.quantityPanelBusy, true);
  f.replyWrite(1);
  await fresh;
  assert.equal(f.page.data.quantityPanelBusy, false);
});

test('detail: owned scope loss clears all private editor projections, including busy overlays', async () => {
  const f = await fixture();
  f.page.setData({ noteInput: 'A-private-note', noteVisibilityIndex: 1,
    thresholdQuantity: '99', thresholdUnitIndex: 0, savingThreshold: true, restockBusy: true,
    busyBatchId: 'medicine-A-single', quantityPanelId: 'medicine-A-single',
    quantityPanelInput: '77', quantityPanelBusy: true,
    openingSplitBatchId: 'medicine-A-split', openingSplitQuantity: '3',
    openingSplitDate: '2026-10-30', openingSplitMode: 'day', openingSplitModeIndex: 1,
    openingSplitValue: '7', openingSplitSource: 'A-private-source',
    openingSplitPreview: 'A-private-preview', openingSplitError: 'A-private-error', openingSplitBusy: true });
  f.setServerFamily('B');
  await f.page.onSubmitNote();
  assert.equal(f.writes.length, 0);
  for (const key of ['noteInput', 'noteVisibilityIndex', 'thresholdQuantity', 'thresholdUnitIndex',
    'savingThreshold', 'restockBusy', 'busyBatchId', 'quantityPanelId', 'quantityPanelInput',
    'quantityPanelBusy', 'openingSplitBatchId', 'openingSplitQuantity', 'openingSplitDate',
    'openingSplitMode', 'openingSplitModeIndex', 'openingSplitValue', 'openingSplitSource',
    'openingSplitPreview', 'openingSplitError', 'openingSplitBusy']) {
    assert.equal(f.page.data[key], f.defaults[key], key + ' must not retain A state');
  }
});

test('detail: an owned auth 401 never starts interactive login to resume the old write', async () => {
  const f = await fixture();
  prepare(f.page, 'note');
  f.expireAuth();
  await f.page.onSubmitNote();
  assert.equal(f.writes.length, 0);
  assert.equal(f.loginCalls(), 0);
  assert.equal(f.page.data.medicineSummary, null);
  assert.equal(f.page.data.noteInput, '');
  assert.deepEqual(f.navigations, ['/pages/login/login']);
});

test('detail: an owned write 401 clears the old form and routes to login without a success claim', async () => {
  const f = await fixture();
  f.holdWrites();
  prepare(f.page, 'note');
  const pending = f.page.onSubmitNote();
  await tick();
  assert.equal(f.writes.length, 1);
  f.replyWrite(0, 401);
  await pending;
  assert.equal(f.page.data.medicineSummary, null);
  assert.equal(f.page.data.noteInput, '');
  assert.deepEqual(f.navigations, ['/pages/login/login']);
  assert.equal(f.toasts.includes('备注已添加'), false);
});

test('detail: an owned ordinary write failure retains the editable form and releases its busy flag', async () => {
  const f = await fixture();
  f.holdWrites();
  prepare(f.page, 'quantity');
  const pending = f.page.onSaveQuantityPanel();
  await tick();
  f.replyWrite(0, 403);
  await pending;
  assert.equal(f.page.data.name, 'medicine-A-private-name');
  assert.equal(f.page.data.quantityPanelInput, '2');
  assert.equal(f.page.data.quantityPanelBusy, false);
  assert.deepEqual(f.navigations, []);
  assert.ok(f.toasts.includes('synthetic old write error'));
});

for (const action of ['delete', 'archive']) {
  test('detail ' + action + ': delayed success navigation belongs to the original visible page', async () => {
    const f = await fixture();
    await invoke(f.page, action);
    assert.equal(f.timers.length, 1);
    await f.show('B', 'medicine-B');
    f.timers[0]();
    assert.equal(f.navigations.length, 0);
    assert.equal(f.page.data.name, 'medicine-B-private-name');

    const current = await fixture();
    await invoke(current.page, action);
    current.timers[0]();
    assert.deepEqual(current.navigations, ['back']);
  });
}

test('detail threshold unit: old confirmation cannot replace a refreshed B selection', async () => {
  const f = await fixture();
  f.holdModals();
  f.page.setData({ thresholdQuantity: '10' });
  f.page.onThresholdUnitChange({ detail: { value: 0 } });
  assert.equal(f.modals.length, 1);
  await f.show('B', 'medicine-B');
  f.page.setData({ thresholdUnitIndex: 8 });
  f.modals[0].success({ confirm: true });
  assert.equal(f.page.data.thresholdUnitIndex, 8);
});

test('detail note: a successful old save preserves text typed while the request was pending', async () => {
  const f = await fixture();
  f.holdWrites();
  prepare(f.page, 'note');
  const pending = f.page.onSubmitNote();
  await tick();
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].data.content, 'medicine-A-new-private-note');
  f.page.onNoteInput({ detail: { value: 'next unsaved note' } });
  f.replyWrite(0);
  await pending;
  assert.equal(f.page.data.noteInput, 'next unsaved note');
  assert.equal(f.page.data.noteSubmitting, false);
});

test('detail note: changing visibility while saving preserves the new unsaved form', async () => {
  const f = await fixture();
  f.holdWrites();
  prepare(f.page, 'note');
  const pending = f.page.onSubmitNote();
  await tick();
  assert.equal(f.writes[0].data.visibility, 'private');
  f.page.onNoteVisibilityChange({ detail: { value: 1 } });
  f.replyWrite(0);
  await pending;
  assert.equal(f.page.data.noteInput, 'medicine-A-new-private-note');
  assert.equal(f.page.data.noteVisibilityIndex, 1);
});

test('detail note: repeated submit while a write is pending dispatches once', async () => {
  const f = await fixture();
  f.holdWrites();
  prepare(f.page, 'note');
  const first = f.page.onSubmitNote();
  await tick();
  const repeated = f.page.onSubmitNote();
  await tick();
  const dispatched = f.writes.length;
  for (let i = 0; i < dispatched; ++i) f.replyWrite(i);
  await Promise.all([first, repeated]);
  assert.equal(dispatched, 1);
  assert.equal(f.page.data.noteInput, '');
  assert.equal(f.page.data.noteSubmitting, false);
});

test('detail note: a failed current write retains input and releases submit for retry', async () => {
  const f = await fixture();
  f.holdWrites();
  prepare(f.page, 'note');
  const first = f.page.onSubmitNote();
  await tick();
  f.replyWrite(0, 403);
  await first;
  assert.equal(f.page.data.noteInput, 'medicine-A-new-private-note');
  assert.equal(f.page.data.noteSubmitting, false);
  const retry = f.page.onSubmitNote();
  await tick();
  assert.equal(f.writes.length, 2);
  f.replyWrite(1);
  await retry;
  assert.equal(f.page.data.noteInput, '');
  assert.equal(f.page.data.noteSubmitting, false);
});

for (const changeBatch of [false, true]) {
  test('detail quantity: old save preserves ' + (changeBatch ? 'a different open batch panel' : 'a newly entered quantity'), async () => {
    const f = await fixture();
    f.holdWrites();
    prepare(f.page, 'quantity');
    const pending = f.page.onSaveQuantityPanel();
    await tick();
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].data.quantity, 2);
    if (changeBatch) f.page.onAdjustQuantity(event('medicine-A-split'));
    f.page.onQuantityPanelInput({ detail: { value: '3' } });
    await f.page.onSaveQuantityPanel();
    assert.equal(f.writes.length, 1, 'the current quantity write still prevents duplicate submission');
    f.replyWrite(0);
    await pending;
    assert.equal(f.page.data.quantityPanelId, changeBatch ? 'medicine-A-split' : 'medicine-A-single');
    assert.equal(f.page.data.quantityPanelInput, '3');
    assert.equal(f.page.data.quantityPanelBusy, false);
  });
}

for (const field of ['enabled', 'quantity', 'unit']) {
  test('detail threshold: saving locks the ' + field + ' editor until its request settles', async () => {
    const f = await fixture();
    f.holdWrites();
    prepare(f.page, 'threshold');
    const before = { enabled: f.page.data.thresholdEnabled, quantity: f.page.data.thresholdQuantity,
      unit: f.page.data.thresholdUnitIndex };
    const pending = f.page.onSaveThreshold();
    await tick();
    assert.equal(f.writes.length, 1);
    if (field === 'enabled') f.page.onThresholdToggle({ detail: { value: false } });
    else if (field === 'quantity') f.page.onThresholdQuantityInput({ detail: { value: '99' } });
    else f.page.onThresholdUnitChange({ detail: { value: before.unit === 0 ? 1 : 0 } });
    const during = { enabled: f.page.data.thresholdEnabled, quantity: f.page.data.thresholdQuantity,
      unit: f.page.data.thresholdUnitIndex };
    await f.page.onSaveThreshold();
    assert.equal(f.writes.length, 1);
    f.replyWrite(0);
    await pending;
    assert.deepEqual(during, before);
    assert.equal(f.page.data.savingThreshold, false);
  });
}

test('detail threshold: a unit confirmation opened before save cannot change the in-flight form', async () => {
  const f = await fixture();
  f.holdWrites();
  f.holdModals();
  prepare(f.page, 'threshold');
  const originalUnit = f.page.data.thresholdUnitIndex;
  f.page.onThresholdUnitChange({ detail: { value: originalUnit === 0 ? 1 : 0 } });
  assert.equal(f.modals.length, 1);
  const pending = f.page.onSaveThreshold();
  await tick();
  f.modals[0].success({ confirm: true });
  const duringUnit = f.page.data.thresholdUnitIndex;
  f.replyWrite(0);
  await pending;
  assert.equal(duringUnit, originalUnit);
});

for (const field of ['enabled', 'quantity', 'unit', 'submit']) {
  test('detail threshold: pending GET after PATCH keeps the ' + field + ' control locked', async () => {
    const f = await fixture();
    f.holdMedicineReads();
    prepare(f.page, 'threshold');
    const before = { enabled: f.page.data.thresholdEnabled, quantity: f.page.data.thresholdQuantity,
      unit: f.page.data.thresholdUnitIndex };
    const pending = f.page.onSaveThreshold();
    await tick();
    assert.equal(f.writes.length, 1, 'the threshold PATCH already returned success');
    assert.equal(f.page.data.loading, true, 'the subsequent medicine GET is still pending');
    let repeated;
    if (field === 'enabled') f.page.onThresholdToggle({ detail: { value: false } });
    else if (field === 'quantity') f.page.onThresholdQuantityInput({ detail: { value: '99' } });
    else if (field === 'unit') f.page.onThresholdUnitChange({ detail: { value: before.unit === 0 ? 1 : 0 } });
    else repeated = f.page.onSaveThreshold();
    await tick();
    const during = { enabled: f.page.data.thresholdEnabled, quantity: f.page.data.thresholdQuantity,
      unit: f.page.data.thresholdUnitIndex };
    const dispatched = f.writes.length;
    f.releaseMedicineReads();
    await Promise.all([pending, repeated]);
    assert.deepEqual(during, before);
    assert.equal(dispatched, 1);
    assert.equal(f.page.data.loading, false);
  });
}

async function notePendingAcrossOtherRefresh(f) {
  f.holdWrites();
  prepare(f.page, 'note');
  const pending = f.page.onSubmitNote();
  await tick();
  assert.equal(f.writes.length, 1);
  const medicineReads = f.reads.filter(path => path === '/api/v1/medicines/medicine-A').length;
  prepare(f.page, 'threshold');
  const other = f.page.onSaveThreshold();
  await tick();
  assert.equal(f.writes.length, 2);
  f.replyWrite(1);
  await other;
  assert.equal(f.page.data.loading, false, 'the unrelated write and its page refresh completed');
  assert.equal(f.reads.filter(path => path === '/api/v1/medicines/medicine-A').length, medicineReads + 1,
    'the unrelated threshold save must actually read the same medicine again');
  return { pending };
}

test('detail note: another action refresh cannot unlock a pending note and allow duplicate submission', async () => {
  const f = await fixture();
  const { pending } = await notePendingAcrossOtherRefresh(f);
  const busyAfterRefresh = f.page.data.noteSubmitting;
  const repeated = f.page.onSubmitNote();
  await tick();
  const dispatched = f.writes.length;
  f.replyWrite(0);
  for (let i = 2; i < dispatched; ++i) f.replyWrite(i);
  await Promise.all([pending, repeated]);
  assert.equal(busyAfterRefresh, true);
  assert.equal(dispatched, 2, 'only one note and one unrelated threshold write may be sent');
  assert.equal(f.page.data.noteSubmitting, false);
  assert.equal(f.page.data.noteInput, '');
});

for (const status of [200, 403, 401]) {
  test('detail note: its ' + status + ' response still settles after a same-view unrelated refresh', async () => {
    const f = await fixture();
    const { pending } = await notePendingAcrossOtherRefresh(f);
    f.replyWrite(0, status);
    await pending;
    assert.equal(f.page.data.noteSubmitting, false);
    if (status === 200) {
      assert.equal(f.page.data.noteInput, '');
      assert.ok(f.toasts.includes('备注已添加'));
      assert.deepEqual(f.navigations, []);
    } else if (status === 403) {
      assert.equal(f.page.data.noteInput, 'medicine-A-new-private-note');
      assert.ok(f.toasts.includes('synthetic old write error'));
      assert.deepEqual(f.navigations, []);
    } else {
      assert.equal(f.page.data.medicineSummary, null);
      assert.equal(f.page.data.noteInput, '');
      assert.deepEqual(f.navigations, ['/pages/login/login']);
    }
  });
}

test('detail note: same-view refresh and old success preserve a newer unsaved note', async () => {
  const f = await fixture();
  const { pending } = await notePendingAcrossOtherRefresh(f);
  f.page.onNoteInput({ detail: { value: 'new draft while the original note is pending' } });
  f.replyWrite(0);
  await pending;
  assert.equal(f.page.data.noteInput, 'new draft while the original note is pending');
  assert.equal(f.page.data.noteSubmitting, false);
  assert.ok(f.toasts.includes('备注已添加'));
});

test('detail note: hide releases its old lock and the old response cannot release a new same-family note', async () => {
  const f = await fixture();
  f.holdWrites();
  prepare(f.page, 'note');
  const old = f.page.onSubmitNote();
  await tick();
  f.page.onHide();
  const busyAfterHide = f.page.data.noteSubmitting;
  await f.page.refresh();
  f.page.onNoteInput({ detail: { value: 'new note after reentry' } });
  const fresh = f.page.onSubmitNote();
  await tick();
  assert.equal(f.writes.length, 2);
  f.replyWrite(0);
  await old;
  assert.equal(busyAfterHide, false);
  assert.equal(f.page.data.noteInput, 'new note after reentry');
  assert.equal(f.page.data.noteSubmitting, true);
  f.replyWrite(1);
  await fresh;
  assert.equal(f.page.data.noteInput, '');
  assert.equal(f.page.data.noteSubmitting, false);
});
