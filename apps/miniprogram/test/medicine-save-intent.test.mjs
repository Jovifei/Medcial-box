import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { loadPage, makePageContext, makeSessionScopeModule } from './runtime.mjs';

const MEDICINE_ID = 'synthetic-medicine';
const OWNER = { userId: 'synthetic-owner', familyId: 'synthetic-family' };
const field = (page, name, value) => page.onFieldInput({ currentTarget: { dataset: { field: name } }, detail: { value } });
const batchField = (page, name, value) => page.onBatchFieldInput({ currentTarget: { dataset: { index: '0', field: name } }, detail: { value } });

function medicine() {
  return { id: MEDICINE_ID, name: '原有合成药品', version: 1,
    brand: null, specification: null, manufacturer: null, approvalNumber: null, barcodeValue: null,
    activeIngredients: [], populationTags: [], purposeTags: [], purposeCategory: null,
    leaflet: { reviewStatus: 'unverified' },
    batches: [{ id: 'synthetic-batch', version: 1, lotNumber: null,
      expiry: { value: null, precision: 'unknown' }, quantity: 2, unit: 'box', confirmedUnitsPerPackage: null,
      openedState: 'unknown', storageLocation: null }],
  };
}

async function fixture({ update, create, wx: native = {}, isEdit = true } = {}) {
  const scope = makeSessionScopeModule(OWNER);
  const storage = new Map(), writes = [], timers = [], navigation = [], toasts = [];
  const persist = (key, value) => storage.set(key, structuredClone(value));
  const acknowledge = payload => ({ ...medicine(), ...structuredClone(payload),
    id: MEDICINE_ID, version: (payload.version ?? 0) + 1,
    batches: payload.batches.map((batch, index) => ({ ...batch,
      id: batch.id ?? `synthetic-batch-${index}`, version: (batch.version ?? 0) + 1 })),
  });
  const api = {
    getMedicine: async () => medicine(),
    updateMedicine: async (id, payload) => {
      writes.push({ kind: 'update', id, payload: structuredClone(payload) });
      const saved = acknowledge(payload);
      return update ? update(saved, writes.length) : saved;
    },
    createMedicine: async payload => {
      writes.push({ kind: 'create', payload: structuredClone(payload) });
      const saved = acknowledge(payload);
      return create ? create(saved, writes.length) : saved;
    },
  };
  const { definition } = loadPage('pages/medicine-edit/medicine-edit.ts', {
    modules: { 'session-scope': scope,
      '../../services/auth': { ensureLoggedIn: async () => {} },
      '../../services/api': { api, ApiError: class extends Error {} },
    },
    setTimeoutFn(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    wx: {
      getStorageSync: key => structuredClone(storage.get(key)),
      setStorageSync: persist, removeStorageSync: key => storage.delete(key),
      showToast: options => toasts.push(options.title),
      navigateBack: options => { navigation.push('back'); options?.success?.(); },
      reLaunch: options => { navigation.push('relaunch'); options?.success?.(); },
      switchTab: options => { navigation.push('home'); options?.success?.(); },
      ...native,
    },
  });
  const page = makePageContext(definition);
  page.onLoad(isEdit ? { id: MEDICINE_ID } : {});
  if (page.medicineLoadPromise) await page.medicineLoadPromise;
  await page.checkEntrySession();
  field(page, 'name', '本次提交的合成药品');
  const draftKey = scope.scopedStorageKey('medicine-edit-draft', isEdit ? MEDICINE_ID : '');
  return { page, scope, storage, draftKey, writes, timers, navigation, toasts,
    returnAfterSave(index = 0) {
      const timer = timers.filter(item => item.delay === 800)[index];
      assert.ok(timer, 'the production save scheduled its return');
      timer.callback();
    },
  };
}

test('an in-flight edit cannot accept field, stock or candidate changes outside the submitted payload', async () => {
  let finish;
  const h = await fixture({ update: saved => new Promise(resolve => { finish = () => resolve(saved); }) });
  h.page.setData({ candidates: [{ name: '候选合成药品', brand: '尚未确认的品牌', specification: null,
    manufacturer: null, approvalNumber: null, activeIngredients: [], leaflet: null, purposeTags: [], source: 'synthetic' }] });
  const saving = h.page.onSubmit();
  await tick();
  assert.equal(h.writes.length, 1);
  assert.equal(h.page.data.submitting, true);
  try {
    field(h.page, 'name', '请求期间的新名字');
    batchField(h.page, 'quantity', '9');
    h.page.onApplyCandidate({ currentTarget: { dataset: { index: '0' } } });
    h.page.onCoverChoice({ detail: { value: true } });
    assert.equal(h.page.data.name, h.writes[0].payload.name, 'native input must not create an unsaved value while the request owns the form');
    assert.equal(h.page.data.batches[0].quantity, '2');
    assert.equal(h.page.data.brand, '');
    assert.equal(h.page.data.usePhotoAsCover, false);
  } finally {
    finish();
    await saving;
  }
  assert.equal(h.page.data.submitting, false);
});

test('native edit controls expose the same submitting lock without removing the attempted-payload lock', () => {
  const markup = fs.readFileSync(new URL('../pages/medicine-edit/medicine-edit.wxml', import.meta.url), 'utf8');
  const controls = [...markup.matchAll(/<(?:input|textarea|picker|switch|medicine-date-field)\b[^>]*\bbind(?:input|change)="[^"]+"[^>]*>/g)].map(match => match[0]);
  assert.ok(controls.length >= 20, 'the actual editable controls were selected');
  for (const control of controls) {
    const disabled = /\bdisabled="\{\{([^}]+)\}\}"/.exec(control)?.[1];
    assert.match(disabled ?? '', /\bsubmitting\b/, control);
    assert.match(disabled ?? '', /attemptedPayload\s*!==\s*null/, control);
  }
});

test('a unit confirmation opened in the old family cannot change its invalidated form', async () => {
  let modal;
  const h = await fixture({ wx: { showModal: options => { modal = options; } } });
  const original = h.page.data.batches[0].unitIndex;
  const next = (original + 1) % h.page.data.unitLabels.length;
  h.page.onBatchUnitChange({ currentTarget: { dataset: { index: '0' } }, detail: { value: next } });
  assert.ok(modal);
  h.scope.writeSessionScope({ ...OWNER, familyId: 'synthetic-other-family' });
  modal.success({ confirm: true });
  assert.equal(h.page.data.batches[0].unitIndex, original);
  assert.equal(h.page.data.scopeInvalidated, true);
  assert.equal(h.storage.has(h.scope.scopedStorageKey('medicine-edit-draft', MEDICINE_ID)), false);
});

test('draft import and discard cannot replace or erase a pending save intent', async () => {
  let finish;
  const h = await fixture({ update: saved => new Promise(resolve => { finish = () => resolve(saved); }) });
  assert.equal(h.page.persistCurrentDraft(), true);
  h.page.pendingStoredDraft = { ...structuredClone(h.page.pendingStoredDraft), name: '另一个旧草稿' };
  const saving = h.page.onSubmit();
  await tick();
  try {
    await h.page.onRestoreDraft();
    h.page.onDiscardStoredDraft();
    assert.equal(h.page.data.name, '本次提交的合成药品');
    assert.equal(h.storage.get(h.draftKey)?.fields.name, '本次提交的合成药品');
  } finally {
    finish();
    await saving;
  }
});

test('new edits after a successful save survive hide and invalidate the old delayed return', async () => {
  const h = await fixture();
  await h.page.onSubmit();
  assert.equal(h.page.data.isDirty, false);
  field(h.page, 'name', '保存成功后继续修改');
  h.returnAfterSave();
  assert.deepEqual(h.navigation, [], 'the first success cannot navigate away from a newer edit');
  assert.equal(h.page.data.isDirty, true);
  h.page.onHide();
  assert.equal(h.storage.get(h.draftKey)?.fields.name, '保存成功后继续修改', 'the completed save must not leave draft persistence in discard mode');
});

test('the first success timer cannot exit while a second save is pending', async () => {
  let finish;
  const h = await fixture({ update: (saved, count) => count === 2
    ? new Promise(resolve => { finish = () => resolve(saved); }) : saved });
  await h.page.onSubmit();
  field(h.page, 'name', '第二次提交');
  const savingAgain = h.page.onSubmit();
  await tick();
  assert.equal(h.writes.length, 2);
  try {
    h.returnAfterSave(0);
    assert.deepEqual(h.navigation, []);
    assert.equal(h.page.data.submitting, true);
  } finally {
    finish();
    await savingAgain;
  }
  h.returnAfterSave(1);
  assert.deepEqual(h.navigation, ['back']);
  assert.equal(h.writes[1].payload.name, '第二次提交');
  assert.equal(h.writes[1].payload.version, 2);
});

test('only the newest successful save owns its delayed return', async () => {
  const h = await fixture();
  await h.page.onSubmit();
  field(h.page, 'brand', '第二次核对品牌');
  await h.page.onSubmit();
  h.returnAfterSave(0);
  assert.deepEqual(h.navigation, []);
  h.returnAfterSave(1);
  assert.deepEqual(h.navigation, ['back']);
});

test('hiding a saved page invalidates its return timer before it can pop another page', async () => {
  const h = await fixture();
  await h.page.onSubmit();
  h.page.onHide();
  h.returnAfterSave();
  assert.deepEqual(h.navigation, []);
});

for (const transition of ['hide', 'unload', 'family', 'edit']) {
  test(`a late Back failure cannot relaunch after ${transition} invalidates its navigation intent`, async () => {
    let back;
    const navigation = [];
    const h = await fixture({ wx: {
      navigateBack(options) { navigation.push('back'); back = options; },
      reLaunch() { navigation.push('relaunch'); },
    } });
    await h.page.onSubmit();
    h.returnAfterSave();
    assert.ok(back);
    const toastCount = h.toasts.length;
    if (transition === 'hide') h.page.onHide();
    if (transition === 'unload') h.page.onUnload();
    if (transition === 'family') h.scope.writeSessionScope({ ...OWNER, familyId: 'synthetic-next-family' });
    if (transition === 'edit') field(h.page, 'name', '跳转等待期间的新编辑');
    back.fail();
    assert.deepEqual(navigation, ['back']);
    assert.equal(h.toasts.length, toastCount);
    if (transition !== 'unload') assert.equal(h.page.leaveNavigationPending, false, 'an invalidated return must not lock the form');
  });
}

test('a late home-fallback failure cannot unlock or notify a newer visible-page return', async () => {
  const backs = [], fallbacks = [];
  const h = await fixture({ wx: {
    navigateBack(options) { backs.push(options); },
    reLaunch(options) { fallbacks.push(options); },
  } });
  await h.page.onSubmit();
  h.returnAfterSave();
  backs[0].fail();
  assert.equal(fallbacks.length, 1);
  h.page.onHide();
  h.page.onShow();
  h.page.onRequestLeave();
  assert.equal(backs.length, 2, 'returning to the page permits a fresh Back');
  const toastCount = h.toasts.length;
  fallbacks[0].fail();
  assert.equal(h.page.leaveNavigationPending, true, 'the old failure cannot release the new navigation lock');
  assert.equal(h.toasts.length, toastCount);
  backs[1].fail();
  fallbacks[1].fail();
  assert.equal(h.page.leaveNavigationPending, false, 'the current failed navigation remains retryable');
  assert.equal(h.toasts.at(-1), '返回失败，请稍后重试');
});

test('the user can still leave an already-invalidated form with the current session', async () => {
  let back;
  const navigation = [];
  const h = await fixture({ wx: {
    navigateBack(options) { navigation.push('back'); back = options; },
    reLaunch(options) { navigation.push('relaunch'); options.fail(); },
  } });
  h.scope.writeSessionScope({ ...OWNER, familyId: 'synthetic-next-family' });
  assert.equal(h.page.data.scopeInvalidated, true);
  h.page.onRequestLeave();
  back.fail();
  assert.deepEqual(navigation, ['back', 'relaunch']);
  assert.equal(h.page.leaveNavigationPending, false);
});

test('a late home-fallback failure after a family change releases only its lock without a stale toast', async () => {
  let fallback;
  const h = await fixture({ wx: {
    navigateBack(options) { options.fail(); },
    reLaunch(options) { fallback = options; },
  } });
  await h.page.onSubmit();
  h.returnAfterSave();
  assert.ok(fallback);
  const toastCount = h.toasts.length;
  h.scope.writeSessionScope({ ...OWNER, familyId: 'synthetic-next-family' });
  fallback.fail();
  assert.equal(h.page.leaveNavigationPending, false);
  assert.equal(h.toasts.length, toastCount);
});

test('failed return and home fallback allow later editing, draft preservation and another Back', async () => {
  const navigation = [];
  const h = await fixture({ wx: {
    navigateBack(options) { navigation.push('back'); if (navigation.length === 1) options.fail(); },
    reLaunch(options) { navigation.push('relaunch'); options.fail(); },
  } });
  await h.page.onSubmit();
  h.returnAfterSave();
  assert.equal(h.page.leaveNavigationPending, false);
  field(h.page, 'name', '跳转失败后继续编辑');
  h.page.onHide();
  assert.equal(h.storage.get(h.draftKey)?.fields.name, '跳转失败后继续编辑');
  h.page.onRequestLeave();
  h.page.onLeaveChoice({ currentTarget: { dataset: { choice: 'keep' } } });
  assert.deepEqual(navigation, ['back', 'relaunch', 'back']);
});

test('a failed edit releases only the busy lock and preserves recoverable form values', async () => {
  const h = await fixture({ update: async () => { throw new Error('synthetic network failure'); } });
  await h.page.onSubmit();
  assert.equal(h.page.data.submitting, false);
  assert.equal(h.page.data.isDirty, true);
  field(h.page, 'name', '失败后继续核对');
  h.page.onHide();
  assert.equal(h.storage.get(h.draftKey)?.fields.name, '失败后继续核对');
  assert.equal(h.timers.filter(item => item.delay === 800).length, 0);
});

test('a successful new entry retains its original payload lock when returning home fails', async () => {
  const h = await fixture({ isEdit: false, wx: { switchTab: options => options.fail?.() } });
  await h.page.onSubmit();
  const payload = structuredClone(h.page.data.attemptedPayload);
  assert.ok(payload);
  h.returnAfterSave();
  assert.equal(h.page.data.submitting, false);
  assert.equal(h.page.leaveNavigationPending, false);
  field(h.page, 'name', '不得改变已提交内容');
  assert.deepEqual(structuredClone(h.page.data.attemptedPayload), payload);
  assert.equal(h.page.data.name, payload.name);
  h.page.onRequestLeave();
  assert.deepEqual(h.navigation, ['back']);
  assert.equal(h.writes.length, 1);
});
