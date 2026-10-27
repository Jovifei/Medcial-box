import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./photo-queue-test-harness.mjs";
import { loadApi } from "./runtime.mjs";

for (const mode of ["family", "user", "unload", "session", "session ABA", "cancel", "confirm"]) {
  test(`modal draft restore respects ${mode} and retains stale form and queue`, async () => {
    let modal;
    const transport = loadApi({ wx: { getStorageSync: () => "", setStorageSync() {}, removeStorageSync() {} } });
    transport.storeToken("synthetic-A");
    const h = harness({ modal: options => { modal = options; }, identity: {
      captureSessionIdentity: transport.captureSessionIdentity,
      isCurrentSession: transport.isCurrentSession,
    } });
    h.seed([h.draft("synthetic-old", "failed")]);
    const page = h.page(); page.onLoad({}); await page.checkEntrySession();
    page.pendingStoredDraft = { ...h.draft("synthetic-old").fields, name: "Synthetic old owner draft" };
    page.setData({ name: "Synthetic current form", isDirty: true });
    const pending = page.onRestoreDraft(); assert.ok(modal);
    if (mode === "unload") page.onUnload();
    else if (mode === "family" || mode === "user") h.scope.writeSessionScope({ userId: mode === "user" ? "other-user" : "independent-synthetic-user", familyId: "other-family" });
    else if (mode.startsWith("session")) {
      transport.storeToken("synthetic-B");
      if (mode === "session ABA") transport.storeToken("synthetic-A");
    }
    const before = structuredClone(page.data);
    const storedBefore = JSON.stringify([...h.storage.entries()]);
    const pendingFields = JSON.stringify(page.pendingStoredDraft);
    modal.success({ confirm: mode !== "cancel" }); await pending;
    if (mode === "confirm") {
      assert.equal(page.data.name, "Synthetic old owner draft");
      assert.equal(page.photoDraftsImported, true);
    } else {
      // Page.setData values originate in a VM realm; compare the entire serialized
      // data model without treating realm-specific object prototypes as state.
      assert.deepEqual(structuredClone(page.data), before);
      assert.equal(JSON.stringify(page.pendingStoredDraft), pendingFields);
      assert.equal(page.photoDraftsImported, false);
      assert.equal(JSON.stringify([...h.storage.entries()]), storedBefore);
    }
    assert.equal(h.read().find(entry => entry.id === "synthetic-old").photos.length, 1);
  });
}
