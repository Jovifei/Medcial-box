// 导出结构化用途/人群标签（2026-10-25 修复批次）：
// - Markdown 在药品元信息行渲染"用途标签/适用人群"中文文案；
// - CSV/PDF 的"人群标签/用途标签"列输出中文标签而非英文枚举值；
// - 空标签不输出占位文本；未知枚举值原样保留。
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdownExport } from "../dist/services/markdown-export.js";
import { renderCsvExport, EXPORT_COLUMNS, inventoryExportRows } from "../dist/services/csv-export.js";

function snapshotWith(overrides = {}) {
  return {
    snapshotId: "snap-1",
    generatedAt: "2026-10-25T08:00:00.000Z",
    expiresAt: "2026-10-25T09:00:00.000Z",
    options: { includePersonalDosage: false, includeArchived: false, includeStorageLocation: true },
    medicines: [
      {
        id: "m1",
        name: "布洛芬缓释胶囊",
        brand: null,
        specification: "0.3g×20粒",
        manufacturer: "测试药厂",
        approvalNumber: "国药准字H测试",
        barcodeValue: null,
        activeIngredients: ["布洛芬"],
        purposeCategory: "解热镇痛",
        purposeTags: ["fever", "pain"],
        populationTags: ["adult"],
        tagSource: null,
        coverPhotoId: null,
        isArchived: false,
        stockStatus: null,
        lowStockThreshold: null,
        leaflet: {
          purposeSummary: null,
          packageUsageSummary: null,
          contraindicationsSummary: null,
          precautionsSummary: null,
          source: null,
          reviewStatus: "unverified",
        },
        batches: [{
          id: "b1",
          version: 1,
          lotNumber: null,
          quantity: 20,
          unit: "capsule",
          confirmedUnitsPerPackage: null,
          conversionUnit: null,
          storageLocation: null,
          expiry: { value: "2027-01", precision: "month" },
          openedState: "unknown",
          openedAt: null,
          afterOpeningLimit: null,
        }],
        ...overrides,
      },
    ],
  };
}

test("markdown export renders chinese purpose and population tag labels", () => {
  const markdown = renderMarkdownExport(snapshotWith().medicines, snapshotWith().options, new Date("2026-10-25T08:00:00Z"));
  assert.match(markdown, /用途标签：发热、疼痛/);
  assert.match(markdown, /适用人群：成人/);
  assert.doesNotMatch(markdown, /用途标签：fever/);
});

test("csv export renders chinese tag labels in dedicated columns", () => {
  const rows = inventoryExportRows(snapshotWith());
  const purposeIndex = EXPORT_COLUMNS.indexOf("用途标签");
  const populationIndex = EXPORT_COLUMNS.indexOf("人群标签");
  assert.ok(purposeIndex >= 0 && populationIndex >= 0);
  assert.equal(rows[0][purposeIndex], "发热；疼痛");
  assert.equal(rows[0][populationIndex], "成人");
  const csv = renderCsvExport(snapshotWith());
  assert.ok(csv.includes("发热；疼痛"));
});

test("exports without tags omit placeholder tag text", () => {
  const medicines = snapshotWith().medicines;
  medicines[0] = { ...medicines[0], purposeTags: [], populationTags: [] };
  const markdown = renderMarkdownExport(medicines, snapshotWith().options, new Date());
  assert.doesNotMatch(markdown, /用途标签/);
  assert.doesNotMatch(markdown, /适用人群/);
  const bare = snapshotWith();
  bare.medicines = [{ ...bare.medicines[0], purposeTags: [], populationTags: [] }];
  const rows = inventoryExportRows(bare);
  assert.equal(rows[0][EXPORT_COLUMNS.indexOf("用途标签")], "");
});

test("unknown tag values are preserved but markdown-escaped", () => {
  const medicines = snapshotWith().medicines;
  // @ts-expect-error 故意注入未知枚举，验证兜底原样输出且经 Markdown 转义
  medicines[0] = { ...medicines[0], purposeTags: ["fever", "future_tag"] };
  const markdown = renderMarkdownExport(medicines, snapshotWith().options, new Date());
  assert.match(markdown, /用途标签：发热、future\\_tag/);
});

test("prototype property names stay unknown labels in every export column", () => {
  const unknown = ["constructor", "toString", "__proto__"];
  const snapshot = snapshotWith({ purposeTags: unknown, populationTags: unknown });
  const row = inventoryExportRows(snapshot)[0];
  for (const column of ["用途标签", "人群标签"]) {
    assert.equal(row[EXPORT_COLUMNS.indexOf(column)], unknown.join("；"));
  }
  const markdown = renderMarkdownExport(snapshot.medicines, snapshot.options, new Date());
  assert.match(markdown, /用途标签：constructor、toString、\\_\\_proto\\_\\_/);
  assert.match(markdown, /适用人群：constructor、toString、\\_\\_proto\\_\\_/);
  assert.doesNotMatch(renderCsvExport(snapshot), /function|native code|\[object Object\]/);
});
