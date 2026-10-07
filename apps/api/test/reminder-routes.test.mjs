import assert from "node:assert/strict";
import test from "node:test";
import { buildServer } from "../dist/app.js";
import { FakeWechatGateway } from "../dist/auth/wechat.js";
import { createReminderTemplateConfig } from "../dist/services/subscribe-messages.js";
import { createFakePool } from "./helpers/fake-pool.mjs";
import { batchRow, medicineRow } from "./helpers/app.mjs";

async function createReminderApp({ configured = false } = {}) {
  const pool = createFakePool();
  pool.always(/FROM sessions WHERE token_hash/, {
    rows: [{ id: "session-1", user_id: "user-1", expires_at: new Date(Date.now() + 86_400_000).toISOString() }],
    rowCount: 1,
  });
  pool.always(/FROM family_members WHERE user_id/, {
    rows: [{ id: "member-1", family_id: "family-1", user_id: "user-1", role: "owner" }],
    rowCount: 1,
  });
  const config = createReminderTemplateConfig(configured
    ? { appId: "wx-test", appSecret: "secret-test", templateId: "template-1" }
    : { appId: "", appSecret: "", templateId: "" });
  const app = await buildServer({
    database: pool,
    wechatGateway: new FakeWechatGateway(),
    reminderTemplateConfig: config,
    logger: false,
  });
  return { app, pool };
}

test("reminder templates report unavailable without account/template configuration", async () => {
  const { app } = await createReminderApp();
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/notifications/templates", headers: { authorization: "Bearer test" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().available, false);
    assert.deepEqual(response.json().templates, []);
  } finally {
    await app.close();
  }
});

test("one-time consent grants are recorded only for accepted configured templates", async () => {
  const { app, pool } = await createReminderApp({ configured: true });
  try {
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/subscribe",
      headers: { authorization: "Bearer test" },
      payload: { acceptedTemplateIds: ["attacker-template"] },
    });
    assert.equal(denied.statusCode, 400);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/subscribe",
      headers: { authorization: "Bearer test" },
      payload: { acceptedTemplateIds: ["template-1"] },
    });
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(accepted.json(), { acceptedTemplateIds: ["template-1"] });
    assert.equal(pool.callsMatching(/INSERT INTO wechat_subscription_grants/).length, 1);
  } finally {
    await app.close();
  }
});

test("pending medicine info includes missing specification, manufacturer or ingredients", async () => {
  const { app, pool } = await createReminderApp();
  pool.always(/FROM medicines WHERE family_id/, {
    rows: [medicineRow({
      specification: null,
      manufacturer: null,
      active_ingredients: [],
      leaflet_review_status: "user_confirmed",
    })],
    rowCount: 1,
  });
  pool.always(/FROM medicine_batches WHERE family_id/, { rows: [], rowCount: 0 });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/notifications/pending",
      headers: { authorization: "Bearer test" },
    });
    assert.equal(response.statusCode, 200);
    const item = response.json().items.find((entry) => entry.type === "leaflet_missing");
    assert.ok(item);
    assert.equal(item.action, "review_leaflet");
    assert.match(item.message, /规格、厂家或成分/);
  } finally {
    await app.close();
  }
});

test("handled batches are removed from the pending expiry list", async () => {
  const { app, pool } = await createReminderApp();
  pool.always(/FROM medicines WHERE family_id/, {
    rows: [medicineRow({ leaflet_review_status: "user_confirmed" })],
    rowCount: 1,
  });
  pool.always(/FROM medicine_batches WHERE family_id/, {
    rows: [batchRow({
      expiry_value: "1999-01",
      expiry_precision: "month",
      disposition_status: "handled",
    })],
    rowCount: 1,
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/notifications/pending",
      headers: { authorization: "Bearer test" },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().items, []);
  } finally {
    await app.close();
  }
});
