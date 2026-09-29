import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const module = await import("../dist/services/private-photo-store.js").catch(() => null);

test("private photo store uses generated paths and can read/delete bytes", async () => {
  assert.ok(module, "private photo store has not been implemented");
  const root = await mkdtemp(join(tmpdir(), "medbox-photo-test-"));
  try {
    const store = new module.PrivatePhotoStore(root);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const saved = await store.save({ familyId: "f1", medicineId: "m1", photoId: "p1", contentType: "image/png", bytes: png });
    assert.equal(saved, "leaflets/f1/m1/p1.png");
    assert.deepEqual(await store.read(saved), png);
    await store.remove(saved);
    await assert.rejects(store.read(saved));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private photo store rejects traversal keys", async () => {
  assert.ok(module, "private photo store has not been implemented");
  const root = await mkdtemp(join(tmpdir(), "medbox-photo-test-"));
  try {
    const store = new module.PrivatePhotoStore(root);
    assert.throws(() => store.read("../../outside.png"), /invalid storage key/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
