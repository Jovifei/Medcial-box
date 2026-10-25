import assert from "node:assert/strict";
import test from "node:test";
import { harness, select } from "./photo-queue-test-harness.mjs";

function openNew(h) {
  const page = h.page();
  page.data.name = "";
  page.onLoad({});
  return page;
}

test("cold new entry and re-entry remain blank while prior failed photos stay available only for import", async () => {
  const h = harness();
  const old = h.draft("old-failed", "failed");
  h.seed([old]);
  const before = h.read();
  const page = openNew(h);
  await page.checkEntrySession();
  page.onShow();
  assert.equal(page.data.name, "");
  assert.equal(page.data.activePhotoDraftId, "");
  assert.deepEqual(page.data.photoDrafts, []);
  assert.equal(page.data.draftAvailable, true);
  assert.deepEqual(h.read(), before);
  page.onUnload();
  const next = openNew(h);
  await next.checkEntrySession();
  assert.equal(next.data.name, "");
  assert.deepEqual(next.data.photoDrafts, []);
  await next.onRestoreDraft();
  assert.equal(next.data.photoDrafts.length, 1);
  select(next, old.id);
  assert.equal(next.data.activePhotoDraftId, old.id);
  assert.equal(next.data.name, old.fields.name);
});

test("new capture creates its own photo draft without adopting or deleting an old failed entry", async () => {
  const h = harness();
  const old = h.draft("old-failed", "failed");
  h.seed([old]);
  const page = openNew(h);
  await page.checkEntrySession();
  await page.onRecognizePhoto("camera");
  assert.equal(h.calls.recognize, 1);
  assert.notEqual(page.data.activePhotoDraftId, old.id);
  assert.equal(page.data.photoDrafts.length, 1);
  assert.deepEqual(h.read().find(draft => draft.id === old.id), old);
  assert.equal(h.read().length, 2);
  assert.equal(h.calls.unlink, 0);
});

test("an old new-entry page cannot import another household after a switch", async () => {
  const h = harness();
  h.seed([h.draft("old-failed", "failed")]);
  const page = openNew(h);
  await page.checkEntrySession();
  h.scope.writeSessionScope({ userId: "other-user", familyId: "other-family" });
  page.onShow();
  await page.onRestoreDraft();
  assert.equal(page.data.name, "");
  assert.deepEqual(page.data.photoDrafts, []);
  assert.equal(h.read().length, 1);
});

test("the tenth unfinished draft is accepted but an eleventh keeps all prior queue and photo bytes unchanged", async () => {
  let picks = 0;
  const h = harness({ choose: () => { picks++; return { tempFiles: [{ tempFilePath: "/synthetic.jpg", size: 4 }] }; } });
  h.seed(Array.from({ length: 9 }, (_, index) => h.draft(`old-${index}`, "failed")));
  const tenth = openNew(h);
  await tenth.checkEntrySession();
  await tenth.onRecognizePhoto("camera");
  assert.equal(h.read().length, 10);
  assert.equal(picks, 1);
  const before = h.read();
  const files = [...h.files.entries()];
  const writes = h.calls.write;
  const eleventh = openNew(h);
  await eleventh.checkEntrySession();
  await eleventh.onRecognizePhoto("camera");
  assert.equal(picks, 1);
  assert.equal(h.calls.write, writes);
  assert.equal(h.calls.unlink, 0);
  assert.deepEqual(h.read(), before);
  assert.deepEqual([...h.files.entries()], files);
  assert.deepEqual(eleventh.data.photoDrafts, []);
  assert.match(eleventh.data.recognitionHint, /10份.*导入草稿.*原照片和文字仍保留/);
});

test("an isolated new entry reuses inventory and photo receipt identities after both acknowledgements are lost", async () => {
  let page;
  let creates = 0;
  let uploads = 0;
  const inventory = new Map();
  const photos = new Set();
  const h = harness({
    create: result => {
      const key = page.data.attemptedPayload.idempotencyKey;
      if (!inventory.has(key)) inventory.set(key, result);
      if (++creates === 1) throw Error("Synthetic lost create ACK");
      return inventory.get(key);
    },
    upload: result => {
      const draft = h.read().find(entry => entry.id === page.data.activePhotoDraftId);
      photos.add(draft.photos[0].uploadIntentKey);
      if (++uploads === 1) throw Error("Synthetic lost upload ACK");
      return result;
    },
  });
  const old = h.draft("old-failed", "failed");
  h.seed([old]);
  page = openNew(h);
  await page.checkEntrySession();
  await page.onRecognizePhoto("camera");
  page.onFieldInput({ currentTarget: { dataset: { field: "name" } }, detail: { value: "New synthetic medicine" } });
  await page.onSubmit();
  assert.equal(inventory.size, 1);
  assert.equal(uploads, 0);
  await page.onSubmit();
  assert.equal(creates, 2);
  assert.equal(photos.size, 1);
  await page.onSubmit();
  assert.equal(creates, 2);
  assert.equal(uploads, 2);
  assert.equal(inventory.size, 1);
  assert.equal(photos.size, 1);
  // Jovi 2026-10-25：保存成功后未完成的旧草稿一并退役，不再触发导入提醒。
  const retired = h.read().find(entry => entry.id === old.id);
  assert.equal(retired === undefined || retired.status === "cleanup_pending", true,
    "old failed draft must be retired once the save fully succeeds");
});
