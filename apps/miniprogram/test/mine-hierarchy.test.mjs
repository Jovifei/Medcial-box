import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { loadPage, makePageContext } from './runtime.mjs';

test('mine groups family, tools, data and account without losing routes', () => {
  const markup = fs.readFileSync(new URL('../pages/mine/mine.wxml', import.meta.url), 'utf8');
  for (const label of ['家庭与照护', '药箱工具', '数据管理', '账号与设备', '版本与帮助']) assert.match(markup, new RegExp(label));
  for (const route of ['family', 'care', 'notifications', 'restock', 'stocktake', 'stocktakeSettings', 'export', 'backup', 'trash', 'audit', 'account', 'app', 'release']) assert.match(markup, new RegExp(`data-route="${route}"`));
});
test('mine discards late household results and old device confirmations', async () => {
  let generation = 1, releaseFamily, modal, writes = 0;
  const api = { getCurrentFamily: () => new Promise(resolve => { releaseFamily = resolve; }),
    getDevices: async () => ({devices: [{id:'android-a',clientKind:'android',isCurrent:false}]}),
    revokeAndroidDevice: async () => { writes++; } };
  const { definition } = loadPage('pages/mine/mine.ts', { modules: {
    '../../services/api': { api, ApiError: class extends Error {}, captureSessionIdentity: () => ({token:'token',generation}), isCurrentSession: i => i.generation === generation },
    '../../services/auth': { ensureLoggedIn: async () => {} },
  }, wx: { showModal: o => { modal = o; } } });
  const page = makePageContext(definition);
  const first = page.refresh(); await tick(); generation = 2;
  releaseFamily({family:{name:'A',role:'owner'}}); await first;
  assert.equal(page.data.familyName, ''); assert.equal(page.data.devices.length, 0);
  const second = page.refresh(); await tick();
  releaseFamily({family:{name:'B',role:'owner'}}); await second;
  const revoke = page.onRevokeDevice({currentTarget:{dataset:{id:'android-a'}}});
  generation = 3; modal.success({confirm:true}); await revoke;
  assert.equal(writes, 0);
});
