import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { loadPage, loadService, makePageContext } from './runtime.mjs';

// Use the production API's pure calculations to distinguish unknown stock
// thresholds from unknown quantities. No database or network is involved.
const expiry = loadService('../api/src/domain/expiry.ts');
const decimal = loadService('../api/src/domain/decimal.ts');
const inventory = loadService('../api/src/domain/medicine-inventory.ts', {
  modules: { './expiry.js': expiry, './decimal.js': decimal },
});
const now = new Date('2026-11-02T04:00:00.000Z');

function batch(id, overrides = {}) {
  const value = {
    id, lotNumber: null, quantity: 2, unit: 'box',
    expiry: { value: '2030-12-31', precision: 'day' },
    confirmedUnitsPerPackage: null, conversionUnit: null,
    storageLocation: '合成药箱', openedState: 'unopened', openedAt: null,
    afterOpeningLimit: null, dispositionStatus: 'active', version: 1,
    ...overrides,
  };
  const openedExpiryDate = inventory.calculateOpenedExpiryDate(value.openedAt, value.afterOpeningLimit);
  const effective = inventory.calculateEffectiveExpiryDate(value.expiry, openedExpiryDate);
  return {
    ...value,
    expiryState: expiry.describeExpiry(value.expiry, now),
    openedExpiryDate,
    managementExpiryDate: effective.date,
    managementExpirySource: effective.source,
    managementExpiryState: inventory.describeManagementExpiry(effective.date, now),
  };
}

function medicine(id, batches, overrides = {}) {
  const threshold = overrides.lowStockThreshold ?? null;
  const current = batches.filter(item => item.dispositionStatus !== 'handled');
  const state = current.length > 0
    ? expiry.mostSevereState(current.map(item => item.managementExpiryState?.state ?? item.expiryState.state))
    : 'unknown';
  return {
    id, name: `合成药品 ${id}`, createdAt: '2026-01-01T00:00:00.000Z',
    specification: '合成规格', manufacturer: '合成药厂', approvalNumber: null,
    activeIngredients: ['合成成分'], purposeCategory: null,
    populationTags: [], purposeTags: [], coverPhotoId: null,
    leaflet: { purposeSummary: null, packageUsageSummary: null,
      contraindicationsSummary: null, precautionsSummary: null, source: null,
      reviewStatus: 'user_confirmed' },
    batches, lowStockThreshold: threshold,
    stockStatus: inventory.calculateStockStatus(batches, threshold, now),
    expiryState: { state, label: expiry.summarizeExpiryState(state) },
    isArchived: false, version: 1, ...overrides,
  };
}

function pageFor(medicines) {
  const { definition } = loadPage('pages/index/index.ts', {
    modules: {
      '../../services/api': { api: {}, ApiError: class extends Error {}, readToken: () => 'synthetic-token' },
      '../../services/auth': { ensureLoggedIn: async () => {} },
    },
  });
  const page = makePageContext(definition);
  page.applyMedicines(medicines, '合成家庭');
  return page;
}

const select = (page, kind) => page.onSelectFilter({ currentTarget: { dataset: { kind } } });
const ids = page => Array.from(page.data.items, item => item.id);

test('known quantities and dates do not become unknown because a threshold is absent or incomparable', () => {
  const noThreshold = medicine('no-threshold', [batch('a')]);
  const mixedUnits = medicine('mixed-units', [batch('b'), batch('c', { unit: 'tablet' })], {
    lowStockThreshold: { quantity: 1, unit: 'box' },
  });
  assert.equal(noThreshold.stockStatus.state, 'unknown');
  assert.equal(mixedUnits.stockStatus.state, 'unknown');
  const page = pageFor([noThreshold, mixedUnits]);
  select(page, 'unknown');
  assert.deepEqual(ids(page), []);
});

test('zero quantities remain exhausted without a threshold and count toward insufficient stock', () => {
  const zero = medicine('zero', [batch('zero-box', { quantity: 0 }), batch('zero-ml', { quantity: 0, unit: 'ml' })]);
  assert.equal(zero.stockStatus.state, 'unknown');
  const page = pageFor([
    zero,
    medicine('some-left', [batch('empty', { quantity: 0 }), batch('left', { quantity: 1 })]),
    medicine('not-counted', [batch('empty-known', { quantity: 0 }), batch('unknown', { quantity: null })]),
  ]);
  select(page, 'exhausted');
  assert.deepEqual(ids(page), ['zero']);
  assert.equal(page.data.lowStockCount, 1);
  select(page, 'low');
  assert.deepEqual(ids(page), ['zero']);
});

test('one unknown management date cannot be relabelled normal by another dated batch', () => {
  const item = medicine('mixed-dates', [batch('known'), batch('unknown', {
    expiry: { value: null, precision: 'unknown' },
  })], { lowStockThreshold: { quantity: 1, unit: 'box' } });
  assert.equal(item.stockStatus.state, 'ok');
  assert.equal(item.expiryState.state, 'unknown');
  const page = pageFor([item]);
  assert.equal(page.data.items[0].state, item.expiryState.state);
  select(page, 'unknown');
  assert.deepEqual(ids(page), ['mixed-dates']);
});

test('unknown-date filter retains a mixed medicine even when another batch is expired', () => {
  const item = medicine('expired-and-unknown', [
    batch('expired', { expiry: { value: '2020-01-01', precision: 'day' } }),
    batch('unknown', { expiry: { value: null, precision: 'unknown' } }),
  ], { lowStockThreshold: { quantity: 1, unit: 'box' } });
  assert.equal(item.stockStatus.state, 'ok');
  const page = pageFor([item]);
  assert.equal(page.data.items[0].state, 'expired');
  select(page, 'unknown');
  assert.deepEqual(ids(page), ['expired-and-unknown']);
});

test('handled history does not require an inventory check while a medicine without batches does', () => {
  const page = pageFor([
    medicine('no-batches', []),
    medicine('handled-unknown', [batch('old-unknown', {
      quantity: null, expiry: { value: null, precision: 'unknown' }, dispositionStatus: 'handled',
    })]),
    medicine('handled-zero', [batch('old-zero', { quantity: 0, dispositionStatus: 'handled' })]),
    medicine('active-known', [batch('active'), batch('old', {
      quantity: null, expiry: { value: null, precision: 'unknown' }, dispositionStatus: 'handled',
    })]),
  ]);
  select(page, 'unknown');
  assert.deepEqual(ids(page), ['no-batches']);
  select(page, 'exhausted');
  assert.deepEqual(ids(page), []);
});

test('quantity display preserves unknown, zero and separate units without package inference', () => {
  const page = pageFor([medicine('quantities', [
    batch('unknown', { quantity: null }), batch('zero', { quantity: 0 }),
    batch('boxes', { quantity: 2, confirmedUnitsPerPackage: 20, conversionUnit: 'tablet' }),
    batch('tablets', { quantity: 5, unit: 'tablet' }), batch('ml', { quantity: 0.125, unit: 'ml' }),
    batch('handled', { quantity: 77, dispositionStatus: 'handled' }),
  ])]);
  assert.equal(page.data.items[0].quantityText, '数量：数量未知 / 已耗尽 / 2盒 / 5片 / 0.125毫升');
  select(page, 'unknown');
  assert.deepEqual(ids(page), ['quantities']);
});

test('inventory-check warning is bound to batch quantity uncertainty rather than threshold status', () => {
  const markup = fs.readFileSync(new URL('../pages/index/index.wxml', import.meta.url), 'utf8');
  const warning = markup.match(/<view\b[^>]*class="stock-warning unknown"[^>]*>/)?.[0] ?? '';
  assert.match(warning, /item\.hasUnknownQuantity/);
  assert.doesNotMatch(warning, /item\.stockState/);
});

test('unparseable expiry text with an explicit null management date sorts last in both directions', () => {
  const unknown = medicine('unknown', [batch('raw', { expiry: expiry.parseExpiry('2030-02-30') })]);
  assert.equal(unknown.batches[0].expiry.precision, 'unknown');
  assert.equal(unknown.batches[0].managementExpiryDate, null);
  const page = pageFor([
    unknown,
    medicine('later', [batch('later-date', { expiry: { value: '2030-03-15', precision: 'day' } })]),
    medicine('earlier', [batch('earlier-date', { expiry: { value: '2030-01-15', precision: 'day' } })]),
  ]);
  assert.deepEqual(ids(page), ['earlier', 'later', 'unknown']);
  const projected = page.data.allItems.find(item => item.id === 'unknown');
  assert.equal(projected.earliestDate, null);
  assert.equal(projected.expiryText, '有效期未知');
  page.onSortChange({ detail: { value: '1' } });
  assert.deepEqual(ids(page), ['later', 'earlier', 'unknown']);
  assert.equal(unknown.batches[0].expiry.value, '2030-02-30', 'the original unknown text is retained in the response');
});

function legacyMonth(id, year) {
  const result = batch(id, { expiry: { value: `${year}-02`, precision: 'month' } });
  delete result.managementExpiryDate;
  delete result.managementExpirySource;
  delete result.managementExpiryState;
  return result;
}

test('legacy month precision uses month-end ordering without displaying a fabricated day', () => {
  for (const [year, lastDay] of [['2030', '28'], ['2028', '29']]) {
    const month = medicine('month', [legacyMonth('month-date', year)]);
    const day = medicine('day', [batch('day-date', { expiry: { value: `${year}-02-14`, precision: 'day' } })]);
    const page = pageFor([month, day]);
    assert.deepEqual(ids(page), ['day', 'month']);
    assert.equal(page.data.allItems[0].expiryText, `截止：${year}-02`);
    assert.equal(page.data.allItems[0].earliestDate, `${year}-02-${lastDay}`);
    page.onSortChange({ detail: { value: '1' } });
    assert.deepEqual(ids(page), ['month', 'day']);
    assert.equal(month.batches[0].expiry.value, `${year}-02`);

    page.applyMedicines([medicine('mixed', [...month.batches, ...day.batches])], '合成家庭');
    assert.equal(page.data.items[0].expiryText, `截止：${year}-02-14`);
  }
});

test('management deadline remains authoritative when opening shortens the package deadline', () => {
  const page = pageFor([medicine('opened', [batch('opened-batch', {
    openedState: 'opened', openedAt: '2029-01-01', afterOpeningLimit: { date: '2029-01-31' },
  })])]);
  assert.equal(page.data.items[0].earliestDate, '2029-01-31');
  assert.equal(page.data.items[0].expiryText, '截止：2029-01-31（开封期优先）');
});

test('invalid picker values leave the previous sort and its summary intact', () => {
  const page = pageFor([medicine('a', [batch('a')])]);
  page.onSortChange({ detail: { value: '2' } });
  const summary = page.data.filterSummary;
  for (const value of ['', ' ', 'bad', -1, 4, 1.5, Infinity]) {
    page.onSortChange({ detail: { value } });
    assert.equal(page.data.sortIndex, 2);
    assert.equal(page.data.sortKey, 'name');
    assert.equal(page.data.filterSummary, summary);
  }
});

test('clearing keyword and resetting filters remain independent after combined filtering', () => {
  const page = pageFor([
    medicine('a', [batch('a')], { manufacturer: 'ABC 合成药厂', populationTags: ['child'], purposeTags: ['fever'] }),
    medicine('b', [batch('b')], { manufacturer: 'XYZ 合成药厂', populationTags: ['child'], purposeTags: ['fever'] }),
    medicine('c', [batch('c')], { manufacturer: 'ABC 合成药厂', populationTags: ['adult'], purposeTags: ['pain'] }),
  ]);
  page.onTogglePopulation({ currentTarget: { dataset: { value: 'child' } } });
  page.onTogglePurpose({ currentTarget: { dataset: { value: '发热' } } });
  page.onSortChange({ detail: { value: '2' } });
  page.onSearchInput({ detail: { value: ' abc ' } });
  assert.deepEqual(ids(page), ['a']);
  page.onClearSearch();
  assert.deepEqual(ids(page), ['a', 'b']);
  assert.equal(page.data.sortKey, 'name');
  assert.deepEqual([...page.data.selectedPopulations], ['child']);
  assert.deepEqual([...page.data.selectedPurposes], ['发热']);
  page.onSearchInput({ detail: { value: ' abc ' } });
  page.onClearFilters();
  assert.equal(page.data.keyword, ' abc ');
  assert.equal(page.data.sortIndex, 0);
  assert.deepEqual([...page.data.selectedPopulations], []);
  assert.deepEqual([...page.data.selectedPurposes], []);
  assert.deepEqual(ids(page), ['a', 'c']);
});
