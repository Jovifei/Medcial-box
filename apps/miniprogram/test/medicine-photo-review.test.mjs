import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { harness } from "./photo-queue-test-harness.mjs";
import { loadPage, makePageContext } from "./runtime.mjs";

const capture = (page, purpose = "box_front") => page.onRecognizePhoto({
  currentTarget: { dataset: { source: "camera", purpose } },
});

test("each captured photo retains its own ordered recognition result and source", async () => {
  let calls = 0;
  const h = harness({ recognize: () => ({
    draft: ++calls === 1
      ? { name: "合成药", specification: "10片", purposeTags: ["pain"] }
      : { name: "合成药", leaflet: { text: "说明书原文", purposeSummary: "合成用途", packageUsageSummary: "合成用法", contraindicationsSummary: null, precautionsSummary: null } },
    warnings: [], requiresConfirmation: true,
  }) });
  h.a.data.name = "";
  await capture(h.a);
  await capture(h.a, "leaflet");
  const [draft] = h.read();
  assert.equal(draft.photos.length, 2);
  assert.deepEqual(draft.photos.map(photo => photo.sequence), [1, 2]);
  assert.notEqual(draft.photos[0].clientPhotoId, draft.photos[1].clientPhotoId);
  assert.equal(draft.photos[0].review.fields.specification, "10片");
  assert.equal(draft.photos[1].review.fields.leafletText, "说明书原文");
  assert.equal(draft.photos[1].review.fields.packageUsageSummary, "合成用法");
  assert.equal(h.a.data.name, "合成药");
  assert.deepEqual([...h.a.data.fieldSources.name.photoIds], draft.photos.map(photo => photo.clientPhotoId));
  h.a.onSelectReviewPhoto({ currentTarget: { dataset: { photoId: draft.photos[1].clientPhotoId } } });
  assert.equal(h.a.data.photoReviewExpanded, true);
  assert.equal(h.a.data.selectedReviewPhoto.sequence, 2);
  assert.ok(h.a.data.selectedReviewPhoto.fields.some(field => field.value === "合成用法"));
  assert.equal(h.calls.create, 0, "拍照和候选核对不能自动入库");
});

test("conflicting identity values require an explicit choice before saving", async () => {
  let calls = 0;
  const h = harness({ recognize: () => ({
    draft: { name: ++calls === 1 ? "合成药甲" : "合成药乙" }, warnings: [], requiresConfirmation: true,
  }) });
  h.a.data.name = "";
  await capture(h.a);
  await capture(h.a, "leaflet");
  const conflict = h.a.data.reviewConflicts.find(item => item.field === "name");
  assert.ok(conflict, "两个药名必须作为冲突展示");
  assert.deepEqual(Array.from(conflict.choices, item => item.value), ["合成药甲", "合成药乙"]);
  await h.a.onSubmit();
  assert.equal(h.calls.create, 0, "未选择时不能猜测药品身份并保存");
  h.a.onChooseReviewConflict({ currentTarget: { dataset: { field: "name", index: "1" } } });
  assert.equal(h.a.data.name, "合成药乙");
  assert.equal(h.a.data.reviewConflicts.some(item => item.field === "name"), false);
  assert.equal(h.a.data.fieldSources.name.source, "recognized");
  assert.equal(h.a.data.fieldSources.name.reviewed, true);
  assert.equal(h.calls.create, 0, "选择候选仍需用户主动保存");
});

test("manually entered values remain authoritative when other photos disagree", async () => {
  let calls = 0;
  const h = harness({ recognize: () => ({ draft: { name: ++calls === 1 ? "候选甲" : "候选乙" }, warnings: [], requiresConfirmation: true }) });
  h.a.onFieldInput({ currentTarget: { dataset: { field: "name" } }, detail: { value: "家人填写的名称" } });
  await capture(h.a);
  await capture(h.a, "leaflet");
  assert.equal(h.a.data.name, "家人填写的名称");
  assert.equal(h.a.data.reviewConflicts.some(item => item.field === "name"), false);
  assert.equal(h.a.data.fieldSources.name.source, "manual");
  assert.equal(h.calls.create, 0);
});

test("a later conflicting photo requires review without replacing an earlier selected value", async () => {
  let calls = 0;
  const h = harness({ recognize: () => ({ draft: { name: ["合成甲", "合成乙", "合成丙"][calls++] }, warnings: [], requiresConfirmation: true }) });
  h.a.data.name = "";
  await capture(h.a);
  await capture(h.a, "leaflet");
  h.a.onChooseReviewConflict({ currentTarget: { dataset: { field: "name", index: "1" } } });
  assert.equal(h.a.data.name, "合成乙");
  await capture(h.a, "leaflet");
  assert.equal(h.a.data.name, "合成乙", "新的识别不能覆盖已选内容");
  assert.ok(h.a.data.reviewConflicts.some(item => item.field === "name"));
  await h.a.onSubmit();
  assert.equal(h.calls.create, 0, "新冲突需要用户再次核对");
});

test("scan or album choice dispatches the selected source without changing a stale session", () => {
  let choice = 0;
  let identity = { token: "old", generation: 1 };
  let sheet;
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
    modules: {
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/api": { api: {}, ApiError: class extends Error {},
        captureSessionIdentity: () => ({ ...identity }),
        isCurrentSession: snapshot => snapshot.token === identity.token && snapshot.generation === identity.generation },
    },
    wx: { showActionSheet: options => { sheet = options; } },
  });
  const page = makePageContext(definition);
  const calls = [];
  page.onScanCode = () => { calls.push("scan"); };
  page.onRecognizePhoto = event => { calls.push(event.currentTarget.dataset.purpose); };
  page.onChooseCaptureSource();
  sheet.success({ tapIndex: choice++ });
  page.onChooseCaptureSource();
  sheet.success({ tapIndex: choice++ });
  page.onChooseCaptureSource();
  identity = { token: "new", generation: 2 };
  sheet.success({ tapIndex: choice });
  assert.deepEqual(calls, ["scan", "box_front"]);
});

test("removing one photo preserves other numbers and an explicitly accepted field", async () => {
  let calls = 0;
  const results = [
    { name: "合成药" }, { manufacturer: "合成厂家" }, { expiryValue: "2027-08", expiryPrecision: "month" },
    { leaflet: { text: "第四张原文", purposeSummary: null, packageUsageSummary: null, contraindicationsSummary: null, precautionsSummary: null } },
  ];
  const h = harness({ recognize: () => ({ draft: results[calls++], warnings: [], requiresConfirmation: true }) });
  h.a.data.name = "";
  await capture(h.a);
  await capture(h.a, "leaflet");
  await capture(h.a, "expiry");
  const second = h.read()[0].photos[1];
  h.a.onSelectReviewPhoto({ currentTarget: { dataset: { photoId: second.clientPhotoId } } });
  h.a.onUsePhotoField({ currentTarget: { dataset: { photoId: second.clientPhotoId, field: "manufacturer" } } });
  assert.equal(h.a.data.fieldSources.manufacturer.reviewed, true);
  h.a.onRemoveReviewPhoto({ currentTarget: { dataset: { photoId: second.clientPhotoId } } });
  assert.deepEqual(Array.from(h.a.data.photoReviewItems, photo => photo.sequence), [1, 3]);
  assert.equal(h.a.data.manufacturer, "合成厂家");
  assert.equal(h.a.data.fieldSources.manufacturer.source, "removed");
  assert.equal(h.calls.unlink, 0, "本机原件由现有归属与清理流程处理");
  await capture(h.a, "leaflet");
  assert.deepEqual(Array.from(h.a.data.photoReviewItems, photo => photo.sequence), [1, 3, 4]);
});

test("removing a photo clears its unconfirmed suggestion but retains the durable cleanup receipt", async () => {
  const h = harness({ recognize: () => ({ draft: { name: "未核对候选" }, warnings: [], requiresConfirmation: true }) });
  h.a.data.name = "";
  await capture(h.a);
  const photo = h.read()[0].photos[0];
  assert.equal(h.a.data.name, "未核对候选");
  h.a.onRemoveReviewPhoto({ currentTarget: { dataset: { photoId: photo.clientPhotoId } } });
  assert.equal(h.a.data.name, "");
  assert.equal(h.a.data.photoReviewItems.length, 0);
  assert.equal(h.read()[0].photos[0].removed, true);
  assert.equal(h.calls.unlink, 0);
});

test("a removed local photo is not uploaded while remaining photos are saved", async () => {
  let calls = 0;
  const h = harness({ recognize: () => ({ draft: { name: "合成药", brand: ++calls === 1 ? "" : "第二图品牌" }, warnings: [], requiresConfirmation: true }) });
  h.a.data.name = "";
  await capture(h.a);
  await capture(h.a, "leaflet");
  const second = h.read()[0].photos[1];
  h.a.onRemoveReviewPhoto({ currentTarget: { dataset: { photoId: second.clientPhotoId } } });
  await h.a.onSubmit();
  assert.equal(h.calls.create, 1);
  assert.equal(h.calls.upload, 1, "只上传仍属于本次录入的照片");
});

test("a delayed remove confirmation cannot change a different household's draft", async () => {
  let modal;
  const h = harness({
    recognize: () => ({ draft: { name: "合成药" }, warnings: [], requiresConfirmation: true }),
    modal: options => { modal = options; },
  });
  h.a.data.name = "";
  await capture(h.a);
  const before = h.read();
  h.a.onRemoveReviewPhoto({ currentTarget: { dataset: { photoId: before[0].photos[0].clientPhotoId } } });
  h.scope.writeSessionScope({ userId: "other-user", familyId: "other-family" });
  modal.success({ confirm: true });
  assert.deepEqual(h.read(), before);
  assert.equal(h.calls.unlink, 0);
});

test("storage failure while removing a photo leaves the visible and durable draft intact", async () => {
  let fail = false;
  const h = harness({
    recognize: () => ({ draft: { name: "合成药" }, warnings: [], requiresConfirmation: true }),
    store: () => { if (fail) throw new Error("synthetic storage failure"); },
  });
  h.a.data.name = "";
  await capture(h.a);
  const photo = h.read()[0].photos[0];
  fail = true;
  h.a.onRemoveReviewPhoto({ currentTarget: { dataset: { photoId: photo.clientPhotoId } } });
  assert.equal(h.a.data.photoReviewItems.length, 1);
  assert.equal(h.a.data.name, "合成药");
  assert.notEqual(h.read()[0].photos[0].removed, true);
  assert.equal(h.calls.unlink, 0);
});

test("an already uploaded photo is not silently discarded from a pending draft", async () => {
  const h = harness({ recognize: () => ({ draft: { name: "合成药" }, warnings: [], requiresConfirmation: true }) });
  h.a.data.name = "";
  await capture(h.a);
  const queue = h.read();
  queue[0].medicineId = "synthetic-created";
  queue[0].photos[0].uploadedId = "already-uploaded";
  h.storage.set(h.key, queue);
  h.a.loadPhotoDrafts();
  h.a.onRemoveReviewPhoto({ currentTarget: { dataset: { photoId: queue[0].photos[0].clientPhotoId } } });
  assert.notEqual(h.read()[0].photos[0].removed, true, "已上传照片应在详情中明确移除");
  assert.equal(h.a.data.photoReviewItems.length, 1);
});

test("expiry photos for different batches fill the intended batch without a false conflict", async () => {
  let call = 0;
  const h = harness({ recognize: () => ({
    draft: { expiryValue: ++call === 1 ? "2027-08" : "2028-09", expiryPrecision: "month" }, warnings: [], requiresConfirmation: true,
  }) });
  h.a.onAddBatch();
  await h.a.onRecognizePhoto({ currentTarget: { dataset: { source: "camera", purpose: "expiry", batchIndex: "0" } } });
  await h.a.onRecognizePhoto({ currentTarget: { dataset: { source: "camera", purpose: "expiry", batchIndex: "1" } } });
  assert.equal(h.a.data.batches[0].expiryValue, "2027-08");
  assert.equal(h.a.data.batches[1].expiryValue, "2028-09");
  assert.equal(h.a.data.reviewConflicts.some(item => item.field === "expiryValue"), false);
  assert.notEqual(h.read()[0].photos[0].batchKey, h.read()[0].photos[1].batchKey);
});

test("removing a different batch never reassigns an expiry photo to the wrong batch", async () => {
  const uploads = [];
  const h = harness({
    recognize: () => ({ draft: { expiryValue: "2028-09", expiryPrecision: "month" }, warnings: [], requiresConfirmation: true }),
    create: (result, payload) => ({ ...result, batches: payload.batches.map((_, index) => ({ id: `synthetic-batch-${index}`, version: 1 })) }),
    upload: (result, _medicine, _base64, _mime, _source, association) => { uploads.push(association); return result; },
  });
  h.a.onAddBatch();
  h.a.onAddBatch();
  await h.a.onRecognizePhoto({ currentTarget: { dataset: { source: "camera", purpose: "expiry", batchIndex: "2" } } });
  h.a.onRemoveBatch({ currentTarget: { dataset: { index: "0" } } });
  await h.a.onSubmit();
  assert.equal(h.calls.create, 1);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].batchId, "synthetic-batch-1");
});

test("removing the photographed batch blocks saving instead of guessing another association", async () => {
  const h = harness({ recognize: () => ({ draft: { expiryValue: "2028-09", expiryPrecision: "month" }, warnings: [], requiresConfirmation: true }) });
  h.a.onAddBatch();
  await h.a.onRecognizePhoto({ currentTarget: { dataset: { source: "camera", purpose: "expiry", batchIndex: "1" } } });
  h.a.onRemoveBatch({ currentTarget: { dataset: { index: "1" } } });
  await h.a.onSubmit();
  assert.equal(h.calls.create, 0);
  assert.equal(h.calls.upload, 0);
  assert.match(h.a.data.recognitionHint, /所属库存已移除/);
});

test("unknown date precision cannot be converted into a day during candidate selection", async () => {
  const h = harness({ recognize: () => ({ draft: { expiryValue: "2028-09", expiryPrecision: "unknown" }, warnings: [], requiresConfirmation: true }) });
  await h.a.onRecognizePhoto({ currentTarget: { dataset: { source: "camera", purpose: "expiry", batchIndex: "0" } } });
  const photo = h.read()[0].photos[0];
  h.a.onUsePhotoField({ currentTarget: { dataset: { field: "expiryValue", photoId: photo.clientPhotoId } } });
  assert.equal(h.a.data.batches[0].expiryValue, "");
  assert.equal(h.a.data.batches[0].precisionIndex, 2);
});

test("an old API never receives an unguarded cover update", async () => {
  const h = harness({
    create: result => ({ ...result, version: 1 }),
    evidence: () => ({ evidence: null }),
  });
  await capture(h.a);
  h.a.onCoverChoice({ detail: { value: true } });
  await h.a.onSubmit();
  assert.equal(h.calls.create, 1);
  assert.equal(h.calls.upload, 1);
  assert.equal(h.calls.cover, 0);
  assert.equal(h.read()[0].status, "photo_pending");
  assert.equal(h.read()[0].coverIntent.expectedVersion, 1);
});

test("the cover choice survives reopening the owning photo draft", async () => {
  const h = harness();
  await capture(h.a);
  h.a.onCoverChoice({ detail: { value: true } });
  const saved = h.read()[0];
  assert.equal(saved.fields.usePhotoAsCover, true);
  const restored = h.page();
  restored.loadPhotoDrafts();
  restored.onSelectPhotoDraft({ currentTarget: { dataset: { id: saved.id } } });
  assert.equal(restored.data.usePhotoAsCover, true);
});

test("switching family immediately hides the entry and preserves its original draft", async () => {
  const h = harness({ recognize: () => ({ draft: { name: "合成家庭私有药" }, warnings: [], requiresConfirmation: true }) });
  h.a.onLoad({}); await h.a.checkEntrySession(); h.a.data.name = "";
  await capture(h.a); h.a.onHide();
  const old = JSON.stringify(h.read());
  h.scope.writeSessionScope({ userId: "independent-synthetic-user", familyId: "other-family" });
  assert.equal(h.a.data.scopeInvalidated, true);
  const markup = fs.readFileSync(new URL('../pages/medicine-edit/medicine-edit.wxml', import.meta.url), 'utf8');
  assert.match(markup, /<block wx:if="\{\{!scopeInvalidated\}\}">[\s\S]*class="page"[\s\S]*class="save-bar"[\s\S]*<\/block>/);
  assert.equal(JSON.stringify(h.read()), old);
  h.a.onShow();
  assert.equal(h.a.photoScopeKey, h.key, "旧录入页不能改绑新家庭");
  h.a.onUnload();
});

test("same-family session replacement blocks an old photo preview immediately", async () => {
  let generation = 1;
  let previews = 0;
  const h = harness({ identity: { captureSessionIdentity: () => ({ token: "t", generation }),
    isCurrentSession: value => value.generation === generation }, preview: () => { previews++; } });
  h.a.onLoad({}); await h.a.checkEntrySession();
  await capture(h.a);
  generation++; h.scope.notifySessionChange();
  h.a.onPreviewReviewPhoto();
  assert.equal(h.a.data.scopeInvalidated, true);
  assert.equal(previews, 0);
  h.a.onUnload();
});

test("a session transition saves a manual-only form to its original scope before hiding it", async () => {
  let generation = 1;
  const h = harness({ identity: { captureSessionIdentity: () => ({ token: "t", generation }),
    isCurrentSession: value => value.generation === generation } });
  h.a.onLoad({}); await h.a.checkEntrySession();
  h.a.onFieldInput({ currentTarget: { dataset: { field: "name" } }, detail: { value: "原家庭手工药名" } });
  generation++; h.scope.notifySessionChange();
  assert.equal(h.a.data.scopeInvalidated, true);
  assert.equal(h.storage.get(h.a.draftStorageKey).fields.name, "原家庭手工药名");
  h.scope.writeSessionScope({ userId: "independent-synthetic-user", familyId: "other-family" });
  const otherKey = h.scope.scopedStorageKey("medicine-edit-draft");
  assert.equal(h.storage.has(otherKey), false);
  h.a.onUnload();
});

test("a guarded cover with a lost acknowledgement is not applied twice", async () => {
  let backendVersion = 1;
  let backendCover = null;
  const h = harness({
    create: result => ({ ...result, version: backendVersion }),
    get: result => ({ ...result, version: backendVersion, coverPhotoId: backendCover }),
    evidence: () => ({ evidence: null, capabilities: { coverPhotoVersionGuard: true } }),
    cover: (_medicine, photoId, version) => {
      assert.equal(version, 1);
      backendVersion += 1;
      backendCover = photoId;
      throw new Error("response lost");
    },
  });
  await capture(h.a);
  h.a.onCoverChoice({ detail: { value: true } });
  await h.a.onSubmit();
  assert.equal(h.calls.cover, 1);
  assert.equal(h.read()[0].status, "photo_pending");
  await h.a.onSubmit();
  assert.equal(h.calls.create, 1);
  assert.equal(h.calls.cover, 1);
});

test("saving two recognized photos persists ordered evidence with the selected source and batch", async () => {
  const photos = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const batchId = "33333333-3333-4333-8333-333333333333";
  let captures = 0;
  let uploaded = 0;
  let posted;
  const h = harness({
    recognize: () => ({ draft: ++captures === 1 ? { name: "合成药" } : { expiryValue: "2028-09", expiryPrecision: "month" }, warnings: [], requiresConfirmation: true }),
    create: result => ({ ...result, version: 1, batches: [{ id: batchId, version: 1 }] }),
    upload: result => ({ ...result, photo: { id: photos[uploaded++] } }),
    evidence: () => ({ evidence: null, capabilities: { coverPhotoVersionGuard: true } }),
    saveEvidence: (_id, body) => {
      posted = body;
      return { evidence: { ...body, revision: body.revision + 1, currentMedicineVersion: body.medicineVersion, stale: false,
        photos: body.photos.map(photo => ({ ...photo, available: true })),
        ...(body.batchSources ? { batchSources: body.batchSources.map(source => ({ ...source, batchAvailable: true })) } : {}) } };
    },
  });
  h.a.data.name = "";
  await capture(h.a);
  await h.a.onRecognizePhoto({ currentTarget: { dataset: { source: "camera", purpose: "expiry", batchIndex: "0" } } });
  await h.a.onSubmit();
  assert.equal(h.calls.create, 1);
  assert.equal(h.calls.upload, 2);
  assert.equal(h.calls.evidenceSave, 1);
  assert.deepEqual(Array.from(posted.photos, photo => photo.sequence), [1, 2]);
  assert.deepEqual(Array.from(posted.fieldSources.name.photoIds), [photos[0]]);
  assert.equal(posted.fieldSources.name.reviewed, false);
  assert.equal(posted.batchSources[0].batchId, batchId);
  assert.deepEqual(Array.from(posted.batchSources[0].photoIds), [photos[1]]);
  assert.equal(h.read().length, 0);
});

test("new medicine keeps exact recognition intent for retry when the API is old", async () => {
  const h = harness({
    recognize: () => ({ draft: { name: "合成药" }, warnings: [], requiresConfirmation: true }),
    create: result => ({ ...result, version: 1, batches: [{ id: "33333333-3333-4333-8333-333333333333", version: 1 }] }),
    upload: result => ({ ...result, photo: { id: "11111111-1111-4111-8111-111111111111" } }),
    evidence: () => { throw { statusCode: 404 }; },
  });
  h.a.data.name = "";
  await capture(h.a);
  await h.a.onSubmit();
  assert.equal(h.calls.create, 1);
  assert.equal(h.calls.upload, 1);
  assert.equal(h.calls.evidenceSave, 0);
  const pending = [...h.storage.values()].find(value => value?.payload?.photos);
  assert.ok(pending, "旧服务上必须保留完整待同步来源");
  assert.equal(pending.payload.photos[0].fields.name, "合成药");
  assert.equal(pending.payload.revision, 0);
});
