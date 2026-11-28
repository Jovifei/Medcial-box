import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { loadPage, loadService, makePageContext } from "./runtime.mjs";

class ApiError extends Error {}
const auth = { "../../services/auth": { ensureLoggedIn: async () => {} } };

test("quantityUnitShort maps every supported unit and keeps unknown enums visible", () => {
  const { quantityUnitShort } = loadService("services/quantity-units.ts", {
    modules: { "./input-validation": loadService("services/input-validation.ts", {}) },
  });
  const expected = { tablet: "片", capsule: "粒", sachet: "袋", bottle: "瓶", tube: "支", box: "盒", blister: "板", ml: "毫升", other: "份" };
  for (const [unit, label] of Object.entries(expected)) assert.equal(quantityUnitShort(unit), label, unit);
  assert.equal(quantityUnitShort("carton"), "单位待核对");
  assert.equal(quantityUnitShort(undefined), "单位待核对");
});

test("stocktake maps unit enums to Chinese labels and protects the raw enum", async () => {
  const session = { id: "s", items: [
    { batchId: "b1", medicineId: "m1", medicineName: "阿莫西林", unit: "bottle", quantity: 3, version: 1, result: "pending" },
    { batchId: "b2", medicineId: "m2", medicineName: "维生素", unit: "blister", quantity: 2, version: 1, result: "pending" },
    { batchId: "b3", medicineId: "m3", medicineName: "口服液", unit: "ml", quantity: 12.5, version: 1, result: "pending" },
    { batchId: "b4", medicineId: "m4", medicineName: "备用", unit: "other", quantity: 1, version: 1, result: "pending" },
  ] };
  const { definition } = loadPage("pages/stocktake/stocktake.ts", { modules: {
    ...auth,
    "../../services/api": { ApiError, api: { getCurrentStocktake: async () => ({ stocktake: session }) } },
  } });
  const page = makePageContext(definition);
  page.applySession(session);
  assert.deepEqual(page.data.items.map((item) => item.unitLabel), ["瓶", "板", "毫升", "份"]);
  const markup = fs.readFileSync(new URL("../pages/stocktake/stocktake.wxml", import.meta.url), "utf8");
  assert.match(markup, /item\.quantity \+ item\.unitLabel/);
  assert.doesNotMatch(markup, /item\.quantity \+ item\.unit\b/);
});

test("stocktake conflict hint uses the display label", async () => {
  const { definition } = loadPage("pages/stocktake/stocktake.ts", { modules: {
    ...auth,
    "../../services/api": { ApiError, api: {
      getCurrentStocktake: async () => ({ stocktake: { id: "s", items: [
        { batchId: "b1", medicineId: "m1", medicineName: "阿莫西林", unit: "bottle", quantity: 3, version: 1, result: "conflict" },
      ] } }),
      getMedicine: async () => ({ batches: [{ id: "b1", version: 2, quantity: 4, unit: "bottle" }] }),
    } },
  } });
  const page = makePageContext(definition);
  await page.refresh();
  assert.equal(page.data.items[0].resultLabel, "家人已修改此批次；当前数量：4 瓶，请重新核对。");
});

test("restock renders blister and ml via the shared table", async () => {
  const { definition } = loadPage("pages/restock/restock.ts", { modules: {
    ...auth,
    "../../services/api": { ApiError, api: { listRestockItems: async () => ({ items: [
      { id: "r1", medicineId: "m1", medicineName: "片剂", desiredQuantity: 2, unit: "blister", status: "needed", createdAt: "2026-11-18", version: 1 },
      { id: "r2", medicineId: "m2", medicineName: "糖浆", desiredQuantity: 100, unit: "ml", status: "needed", createdAt: "2026-11-18", version: 1 },
      { id: "r3", medicineId: "m3", medicineName: "片剂2", desiredQuantity: 1, unit: "tablet", status: "needed", createdAt: "2026-11-18", version: 1 },
    ] }) } },
  } });
  const page = makePageContext(definition);
  await page.refresh();
  assert.deepEqual(page.data.items.map((item) => item.quantityLabel), ["目标 2板", "目标 100毫升", "目标 1片"]);
});