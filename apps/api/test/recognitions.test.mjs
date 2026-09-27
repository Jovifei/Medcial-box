import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { buildServer } from "../dist/app.js";
import { FakeWechatGateway } from "../dist/auth/wechat.js";
import { DashscopeMedicineRecognitionProvider, OllamaMedicineRecognitionProvider, createDefaultMedicineRecognitionProvider } from "../dist/services/medicine-recognition.js";
import { createFakePool } from "./helpers/fake-pool.mjs";
import { login, membershipRow } from "./helpers/app.mjs";

const jpg = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(200, 0),
  Buffer.from([0xff, 0xd9]),
]).toString("base64");
const gateway = () => new FakeWechatGateway().registerCode("js-code-1", "openid-user-1");

test("recognition requires login, validates image, and returns an unsaved draft", async () => {
  const pool = createFakePool();
  let calls = 0;
  const app = await buildServer({ database: pool, logger: false, wechatGateway: gateway(), medicineRecognitionProvider: {
    async recognize() {
      calls += 1;
      return { draft: { name: "示例药", specification: null, manufacturer: null, approvalNumber: null, purposeCategory: null, lotNumber: null, expiryValue: null, expiryPrecision: null }, warnings: [], requiresConfirmation: true };
    },
  } });
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/recognitions/medicine", payload: { imageBase64: jpg, mimeType: "image/jpeg" } })).statusCode, 401);
    const token = await login(app, pool, { membership: membershipRow() });
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/recognitions/medicine", headers, payload: { imageBase64: "AAAA", mimeType: "image/jpeg" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/recognitions/medicine", headers, payload: { imageBase64: jpg.slice(0, 12), mimeType: "image/jpeg" } })).statusCode, 400);
    const response = await app.inject({ method: "POST", url: "/api/v1/recognitions/medicine", headers, payload: { imageBase64: jpg, mimeType: "image/jpeg" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().requiresConfirmation, true);
    assert.equal(calls, 1);
    assert.equal(pool.callsMatching(/INSERT INTO medicines|INSERT INTO medication_batches/).length, 0);
  } finally { await app.close(); }
});

test("provider keeps uncertain dates and missing fields visible", async () => {
  const provider = new DashscopeMedicineRecognitionProvider("synthetic-key", "test-model", "https://example.test/v1", async () => new globalThis.Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ name: "示例药", expiryValue: "2027-12", specification: 3 }) } }] }), { status: 200 }));
  const result = await provider.recognize(jpg, "image/jpeg");
  assert.equal(result.draft.expiryPrecision, "month");
  assert.equal(result.draft.specification, null);
  assert.equal(result.draft.approvalNumber, null);
  assert.equal(result.requiresConfirmation, true);
  assert.ok(result.warnings.length > 0);
});

test("missing provider key gives clear 503 without exposing credentials", async () => {
  const pool = createFakePool();
  const app = await buildServer({ database: pool, logger: false, wechatGateway: gateway(), medicineRecognitionProvider: new DashscopeMedicineRecognitionProvider("") });
  try {
    const token = await login(app, pool, { membership: membershipRow() });
    const response = await app.inject({ method: "POST", url: "/api/v1/recognitions/medicine", headers: { authorization: `Bearer ${token}` }, payload: { imageBase64: jpg, mimeType: "image/jpeg" } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, "RECOGNITION_UNAVAILABLE");
    assert.equal(response.body.includes("DASHSCOPE"), false);
  } finally { await app.close(); }
});

test("Ollama receives image in JSON and returns a confirmation draft", async () => {
  let request;
  const provider = new OllamaMedicineRecognitionProvider("qwen3.5:0.8b", "http://ollama.test/", async (url, init) => {
    request = { url, init };
    return new globalThis.Response(JSON.stringify({ message: { content: JSON.stringify({ name: "  测试药  ", expiryValue: "2027-12", approvalNumber: "国药准字测试" }) } }), { status: 200 });
  });
  const result = await provider.recognize(jpg, "image/jpeg");
  assert.equal(request.url, "http://ollama.test/api/chat");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.signal.aborted, false);
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, "qwen3.5:0.8b");
  assert.equal(body.stream, false);
  assert.equal(body.format, "json");
  assert.equal(body.options.num_ctx, 2048);
  assert.equal(body.options.num_batch, 128);
  assert.deepEqual(body.messages[0].images, [jpg]);
  assert.match(body.messages[0].content, /不要推断/);
  assert.equal(result.draft.name, "测试药");
  assert.equal(result.draft.expiryPrecision, "month");
  assert.equal(result.requiresConfirmation, true);
});

test("Ollama failures and malformed output become safe 503", async () => {
  const cases = [
    async () => { throw new Error("private endpoint details"); },
    async () => new globalThis.Response("unavailable", { status: 503 }),
    async () => new globalThis.Response(JSON.stringify({ message: { content: "not json" } }), { status: 200 }),
    async () => new globalThis.Response(JSON.stringify({ message: { content: "[]" } }), { status: 200 }),
  ];
  for (const fakeFetch of cases) {
    const pool = createFakePool();
    const app = await buildServer({ database: pool, logger: false, wechatGateway: gateway(), medicineRecognitionProvider: new OllamaMedicineRecognitionProvider("test", "http://ollama.test", fakeFetch) });
    try {
      const token = await login(app, pool, { membership: membershipRow() });
      const response = await app.inject({ method: "POST", url: "/api/v1/recognitions/medicine", headers: { authorization: `Bearer ${token}` }, payload: { imageBase64: jpg, mimeType: "image/jpeg" } });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, "RECOGNITION_UNAVAILABLE");
      assert.equal(response.body.includes("private endpoint details"), false);
      assert.equal(response.body.includes(jpg), false);
    } finally { await app.close(); }
  }
});

test("provider factory selects Ollama only when explicitly configured", () => {
  const prior = process.env.MEDICINE_RECOGNITION_PROVIDER;
  try {
    process.env.MEDICINE_RECOGNITION_PROVIDER = "ollama";
    assert.ok(createDefaultMedicineRecognitionProvider() instanceof OllamaMedicineRecognitionProvider);
    delete process.env.MEDICINE_RECOGNITION_PROVIDER;
    assert.ok(createDefaultMedicineRecognitionProvider() instanceof DashscopeMedicineRecognitionProvider);
  } finally {
    if (prior === undefined) delete process.env.MEDICINE_RECOGNITION_PROVIDER;
    else process.env.MEDICINE_RECOGNITION_PROVIDER = prior;
  }
});
