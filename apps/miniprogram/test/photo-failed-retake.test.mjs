import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, makePageContext, makeSessionScopeModule } from "./runtime.mjs";
import { ownedPhotoFixture } from "./support/owned-photo-fixture.mjs";

function setup() {
  const scope = makeSessionScopeModule({ userId: "synthetic-user", familyId: "synthetic-family" });
  const native = ownedPhotoFixture();
  const calls = { choose: 0, recognize: 0 };
  let afterChoose = () => {};
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
    modules: {
      "session-scope": scope,
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/api": { ApiError: class ApiError extends Error {}, api: {
        recognizeMedicine: async () => {
          if (++calls.recognize === 1) throw new Error("Synthetic recognition outage");
          return { draft: { specification: "合成规格" }, warnings: [], requiresConfirmation: true };
        },
      } },
    },
    wx: { ...native, chooseMedia: async () => {
      calls.choose++;
      afterChoose();
      return { tempFiles: [{ tempFilePath: "/synthetic-retake.jpg", size: 4 }] };
    } },
  });
  const page = makePageContext(definition);
  page.onLoad({});
  page.data.name = "合成药品";
  return { page, scope, calls, native, setAfterChoose(fn) { afterChoose = fn; } };
}

async function failedWithoutSelection(h) {
  await h.page.onRecognizePhoto("camera");
  const failed = h.page.data.photoDrafts[0];
  assert.equal(failed.status, "failed");
  h.page.setData({ activePhotoDraftId: "" });
  return { id: failed.id, oldPath: failed.photos[0].path };
}

test("same-family failed draft can be retaken without an active selection", async () => {
  const h = setup();
  const original = await failedWithoutSelection(h);
  await h.page.onRecognizePhoto("camera");
  assert.equal(h.calls.recognize, 2);
  assert.equal(h.page.data.photoDrafts.length, 1);
  const draft = h.page.data.photoDrafts[0];
  assert.equal(draft.id, original.id);
  assert.equal(draft.status, "review");
  assert.equal(draft.photos.length, 2);
  assert.equal(draft.photos[0].path, original.oldPath);
  assert.notEqual(draft.photos[1].path, original.oldPath);
  assert.equal(draft.photos[1].ownedLocal.state, "ready");
  assert.equal(h.page.data.specification, "合成规格");
});

test("failed draft retake refuses a different family before capture", async () => {
  const h = setup();
  await failedWithoutSelection(h);
  const key = h.scope.scopedStorageKey("medicine-photo-drafts");
  const before = JSON.stringify(h.native.getStorageSync(key));
  h.scope.writeSessionScope({ userId: "synthetic-user", familyId: "other-family" });
  await h.page.onRecognizePhoto("camera");
  assert.equal(h.calls.choose, 1);
  assert.equal(h.calls.recognize, 1);
  assert.equal(JSON.stringify(h.native.getStorageSync(key)), before);
  assert.equal(h.native.getStorageSync(h.scope.scopedStorageKey("medicine-photo-drafts")), undefined);
});

test("family change while choosing a retake preserves the original failed receipt", async () => {
  const h = setup();
  await failedWithoutSelection(h);
  const key = h.scope.scopedStorageKey("medicine-photo-drafts");
  const before = JSON.stringify(h.native.getStorageSync(key));
  h.setAfterChoose(() => h.scope.writeSessionScope({ userId: "synthetic-user", familyId: "other-family" }));
  await h.page.onRecognizePhoto("camera");
  assert.equal(h.calls.recognize, 1);
  assert.equal(JSON.stringify(h.native.getStorageSync(key)), before);
});
