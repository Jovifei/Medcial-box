import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../pages/medication-plans/medication-plans.wxss", import.meta.url), "utf8");
const markup = readFileSync(new URL("../pages/medication-plans/medication-plans.wxml", import.meta.url), "utf8");

test("narrow plan date has its own unbroken row with reachable date controls", () => {
  assert.match(css, /@media\s*\(max-width:\s*420px\)\s*\{[\s\S]*?\.date-row\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.date-current\s*\{[^}]*order:\s*-1;[^}]*flex-basis:\s*100%;[^}]*white-space:\s*nowrap/);
  assert.match(css, /\.date-shift\s*\{[^}]*min-width:\s*48px;[^}]*min-height:\s*48px/);
  assert.match(markup, /data-delta="-1"\s+bindtap="onShiftDate"/);
  assert.match(markup, /data-delta="1"\s+bindtap="onShiftDate"/);
});

test("plan retains scalable bottom space and its safety note", () => {
  assert.match(css, /\.page\s*\{[^}]*calc\(6\.5em \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(markup, /class="safety-note"[\s\S]*?不自动扣减库存/);
  assert.match(markup, /class="floating-add"\s+bindtap="onOpenCreateForm"/);
});
