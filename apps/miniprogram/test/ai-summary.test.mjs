import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { loadPage, loadService, makePageContext } from "./runtime.mjs";

const medicine = {
  id: "synthetic-ai",
  name: "测试药品甲",
  specification: "10mg × 12片",
  manufacturer: "合成厂家",
  activeIngredients: ["合成成分"],
  batches: [],
  purposeCategory: null,
  populationTags: [],
  purposeTags: [],
  isArchived: false,
  leaflet: {
    reviewStatus: "unverified",
    source: null,
    purposeSummary: "合成用途",
    packageUsageSummary: "合成用法",
    contraindicationsSummary: "合成禁忌",
    precautionsSummary: "合成注意事项",
  },
};

test("ai summary prompt uses only medicine facts and forbids medical advice", () => {
  const service = loadService("services/ai-summary.ts", {
    modules: { "./ai-api": { aiApi: { generateText: async () => ({ text: "ok" }) } } },
  });
  const messages = service.buildMedicineSummaryMessages(medicine);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /不要给出诊断、剂量或用药建议/);
  assert.match(messages[0].content, /120 字/);
  assert.match(messages[1].content, /测试药品甲/);
  assert.match(messages[1].content, /合成用途/);
  assert.match(messages[1].content, /合成注意事项/);
  assert.equal(service.AI_SUMMARY_DISCLAIMER, "AI 生成，请以说明书为准");
});

test("summarizeMedicine trims and caps the generated summary", async () => {
  let sent;
  const service = loadService("services/ai-summary.ts", {
    modules: { "./ai-api": { aiApi: { generateText: async (messages) => { sent = messages; return { text: `  ${"很".repeat(300)}  ` }; } } } },
  });
  const result = await service.summarizeMedicine(medicine);
  assert.equal(sent.length, 2);
  assert.ok(result.length <= 241);
  assert.match(result, /…$/);
});

test("detail page generates the AI summary on demand and shows the disclaimer", async () => {
  let calls = 0;
  const { definition } = loadPage("pages/medicine-detail/medicine-detail.ts", { modules: {
    "../../services/api": { api: {}, ApiError: class extends Error {}, captureSessionIdentity: () => ({ token: "t", generation: 1 }), isCurrentSession: () => true },
    "../../services/auth": { ensureLoggedIn: async () => {} },
    "../../services/ai-summary": { AI_SUMMARY_DISCLAIMER: "AI 生成，请以说明书为准", summarizeMedicine: async () => { calls += 1; return "合成 AI 摘要"; } },
  } });
  const page = makePageContext(definition);
  page.data.medicineSummary = medicine;
  await page.onGenerateAiSummary();
  assert.equal(calls, 1);
  assert.equal(page.data.aiSummary, "合成 AI 摘要");
  assert.equal(page.data.aiSummaryLoading, false);
  assert.equal(page.data.aiSummaryError, "");
  assert.equal(page.data.aiSummaryDisclaimer, "AI 生成，请以说明书为准");
  const markup = fs.readFileSync(new URL("../pages/medicine-detail/medicine-detail.wxml", import.meta.url), "utf8");
  assert.ok(markup.indexOf("ai-summary-card") < markup.indexOf("库存批次"));
  assert.match(markup, /bindtap="onGenerateAiSummary"/);
  assert.match(markup, /\{\{aiSummaryDisclaimer\}\}/);
});

test("detail page keeps a retryable error state when the AI summary fails", async () => {
  const { definition } = loadPage("pages/medicine-detail/medicine-detail.ts", { modules: {
    "../../services/api": { api: {}, ApiError: class extends Error {}, captureSessionIdentity: () => ({ token: "t", generation: 1 }), isCurrentSession: () => true },
    "../../services/auth": { ensureLoggedIn: async () => {} },
    "../../services/ai-summary": { AI_SUMMARY_DISCLAIMER: "AI 生成，请以说明书为准", summarizeMedicine: async () => { throw new Error("当前使用人数较多，请稍后重试"); } },
  } });
  const page = makePageContext(definition);
  page.data.medicineSummary = medicine;
  await page.onGenerateAiSummary();
  assert.equal(page.data.aiSummaryLoading, false);
  assert.equal(page.data.aiSummary, "");
  assert.equal(page.data.aiSummaryError, "当前使用人数较多，请稍后重试");
});