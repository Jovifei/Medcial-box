import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { buildServer } from "../dist/app.js";
import { FakeWechatGateway } from "../dist/auth/wechat.js";
import { DashscopeMedicineRecognitionProvider, OllamaMedicineRecognitionProvider, createDefaultMedicineRecognitionProvider, RecognitionUnavailableError } from "../dist/services/medicine-recognition.js";
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
  assert.equal(body.think, false);
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


test("AI classification remains a bounded confirmation draft", async () => {
  const provider = new OllamaMedicineRecognitionProvider("test", "http://ollama.test", async () =>
    new globalThis.Response(JSON.stringify({message: {content: JSON.stringify({name: "合成药品", purposeTags: ["topical", "adult", "topical", 42, "allergy"]})}})));
  const result = await provider.recognize(jpg, "image/jpeg");
  assert.deepEqual(result.draft.purposeTags, ["topical", "allergy"]);
  assert.equal(result.requiresConfirmation, true);
  assert.ok(result.warnings.some(value => value.includes("AI 用途标签")));
  assert.equal(result.draft.populationTags, undefined);
});


test("packaging recognition rejects duration as a count and retains an explicit pack", async () => {
  for (const [specification, expected] of [["12小时", null], ["12 hours", null], ["20粒装", "20粒装"], ["12小时 / 20粒装", "12小时 / 20粒装"]]) {
    const provider = new OllamaMedicineRecognitionProvider("test", "http://ollama.test", async (_url, init) => {
      assert.match(JSON.parse(init.body).messages[0].content, /12小时.*不能当粒数/);
      return new globalThis.Response(JSON.stringify({ message: { content: JSON.stringify({ name: "合成药", brand: "测试品牌", manufacturer: "测试厂家", specification }) } }));
    });
    const { draft } = await provider.recognize(jpg, "image/jpeg");
    assert.equal(draft.specification, expected);
    assert.equal(draft.brand, "测试品牌");
    assert.equal(draft.manufacturer, "测试厂家");
  }
});

test("leaflet recognition retains visible text and filters suggested tags", async () => {
  let prompt;
  const provider = new DashscopeMedicineRecognitionProvider("synthetic-key", "test", "https://example.test", async (_url, init) => {
    prompt = JSON.parse(init.body).messages[0].content[0].text;
    return new globalThis.Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      name: "合成药", purposeTags: ["itch", "eye", "oral", "constipation", "diarrhea", "unknown"],
      populationTags: ["child", "child", "elderly"],
      leaflet: { text: " 合成说明书原文 ", purposeSummary: "测试用途", packageUsageSummary: "测试包装用法", contraindicationsSummary: 42, precautionsSummary: "测试注意事项" }
    }) } }] }));
  });
  const result = await provider.recognize(jpg, "image/jpeg", "leaflet");
  assert.match(prompt, /说明书照片/);
  assert.deepEqual(result.draft.purposeTags, ["itch", "eye", "oral", "constipation", "diarrhea"]);
  assert.deepEqual(result.draft.populationTags, ["child"]);
  assert.deepEqual(result.draft.leaflet, { text: "合成说明书原文", purposeSummary: "测试用途", packageUsageSummary: "测试包装用法", contraindicationsSummary: null, precautionsSummary: "测试注意事项" });
  assert.equal(result.requiresConfirmation, true);
});

test("recognition purpose is validated and forwarded without storing a medicine", async () => {
  const pool = createFakePool();
  const purposes = [];
  const app = await buildServer({ database: pool, logger: false, wechatGateway: gateway(), medicineRecognitionProvider: {
    async recognize(_image, _type, purpose) { purposes.push(purpose); return { draft: {}, warnings: [], requiresConfirmation: true }; }
  } });
  try {
    const token = await login(app, pool, { membership: membershipRow() });
    const headers = { authorization: `Bearer ${token}` };
    const payload = { imageBase64: jpg, mimeType: "image/jpeg" };
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/recognitions/medicine", headers, payload: { ...payload, purpose: "leaflet" } })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/recognitions/medicine", headers, payload: { ...payload, purpose: "unknown" } })).statusCode, 400);
    assert.deepEqual(purposes, ["leaflet"]);
    assert.equal(pool.callsMatching(/INSERT INTO medicines/).length, 0);
  } finally { await app.close(); }
});


test("upstream errors are classified without retaining response text in the error", async () => {
  const cases = [
    [400, "failed to decode image PRIVATE_PHOTO_BODY", "image_decode"],
    [404, "model test not found PRIVATE_TOKEN", "model_missing"],
    [400, "context length exceeded", "context_limit"],
    [500, "CUDA out of memory", "model_memory"],
    [400, "invalid request parameter", "invalid_request"],
    [503, "unavailable", "provider_unavailable"],
    [504, "gateway", "timeout"],
    [400, "PRIVATE_TOKEN unexplained", "unknown"],
  ];
  for (const [status, message, reason] of cases) {
    const provider = new OllamaMedicineRecognitionProvider("test", "http://ollama.test", async () => new globalThis.Response(JSON.stringify({ error: message }), { status }));
    await assert.rejects(provider.recognize(jpg, "image/jpeg"), error => {
      assert.equal(error.reason, reason);
      assert.equal(error.upstreamStatus, status);
      assert.equal(error.message.includes("PRIVATE"), false);
      assert.deepEqual(Object.keys(error).sort(), ["reason", "upstreamStatus"]);
      return true;
    });
  }
  const timeout = new OllamaMedicineRecognitionProvider("test", "http://ollama.test", async () => { throw new globalThis.DOMException("PRIVATE details", "TimeoutError"); });
  await assert.rejects(timeout.recognize(jpg, "image/jpeg"), error => error.reason === "timeout" && !error.message.includes("PRIVATE"));
});

test("recognition failures keep the compatible API code and give category-specific actions", async () => {
  for (const [reason, action] of [["image_decode", "重拍"], ["model_missing", "模型配置"], ["context_limit", "分开拍摄"], ["model_memory", "资源不足"], ["provider_unavailable", "稍后重试"], ["invalid_request", "未接受"], ["invalid_json", "格式不完整"], ["timeout", "超时"], ["unknown", "诊断"]]) {
    const pool = createFakePool();
    const app = await buildServer({ database: pool, logger: false, wechatGateway: gateway(), medicineRecognitionProvider: { async recognize() { throw new RecognitionUnavailableError("PRIVATE upstream text", reason, 400); } } });
    try {
      const token = await login(app, pool, { membership: membershipRow() });
      const response = await app.inject({ method: "POST", url: "/api/v1/recognitions/medicine", headers: { authorization: `Bearer ${token}` }, payload: { imageBase64: jpg, mimeType: "image/jpeg" } });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, "RECOGNITION_UNAVAILABLE");
      assert.ok(response.json().error.message.includes(action));
      assert.equal(response.body.includes("PRIVATE"), false);
      assert.equal(response.body.includes(jpg), false);
    } finally { await app.close(); }
  }
});


test("failure logs retain only diagnostic category and upstream status", async () => {
  const { default: Fastify } = await import("fastify");
  const { Writable } = await import("node:stream");
  const { registerRecognitionRoutes } = await import("../dist/routes/recognitions.js");
  const lines = [];
  const stream = new Writable({ write(chunk, _encoding, callback) { lines.push(chunk.toString()); callback(); } });
  const app = Fastify({ logger: { stream } });
  app.decorateRequest("auth", null);
  app.addHook("preHandler", async request => { request.auth = { userId: "synthetic-user", familyId: "synthetic-family", role: "owner" }; });
  await registerRecognitionRoutes(app, { async recognize() { throw new RecognitionUnavailableError("PRIVATE upstream error text", "unknown", 400); } });
  try {
    const response = await app.inject({ method: "POST", url: "/api/v1/recognitions/medicine", headers: { authorization: "Bearer PRIVATE_TOKEN" }, payload: { imageBase64: jpg, mimeType: "image/jpeg" } });
    assert.equal(response.statusCode, 503);
    const diagnostics = lines.map(line => JSON.parse(line)).filter(line => line.msg === "medicine photo recognition unavailable");
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].reason, "unknown");
    assert.equal(diagnostics[0].upstreamStatus, 400);
    assert.equal(lines.join("").includes("PRIVATE"), false);
    assert.equal(lines.join("").includes(jpg), false);
  } finally { await app.close(); }
});
