import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// T3 第二项（320 宽 / 200% 字号）：首页窄屏大字号下的四个可读性修复回归。
// 这些断言锚定样式与文案契约，防止回退；真实微信渲染验收仍按门槛在原生/真机复核。
const root = new URL("../", import.meta.url);
const read = path => fs.readFileSync(new URL(path, root), "utf8");

test("home keeps date-like values on one line instead of per-character wrapping", () => {
  const css = read("pages/index/index.wxss");
  const rule = css.match(/\.summary-primary, \.expiry-line\s*\{([^}]+)\}/);
  assert.ok(rule, "expiry summary rule must exist");
  // 日期“2026-05-12”等数字串不得逐字断行：不允许 anywhere/break-all 语义。
  assert.doesNotMatch(rule[1], /overflow-wrap:\s*(anywhere|break-all)/);
  assert.doesNotMatch(rule[1], /word-break:\s*break-all/);
});

test("home filter chips stay on one line inside the horizontal scroll", () => {
  const css = read("pages/index/index.wxss");
  const base = css.match(/\.filter-chip\s*\{([^}]+)\}/);
  assert.ok(base, "filter chip rule must exist");
  assert.match(base[1], /white-space:\s*nowrap/);
  const markup = read("pages/index/index.wxml");
  assert.match(markup, /<scroll-view class="filter-scroll" scroll-x/);
});

test("home bottom spacer grows with font size so the floating add button cannot cover the safety note", () => {
  const css = read("pages/index/index.wxss");
  const pageRule = css.match(/\.page\s*\{([^}]+)\}/);
  assert.ok(pageRule, "home page padding rule must exist");
  // em 随字号缩放（与 medicine-detail 的底部留白做法一致），不能用固定 100px。
  assert.match(pageRule[1], /padding:[^;]*calc\(\s*[\d.]+em\s*\+/, "bottom padding must scale with font size via em");
  assert.doesNotMatch(pageRule[1], /100px/);
  // 悬浮按钮保留最小触控高度且随内容增高（不含固定 height 或 line-height 锁死）。
  const floating = css.match(/\.floating-add\s*\{([^}]+)\}/);
  assert.ok(floating, "floating add rule must exist");
  assert.match(floating[1], /min-height:\s*48px/);
  assert.doesNotMatch(floating[1], /(^|[^-])height:\s*\d+px/);
  assert.doesNotMatch(floating[1], /line-height:\s*\d+px/);
});

test("home keeps the date token intact and stacks metrics at 320 wide", () => {
  const css = read("pages/index/index.wxss");
  assert.match(css, /\.expiry-date\s*\{[^}]*white-space:\s*nowrap/, "date token must not wrap");
  assert.match(css, /@media\s*\(max-width:\s*360px\)\s*\{[\s\S]*?\.medicine-summary\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    "summary metrics must stack on narrow screens");
  const markup = read("pages/index/index.wxml");
  assert.match(markup, /<text class="expiry-date">\{\{item\.expiryDate\}\}<\/text>/, "date must render in its own token");
});

test("home search placeholder fits narrow screens with large text", () => {
  const markup = read("pages/index/index.wxml");
  // 320px + 200% 下不再使用 13 字长占位；缩短后的占位仍是完整中文短语（无省略号）。
  assert.doesNotMatch(markup, /搜索药名、成分、厂家或位置/);
  const placeholder = markup.match(/placeholder="([^"]+)"/)?.[1];
  assert.ok(placeholder, "search placeholder must exist");
  assert.ok(!placeholder.includes("…"), "placeholder must not rely on ellipsis");
  // 测试断言与模板文案保持同步。
  const attention = read("test/cabinet-attention-view.test.mjs");
  assert.match(attention, new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
