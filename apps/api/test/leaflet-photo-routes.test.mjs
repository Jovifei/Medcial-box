import assert from "node:assert/strict";
import Fastify from "fastify";
import test from "node:test";

const module = await import("../dist/routes/leaflet-photos.js").catch(() => null);
const appModule = await import("../dist/app.js").catch(() => null);

async function createPhotoApp({ store, database }) {
  assert.ok(module, "leaflet photo routes have not been implemented");
  const app = Fastify({ logger: false });
  const userId = `user-${Math.random().toString(16).slice(2)}`;
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    request.auth = { userId, familyId: "family-1", role: "owner", sessionId: "session-1" };
  });
  if (typeof database.withTransaction !== "function") {
    database.withTransaction = async (work) => work({
      query: async (sql, params) => {
        if (String(sql).includes("SELECT id FROM families")) return { rows: [{ id: "family-1" }], rowCount: 1 };
        return database.query(sql, params);
      },
    });
  }
  await module.registerLeafletPhotoRoutes(app, database, store);
  return app;
}

const validPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
const asBase64 = validPng.toString("base64");

test("leaflet upload stores a private image only after family medicine authorization", async () => {
  const calls = [];
  let reservedPhoto;
  const database = { query: async (sql, params = []) => {
    calls.push({ sql: String(sql), params });
    if (String(sql).includes("FROM medicines")) return { rows: [{ id: "medicine-1" }], rowCount: 1 };
    if (String(sql).includes("INSERT INTO medicine_leaflet_photos")) {
      reservedPhoto = { id: params[0], family_id: params[1], medicine_id: params[2], storage_key: params[3], content_type: params[4], size_bytes: params[5], source: params[6], created_by: params[7], created_at: new Date("2026-09-29T00:00:00Z") };
      return { rows: [{ id: reservedPhoto.id }], rowCount: 1 };
    }
    if (String(sql).includes("UPDATE medicine_leaflet_photos SET upload_completed_at = now()")) {
      return { rows: [{ ...reservedPhoto, deleted_at: null }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  } };
  const stored = [];
  const store = {
    save: async (input) => { stored.push(input); return `leaflets/${input.familyId}/${input.medicineId}/${input.photoId}.png`; },
    remove: async () => undefined,
    read: async () => validPng,
  };
  const app = await createPhotoApp({ store, database });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/medicines/medicine-1/leaflet-photos",
      payload: { imageBase64: asBase64, mimeType: "image/png", source: "package_leaflet" },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].familyId, "family-1");
    assert.equal(response.json().photo.url, `/api/v1/medicines/medicine-1/leaflet-photos/${response.json().photo.id}`);
    assert.equal(calls.some((call) => call.params.includes("family-1")), true);
  } finally {
    await app.close();
  }
});

test("leaflet upload rejects invalid image envelopes without storing bytes", async () => {
  let writes = 0;
  const database = { query: async () => ({ rows: [{ id: "medicine-1" }], rowCount: 1 }) };
  const store = { save: async () => { writes += 1; return "unused"; }, remove: async () => undefined, read: async () => Buffer.alloc(0) };
  const app = await createPhotoApp({ store, database });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/medicines/medicine-1/leaflet-photos",
      payload: { imageBase64: Buffer.from("not an image").toString("base64"), mimeType: "image/png" },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(writes, 0);
  } finally {
    await app.close();
  }
});

test("unauthenticated oversized leaflet uploads are rejected before JSON parsing", async () => {
  assert.ok(appModule, "application server has not been implemented");
  let databaseCalls = 0;
  const app = await appModule.buildServer({
    database: {
      query: async () => { databaseCalls += 1; return { rows: [], rowCount: 0 }; },
      withTransaction: async (work) => work({ query: async () => ({ rows: [], rowCount: 0 }) }),
    },
    privatePhotoStore: { save: async () => "unused", remove: async () => undefined, read: async () => validPng },
    logger: false,
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/medicines/medicine-1/leaflet-photos",
      headers: { "content-type": "application/json" },
      payload: Buffer.alloc(12 * 1024 * 1024 + 1, 0x78),
    });
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(databaseCalls, 0, "unauthenticated requests must not reach the database or body handler");
  } finally {
    await app.close();
  }
});

test("leaflet upload rejects families that exceed the private photo storage quota before writing", async () => {
  let writes = 0;
  const database = {
    query: async (sql) => {
      if (String(sql).includes("FROM medicines")) return { rows: [{ id: "medicine-1" }], rowCount: 1 };
      if (String(sql).includes("sum(size_bytes)")) {
        assert.match(String(sql), /storage_removed_at IS NULL/);
        return { rows: [{ photo_count: 20, total_bytes: 64 * 1024 * 1024 - 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    withTransaction: async (work) => work({ query: async (sql, params) => {
      if (String(sql).includes("SELECT id FROM families")) return { rows: [{ id: "family-1" }], rowCount: 1 };
      return database.query(sql, params);
    } }),
  };
  const store = { save: async () => { writes += 1; return "unused"; }, remove: async () => undefined, read: async () => validPng };
  const app = await createPhotoApp({ store, database });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/medicines/medicine-1/leaflet-photos",
      payload: { imageBase64: asBase64, mimeType: "image/png" },
    });
    assert.equal(response.statusCode, 413, response.body);
    assert.equal(writes, 0);
  } finally {
    await app.close();
  }
});

test("deleting a leaflet photo removes its file before marking storage quota released", async () => {
  const order = [];
  const database = {
    query: async (sql) => {
      if (String(sql).includes("SELECT id, storage_key FROM medicine_leaflet_photos")) {
        return { rows: [{ id: "photo-1", storage_key: "private/photo.png" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    withTransaction: async (work) => work({
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("SELECT id FROM families")) return { rows: [{ id: "family-1" }], rowCount: 1 };
        if (text.includes("FROM medicine_leaflet_photos") && text.includes("FOR UPDATE")) {
          return { rows: [{ id: "photo-1" }], rowCount: 1 };
        }
        if (text.includes("SET deleted_at = now()")) {
          order.push("soft-delete");
          return { rows: [{ id: "photo-1" }], rowCount: 1 };
        }
        if (text.includes("SET storage_removed_at = now()")) {
          order.push("mark-storage-removed");
          return { rows: [{ id: "photo-1" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    }),
  };
  const store = {
    save: async () => "unused",
    remove: async (key) => { assert.equal(key, "private/photo.png"); order.push("remove-file"); },
    read: async () => validPng,
  };
  const app = await createPhotoApp({ store, database });
  try {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/medicines/medicine-1/leaflet-photos/photo-1",
    });
    assert.equal(response.statusCode, 204);
    assert.deepEqual(order, ["soft-delete", "remove-file", "mark-storage-removed"]);
  } finally {
    await app.close();
  }
});

test("family photo quota is checked under the family lock before any file is written", async () => {
  let usageChecks = 0;
  let writes = 0;
  let removals = 0;
  const database = {
    query: async (sql) => {
      if (String(sql).includes("FROM medicines")) return { rows: [{ id: "medicine-1" }], rowCount: 1 };
      if (String(sql).includes("sum(size_bytes)")) {
        usageChecks += 1;
        return { rows: [{ photo_count: 20, total_bytes: 64 * 1024 * 1024 - 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const store = {
    save: async () => { writes += 1; return "leaflets/family-1/medicine-1/photo-1.png"; },
    remove: async () => { removals += 1; },
    read: async () => validPng,
  };
  const app = await createPhotoApp({ store, database });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/medicines/medicine-1/leaflet-photos",
      payload: { imageBase64: asBase64, mimeType: "image/png" },
    });
    assert.equal(response.statusCode, 413);
    assert.equal(usageChecks, 1);
    assert.equal(writes, 0);
    assert.equal(removals, 0);
  } finally {
    await app.close();
  }
});

test("per-user upload rate limit rejects excess requests before parsing their bodies", async () => {
  let writes = 0;
  let photoRow;
  const database = {
    query: async (sql) => {
      if (String(sql).includes("FROM medicines")) return { rows: [{ id: "medicine-1" }], rowCount: 1 };
      if (String(sql).includes("sum(size_bytes)")) return { rows: [{ photo_count: 0, total_bytes: 0 }], rowCount: 1 };
      if (String(sql).includes("INSERT INTO medicine_leaflet_photos")) {
        photoRow = { id: "photo-1", medicine_id: "medicine-1", content_type: "image/png", size_bytes: validPng.length, source: "package_leaflet", storage_key: "leaflets/family-1/medicine-1/photo.png", created_at: new Date() };
        return { rows: [{ id: "photo-1" }], rowCount: 1 };
      }
      if (String(sql).includes("UPDATE medicine_leaflet_photos SET upload_completed_at = now()")) return { rows: [photoRow], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const store = {
    save: async (input) => { writes += 1; return `leaflets/${input.familyId}/${input.medicineId}/${input.photoId}.png`; },
    remove: async () => undefined,
    read: async () => validPng,
  };
  const app = await createPhotoApp({ store, database });
  try {
    for (let index = 0; index < 10; index += 1) {
      const accepted = await app.inject({
        method: "POST",
        url: "/api/v1/medicines/medicine-1/leaflet-photos",
        payload: { imageBase64: asBase64, mimeType: "image/png" },
      });
      assert.equal(accepted.statusCode, 201);
    }
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/medicines/medicine-1/leaflet-photos",
      headers: { "content-type": "application/json" },
      payload: "not-json",
    });
    assert.equal(denied.statusCode, 429, denied.body);
    assert.equal(writes, 10);
  } finally {
    await app.close();
  }
});
