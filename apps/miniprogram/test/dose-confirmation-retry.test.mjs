import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {loadPage, makePageContext} from './runtime.mjs';

const click = (action = 'taken', id = 'occ-1') => ({currentTarget:{dataset:{id,action}}});
const tick = () => new Promise(resolve => setTimeout(resolve, 2));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };

function harness({confirm, login = async () => {}, modal} = {}) {
  let generation = 0;
  const state = {date:'2026-10-03', status:'pending', id:'occ-1', failRead:false};
  const requests = [], events = new Map(), toasts = [], modals = [];
  const currentIdentity = () => ({token:`synthetic-${generation}`, generation});
  const modules = {
    '../../services/api': {
      ApiError: class extends Error {},
      captureSessionIdentity: currentIdentity,
      isCurrentSession: identity => identity.generation === generation,
      api: {
        getMedicationSchedule: async date => { if(state.failRead) throw new Error('read failed'); return {date, entries:[{
          occurrenceId:state.id, planId:'plan', careProfileId:'profile', careProfileName:'合成对象',
          medicineName:'合成药品', dosageText:'测试记录', time:'08:00', status:state.status,
        }]}; },
        listMedicationPlans: async () => ({plans:[]}),
        listCareProfiles: async () => ({careProfiles:[]}),
        getDoseReminderStatus: async () => ({available:false,templateId:'',deliveries:[]}),
        confirmDoseOccurrence: async (id, action, key) => {
          const request = {id,action,key}; requests.push(request);
          const accept = () => { if (!events.has(key)) { events.set(key, request); state.status = action; } };
          if (confirm) { await confirm({request, accept, requests}); return {status:state.status}; }
          accept(); return {status:state.status};
        },
      },
    },
    '../../services/auth': {ensureLoggedIn:login},
  };
  const {definition} = loadPage('pages/medication-plans/medication-plans.ts', {modules, wx:{
    showToast: ({title}) => toasts.push(title),
    showModal: options => { modals.push(options); if (modal) modal(options); else options.success({confirm:true}); },
  }});
  const page = () => { const p = makePageContext(definition); p.data.date = state.date; return p; };
  return {page, state, requests, events, toasts, modals, changeIdentity:()=>generation++};
}

test('accepted+lost response only replays on explicit tap and records one event', async () => {
  const h = harness({confirm:({accept,requests}) => { accept(); if (requests.length === 1) throw new Error('accepted, response lost'); }});
  const page = h.page(); await page.refresh(); await page.onConfirmDose(click());
  await tick(); assert.equal(h.requests.length, 1, 'no automatic write replay');
  await page.onConfirmDose(click());
  assert.equal(h.requests[0].key, h.requests[1].key); assert.equal(h.events.size, 1);
});

test('uncertain opposite action is blocked, explicit original retry resolves before correction', async () => {
  const h = harness({confirm:({accept,requests}) => { accept(); if (requests.length === 1) throw new Error('lost'); }});
  const page = h.page(); await page.refresh(); await page.onConfirmDose(click());
  await page.onConfirmDose(click('skipped')); assert.equal(h.requests.length, 1);
  assert.match(h.toasts.at(-1), /重试/);
  await page.refresh(); // A successful read is not a definitive write response.
  await page.onConfirmDose(click('skipped')); assert.equal(h.requests.length, 1);
  await page.onConfirmDose(click()); assert.equal(h.events.size, 1);
  await page.onConfirmDose(click('skipped'));
  assert.equal(h.events.size, 2); assert.equal(h.state.status, 'skipped');
  assert.notEqual(h.requests[2].key, h.requests[0].key); assert.equal(h.modals.length, 1);
});

test('late server commit cannot be overtaken by an opposite action after timeout', async () => {
  let lateAccept;
  const h = harness({confirm:({accept,requests}) => { if (requests.length === 1) { lateAccept = accept; throw new Error('timeout while server running'); } accept(); }});
  const page = h.page(); await page.refresh(); await page.onConfirmDose(click());
  await page.onConfirmDose(click('skipped')); assert.equal(h.requests.length, 1);
  lateAccept(); await page.onConfirmDose(click()); await page.onConfirmDose(click('skipped'));
  assert.equal(h.state.status,'skipped'); assert.equal(h.events.size,2);
});

test('completed operations and A-B-A corrections receive distinct keys', async () => {
  const h = harness(); const page = h.page(); await page.refresh();
  await page.onConfirmDose(click()); await page.onConfirmDose(click('skipped')); await page.onConfirmDose(click());
  assert.equal(new Set(h.requests.map(r=>r.key)).size, 3); assert.equal(h.events.size,3);
});

test('double taps including correction modal issue one request', async () => {
  const pending = deferred();
  const h = harness({confirm:async ({accept})=>{ await pending.promise; accept(); }});
  h.state.status = 'taken'; let finishModal;
  const h2 = harness({modal:o=>{finishModal=o;}}); h2.state.status = 'taken';
  const page = h.page(); await page.refresh();
  const first = page.onConfirmDose(click()); const second = page.onConfirmDose(click());
  await tick(); assert.equal(h.requests.length,1); pending.resolve(); await Promise.all([first,second]);
  const page2 = h2.page(); await page2.refresh(); const a = page2.onConfirmDose(click('skipped')); const b = page2.onConfirmDose(click('skipped'));
  assert.equal(h2.modals.length,1); finishModal.success({confirm:true}); await Promise.all([a,b]); assert.equal(h2.requests.length,1);
});

test('cancelled correction and changed identity/date while dialog is open never write', async () => {
  for (const mutation of ['cancel','identity','date']) {
    let dialog; const h = harness({modal:o=>{dialog=o;}}); h.state.status='taken';
    const page = h.page(); await page.refresh(); const pending = page.onConfirmDose(click('skipped'));
    if (mutation === 'identity') h.changeIdentity();
    if (mutation === 'date') page.setData({date:'2026-10-04'});
    dialog.success({confirm:mutation !== 'cancel'}); await pending; assert.equal(h.requests.length,0,mutation);
  }
});

test('page remount and date round trip preserve same-session uncertain key without replay', async () => {
  const h = harness({confirm:({requests,accept})=>{accept(); if(requests.length===1) throw new Error('lost');}});
  const page = h.page(); await page.refresh(); await page.onConfirmDose(click());
  const remount = h.page(); remount.data.date='2026-10-04'; h.state.id='occ-2'; await remount.refresh();
  assert.equal(h.requests.length,1);
  h.state.id='occ-1'; remount.data.date='2026-10-03'; await remount.refresh(); await remount.onConfirmDose(click());
  assert.equal(h.requests[0].key,h.requests[1].key); assert.equal(h.events.size,1);
});

test('identity change blocks stale entries; refreshed identity and new occurrence get fresh keys', async () => {
  const h = harness({confirm:({accept})=>{accept(); throw new Error('lost');}});
  const page = h.page(); await page.refresh(); await page.onConfirmDose(click());
  h.changeIdentity(); await page.onConfirmDose(click()); assert.equal(h.requests.length,1);
  h.state.status='pending'; await page.refresh(); await page.onConfirmDose(click());
  h.state.id='occ-2'; page.data.date='2026-10-04'; await page.refresh(); await page.onConfirmDose(click('taken','occ-2'));
  assert.equal(new Set(h.requests.map(r=>r.key)).size,3);
});

test('identity/date change while login awaits cancels write', async () => {
  for (const mutation of ['identity','date']) {
    let waiting = false; const gate=deferred();
    const h=harness({login:()=>waiting?gate.promise:Promise.resolve()});
    const page=h.page(); await page.refresh(); waiting=true; const confirm=page.onConfirmDose(click());
    if(mutation==='identity') h.changeIdentity(); else page.data.date='2026-10-04';
    gate.resolve(); await confirm; assert.equal(h.requests.length,0,mutation);
  }
});


test('known write acknowledgment remains visible after refresh fails, correction still requires consent', async () => {
  const h = harness({modal: options => options.success({confirm:false})});
  const page=h.page(); await page.refresh(); h.state.failRead=true;
  await page.onConfirmDose(click());
  assert.equal(page.data.entries[0].status,'taken');
  assert.match(page.data.errorMessage,/加载失败/);
  await page.onConfirmDose(click('skipped'));
  assert.equal(h.modals.length,1); assert.equal(h.requests.length,1);
});

test('in-flight operation stays locked across page remount until explicit retry after failure', async () => {
  const gate=deferred();
  const h=harness({confirm:async({accept,requests})=>{ if(requests.length===1) {await gate.promise; accept(); throw new Error('lost');} accept(); }});
  const page=h.page(); await page.refresh(); const first=page.onConfirmDose(click());
  await tick(); page.onUnload?.();
  const second=h.page(); await second.refresh(); await second.onConfirmDose(click());
  assert.equal(h.requests.length,1); gate.resolve(); await first;
  await second.onConfirmDose(click()); assert.equal(h.requests.length,2);
  assert.equal(h.requests[0].key,h.requests[1].key); assert.equal(h.events.size,1);
});


test('replay shows authoritative corrected status even if refresh fails', async () => {
  const h=harness({confirm:({accept,requests})=>{accept(); if(requests.length===1) throw new Error('lost');}});
  const page=h.page(); await page.refresh(); await page.onConfirmDose(click());
  h.state.status='skipped'; h.state.failRead=true;
  await page.onConfirmDose(click());
  assert.equal(h.events.size,1); assert.equal(page.data.entries[0].status,'skipped');
  assert.match(h.toasts.at(-1),/跳过/); assert.doesNotMatch(h.toasts.at(-1),/服用/);
});


test('old page acknowledged write refreshes remounted pending UI before any new write', async () => {
  const gate=deferred();
  const h=harness({confirm:async({accept})=>{await gate.promise; accept();}});
  const first=h.page(); await first.refresh(); const write=first.onConfirmDose(click()); await tick();
  first.onUnload?.(); const second=h.page(); await second.refresh();
  gate.resolve(); await write; await tick();
  assert.equal(second.data.entries[0].status,'taken'); assert.equal(h.requests.length,1);
});


test('explicit retry binding carries original action and hides correction controls until resolved', async () => {
  const markup=fs.readFileSync(new URL('../pages/medication-plans/medication-plans.wxml',import.meta.url),'utf8');
  assert.match(markup,/wx:if="{{item.retryAction !== ''}}"[\s\S]*?data-action="{{item.retryAction}}"[^>]*bindtap="onConfirmDose"[\s\S]*?重试上次记录/);
  assert.match(markup,/wx:elif="{{item.status === 'pending'}}"/);
  const h=harness({confirm:({accept,requests})=>{accept(); if(requests.length===1) throw new Error('lost');}});
  const page=h.page(); await page.refresh(); await page.onConfirmDose(click('skipped'));
  assert.equal(page.data.visibleEntries[0].retryAction,'skipped');
  await page.refresh(); assert.equal(page.data.visibleEntries[0].status,'skipped');
  assert.equal(page.data.visibleEntries[0].retryAction,'skipped');
  await page.onConfirmDose(click(page.data.visibleEntries[0].retryAction));
  assert.equal(h.events.size,1); assert.equal(h.requests[0].key,h.requests[1].key);
  assert.equal(page.data.visibleEntries[0].retryAction,'');
});
