import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, makePageContext, makeSessionScopeModule } from "./runtime.mjs";
import { ownedPhotoFixture } from "./support/owned-photo-fixture.mjs";

function fixture({ loseAck = false, switchDuringUpload = false, failRetake = false } = {}) {
  const scope = makeSessionScopeModule({ userId: "cover-user", familyId: "cover-family" });
  const native = ownedPhotoFixture();
  const key = scope.scopedStorageKey("medicine-photo-drafts");
  const calls = { recognition: 0, create: 0, uploads: [], covers: [] };
  const remote = new Map();
  let lost = false;
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
    setTimeoutFn: () => {},
    modules: {
      "session-scope": scope,
      "../../services/auth": { ensureLoggedIn: async () => {} },
      "../../services/api": { ApiError: class ApiError extends Error {}, api: {
        recognizeMedicine: async () => {
          if (++calls.recognition === 1 || failRetake) throw new Error("synthetic recognition outage");
          return { draft: {}, warnings: [] };
        },
        createMedicine: async () => { calls.create++; return { id: "cover-medicine", version: 1, batches: [{ id: "cover-batch" }] }; },
        getMedicine: async () => ({ id: "cover-medicine", version: 1, batches: [{ id: "cover-batch" }] }),
        getRecognitionEvidence: async () => ({ evidence: null, capabilities: { coverPhotoVersionGuard: true } }),
        uploadLeafletPhoto: async (...args) => {
          calls.uploads.push(args);
          const intent = args[5];
          if (!remote.has(intent)) remote.set(intent, `uploaded-${remote.size + 1}`);
          if (switchDuringUpload) scope.writeSessionScope({ userId: "cover-user", familyId: "other-family" });
          if (loseAck && !lost) {
            lost = true;
            throw new Error("synthetic upload response lost after remote storage");
          }
          return { photo: { id: remote.get(intent) } };
        },
        setMedicineCover: async (...args) => { calls.covers.push(args); return { coverPhotoId: args[1], version: args[2] + 1 }; },
      } },
    },
    wx: {
      ...native,
      chooseMedia: async () => ({ tempFiles: [{ tempFilePath: "/synthetic-retake.jpg", size: 4 }] }),
    },
  });
  const page = makePageContext(definition);
  page.onLoad({});
  page.data.name = "Synthetic medicine";
  return { page, key, native, scope, calls, remote };
}

async function retake(h) {
  await h.page.onRecognizePhoto("camera");
  const first = h.page.data.photoDrafts[0];
  assert.equal(first.status, "failed");
  const oldPath = first.photos[0].path;
  h.page.setData({ activePhotoDraftId: "" });
  await h.page.onRecognizePhoto("camera");
  const draft = h.native.getStorageSync(h.key)[0];
  assert.equal(draft.photos.length, 2);
  assert.equal(draft.photos[0].path, oldPath);
  assert.equal(draft.thumbnail, draft.photos[1].path);
  return draft;
}

test("retake uploads both retained photos and uses the latest front only with cover enabled", async () => {
  for (const enabled of [true, false]) {
    const h = fixture();
    const before = await retake(h);
    h.page.onCoverChoice({ detail: { value: enabled } });
    await h.page.onSubmit();
    assert.equal(h.calls.create, 1);
    assert.equal(h.calls.uploads.length, 2);
    assert.deepEqual(h.calls.uploads.map(args => args[4].purpose), ["box_front", "box_front"]);
    assert.deepEqual(h.calls.covers, enabled ? [["cover-medicine", "uploaded-2", 1]] : []);
    assert.equal(h.remote.size, before.photos.length, "both photos remain in the synthetic server");
  }
});

test("lost upload ACK retries the same intent and still selects the latest retained front", async () => {
  const h = fixture({ loseAck: true });
  await retake(h);
  h.page.onCoverChoice({ detail: { value: true } });
  await h.page.onSubmit();
  assert.equal(h.page.data.photoDrafts[0].status, "photo_pending");
  assert.equal(h.calls.covers.length, 0);
  await h.page.onSubmit();
  assert.equal(h.calls.create, 1);
  assert.equal(h.calls.uploads.length, 3);
  assert.equal(h.calls.uploads[0][5], h.calls.uploads[1][5]);
  assert.equal(h.remote.size, 2);
  assert.deepEqual(h.calls.covers, [["cover-medicine", "uploaded-2", 1]]);
});

test("switching family during upload cannot set a cover or copy receipts to the new family", async () => {
  const h = fixture({ switchDuringUpload: true });
  const before = await retake(h);
  h.page.onCoverChoice({ detail: { value: true } });
  await h.page.onSubmit();
  assert.equal(h.calls.uploads.length, 1);
  assert.deepEqual(h.calls.covers, []);
  const original = h.native.getStorageSync(h.key)[0];
  assert.deepEqual(original.photos.map(photo => photo.path), before.photos.map(photo => photo.path));
  assert.equal(original.photos.some(photo => photo.uploadedId), false);
  assert.equal(h.native.getStorageSync(h.scope.scopedStorageKey("medicine-photo-drafts")), undefined);
});

test("failed retake preserves the previous thumbnail and retains both originals", async () => {
  const h = fixture({ failRetake: true });
  await h.page.onRecognizePhoto("camera");
  const original = h.native.getStorageSync(h.key)[0];
  h.page.setData({ activePhotoDraftId: "" });
  await h.page.onRecognizePhoto("camera");
  const retained = h.native.getStorageSync(h.key)[0];
  assert.equal(retained.status, "failed");
  assert.equal(retained.thumbnail, original.thumbnail);
  assert.equal(retained.photos.length, 2);
  assert.equal(retained.photos[0].path, original.photos[0].path);
});
