'use strict';
// MEDICINE_QA_ONLY: pure in-process mock. Never imports a transport or uses real data.
const ORIGIN = 'http://127.0.0.1:43187';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const routes = [
  ['POST', /^\/api\/v1\/auth\/(wechat|logout)$/],
  ['GET', /^\/api\/v1\/auth\/me$/],
  ['GET', /^\/api\/v1\/families\/current$/],
  ['GET', /^\/api\/v1\/medicines$/], ['POST', /^\/api\/v1\/medicines$/],
  ['GET', /^\/api\/v1\/medicines\/qa-medicine-\d+$/],
  ['PUT', /^\/api\/v1\/medicines\/qa-medicine-\d+$/],
  ['POST', /^\/api\/v1\/medicines\/qa-medicine-\d+\/cover-photo$/],
  ['GET', /^\/api\/v1\/medicines\/qa-medicine-\d+\/dosage-notes$/],
  ['GET', /^\/api\/v1\/medicines\/qa-medicine-\d+\/leaflet-photos$/],
  ['POST', /^\/api\/v1\/medicines\/qa-medicine-\d+\/leaflet-photos$/],
  ['GET', /^\/api\/v1\/medicines\/qa-medicine-\d+\/leaflet-photos\/qa-photo-\d+$/],
  ['DELETE', /^\/api\/v1\/medicines\/qa-medicine-\d+\/leaflet-photos\/qa-photo-\d+$/],
  ['POST', /^\/api\/v1\/recognitions\/medicine$/],
  ['POST', /^\/api\/v1\/medicine-catalog\/candidates$/],
];
function validateRequest(url, method) {
  // Deliberately narrower than URL normalization: reject every ambiguous spelling.
  // No percent escapes, credentials, alternate ports, dot segments, backslashes or fragments.
  if (typeof url !== 'string' || !url.startsWith(ORIGIN + '/') ||
      /[%\\#\s]/.test(url)) throw new Error('QA network origin/encoding denied');
  const suffix = url.slice(ORIGIN.length);
  const parts = suffix.split('?');
  const route = parts[0];
  if (parts.length > 2 || route.includes('//') || route.split('/').some(x => x === '.' || x === '..') ||
      (parts.length === 2 && !(method === 'GET' && route === '/api/v1/medicines' && parts[1] === 'includeArchived=true')) ||
      !routes.some(([verb, pattern]) => method === verb && pattern.test(route))) {
    throw new Error('QA method/normalized route denied: ' + method + ' ' + route);
  }
  return route;
}
function createMock() {
  let actor = 'A';
  let nextMedicine = 2;
  let nextPhoto = 1;
  const byActor = new Map();
  const time = '2026-10-01T00:00:00.000Z';
  const medicine = (id, input = {}) => ({
    name: 'QA 合成样品（勿服用）', specification: 'QA', manufacturer: 'QA 合成厂',
    approvalNumber: null, barcodeValue: null, activeIngredients: [], purposeCategory: null,
    populationTags: [], purposeTags: [], coverPhotoId: null, version: 1, createdAt: time,
    leaflet: { purposeSummary: null, packageUsageSummary: null, contraindicationsSummary: null,
      precautionsSummary: null, source: 'QA synthetic', reviewStatus: 'unverified' },
    batches: [], ...clone(input), id,
  });
  const state = () => {
    if (!byActor.has(actor)) byActor.set(actor, { medicines: [medicine('qa-medicine-1')], photos: [], creates: new Map() });
    return byActor.get(actor);
  };
  function dispatch({ url, method = 'GET', data, header = {} }) {
    const path = validateRequest(url, method);
    const ok = (body, statusCode = 200) => ({ statusCode, data: clone(body), header: { 'x-medicine-qa': 'synthetic-only' } });
    const fail = (code, statusCode) => ok({ error: { code, message: 'QA synthetic ' + code } }, statusCode);
    if (path === '/api/v1/auth/wechat') {
      if (data?.code !== 'qa-code-' + actor) return fail('QA_CODE_REQUIRED', 401);
      return ok({ token: 'qa-token-' + actor, expiresAt: '2099-01-01T00:00:00Z', user: { id: 'qa-user-' + actor, hasFamily: true } });
    }
    if (header.authorization !== 'Bearer qa-token-' + actor) return fail('UNAUTHORIZED', 401);
    const family = { id: 'qa-family-' + actor, name: 'QA 合成家庭 ' + actor, role: 'owner' };
    if (path === '/api/v1/auth/me') return ok({ user: { id: 'qa-user-' + actor, nickname: 'QA ' + actor, hasFamily: true }, family });
    if (path === '/api/v1/auth/logout') return ok({ revoked: true });
    if (path === '/api/v1/families/current') return ok({ family: { ...family, members: [{ id: 'qa-user-' + actor, displayName: 'QA ' + actor, isSelf: true, role: 'owner', joinedAt: time }] } });
    if (path === '/api/v1/recognitions/medicine') {
      if (data?.imageBase64 !== PNG) return fail('SYNTHETIC_IMAGE_REQUIRED', 400);
      return ok({ draft: { name: 'QA 合成样品（勿服用）', specification: 'QA', manufacturer: 'QA 合成厂', approvalNumber: null,
        purposeCategory: null, lotNumber: 'QA-LOT', expiryValue: '2099-12', expiryPrecision: 'month', purposeTags: [] }, warnings: ['纯合成数据，仅验证页面流程'], requiresConfirmation: true });
    }
    if (path === '/api/v1/medicine-catalog/candidates') return ok({ candidates: [], warnings: ['QA：无真实条码查询'], source: 'QA synthetic' });
    const db = state();
    if (path === '/api/v1/medicines') {
      if (method === 'GET') return ok({ medicines: db.medicines });
      if (data?.idempotencyKey && db.creates.has(data.idempotencyKey)) return ok(db.creates.get(data.idempotencyKey));
      const saved = medicine('qa-medicine-' + nextMedicine++, data);
      saved.batches = (data?.batches ?? []).map((batch, index) => ({ ...batch, id: 'qa-batch-' + (index + 1), version: 1,
        expiry: batch.expiry ?? { precision: 'unknown', value: null }, expiryState: { state: 'unknown', effectiveDate: null, daysRemaining: null },
        quantity: batch.quantity ?? null, unit: batch.unit ?? 'box', confirmedUnitsPerPackage: null, storageLocation: null }));
      db.medicines.push(saved);
      if (data?.idempotencyKey) db.creates.set(data.idempotencyKey, saved);
      return ok(saved, 201);
    }
    const id = path.split('/')[4];
    const item = db.medicines.find(entry => entry.id === id);
    if (!item) return fail('NOT_FOUND', 404);
    if (path.endsWith('/dosage-notes')) return ok({ notes: [] });
    if (path.endsWith('/cover-photo')) { item.coverPhotoId = data.photoId; return ok({ coverPhotoId: item.coverPhotoId }); }
    if (path.endsWith('/leaflet-photos')) {
      if (method === 'GET') return ok({ photos: db.photos.filter(photo => photo.medicineId === id) });
      if (data?.imageBase64 !== PNG) return fail('SYNTHETIC_IMAGE_REQUIRED', 400);
      const photo = { id: 'qa-photo-' + nextPhoto++, medicineId: id, mimeType: 'image/png', purpose: data.purpose ?? 'leaflet', source: 'QA synthetic', createdAt: time, byteSize: 68 };
      db.photos.push(photo); return ok({ photo }, 201);
    }
    if (path.includes('/leaflet-photos/')) {
      const segments = path.split('/');
      const photoId = segments[segments.length - 1];
      if (!db.photos.some(photo => photo.id === photoId && photo.medicineId === id)) return fail('NOT_FOUND', 404);
      if (method === 'GET') return ok({ syntheticBase64: PNG });
      db.photos = db.photos.filter(photo => photo.id !== photoId); return ok(null, 204);
    }
    if (method === 'PUT') {
      if (data.version !== item.version) return fail('VERSION_CONFLICT', 409);
      Object.assign(item, clone(data), { id, version: item.version + 1 });
    }
    return ok(item);
  }
  return Object.freeze({ dispatch, actor: () => actor, setActor(value) {
    if (!['A', 'B'].includes(value)) throw new Error('Only synthetic actors A/B exist');
    actor = value;
  } });
}
module.exports = { ORIGIN, PNG, validateRequest, createMock, routes: routes.map(([method, route]) => ({ method, route: route.source })) };
