import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { loadPage, makePageContext } from "./runtime.mjs";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("stock and detail use one exhausted wording", () => {
  for (const file of ["../pages/index/index.ts", "../pages/medicine-detail/medicine-detail.ts"]) {
    assert.doesNotMatch(read(file), /已耗尽/, file);
  }
});

test("plan empty state distinguishes the all filter from an empty selected status", () => {
  const markup = read("../pages/medication-plans/medication-plans.wxml");
  assert.match(markup, /planStatusFilter === 'all' \? '还没有用药计划' : '这个状态没有计划'/);
});

test("pending suggestion collapse has a 48px target and expanded semantics", () => {
  const markup = read("../pages/pending/pending.wxml");
  const css = read("../pages/pending/pending.wxss");
  assert.match(markup, /class="section-title pending-collapse"/);
  assert.match(markup, /aria-expanded="\{\{suggestionsExpanded\}\}"/);
  assert.match(css, /\.pending-collapse\s*\{[^}]*min-height:\s*48px/);
});

test("stocktake save button has a disabled visual state while submitting", () => {
  const markup = read("../pages/stocktake/stocktake.wxml");
  const css = read("../pages/stocktake/stocktake.wxss");
  assert.match(markup, /btn-primary \{\{submitting \? 'disabled' : ''\}\}/);
  assert.match(css, /\.btn\.disabled\s*\{[^}]*opacity/);
});

test("detail quantity mask closes on tap but protects dirty input", () => {
  const markup = read("../pages/medicine-detail/medicine-detail.wxml");
  const source = read("../pages/medicine-detail/medicine-detail.ts");
  assert.match(markup, /class="quantity-mask"[^>]*bindtap="onTapQuantityMask"/);
  assert.match(markup, /class="quantity-sheet"[^>]*catchtap="noop"[^>]*aria-role="dialog"/);
  assert.match(source, /onTapQuantityMask\(\): void/);
  assert.match(source, /请先取消或保存/);
});

test("plan page bottom padding follows font size instead of fixed px", () => {
  const css = read("../pages/medication-plans/medication-plans.wxss");
  assert.match(css, /\.page\s*\{[^}]*calc\(6\.5em \+ env\(safe-area-inset-bottom\)\)/);
  assert.doesNotMatch(css, /calc\(104px \+ env\(safe-area-inset-bottom\)\)/);
});

test("month-precision expiry keeps the package month explicit", async () => {
  const medicine = {
    id: "synthetic-month", name: "合成药品甲", specification: null, manufacturer: null,
    activeIngredients: [], purposeCategory: null, populationTags: [], purposeTags: [],
    batches: [{ id: "batch-month", lotNumber: null, expiry: { value: "2027-05", precision: "month" },
      expiryState: { state: "ok" }, quantity: 1, unit: "tablet", confirmedUnitsPerPackage: null,
      storageLocation: null, openedState: "unopened", version: 1 }],
    leaflet: { reviewStatus: "unverified", purposeSummary: null },
    stockStatus: { state: "ok" }, isArchived: false,
  };
  const { definition } = loadPage("pages/index/index.ts", { modules: {
    "../../services/api": {
      api: { getCurrentFamily: async () => ({ family: { name: "合成家庭" } }), listMedicines: async () => ({ medicines: [medicine] }) },
      ApiError: class extends Error {}, readToken: () => "token",
      captureSessionIdentity: () => ({ token: "token", generation: 1 }), isCurrentSession: () => true,
    },
    "../../services/auth": { ensureLoggedIn: async () => {} },
  } });
  const page = makePageContext(definition);
  await page.refresh();
  assert.equal(page.data.items.length, 1);
  assert.match(page.data.items[0].expiryDate, /^2027-05$/);
  assert.match(page.data.items[0].expirySuffix, /按包装月份/);
});