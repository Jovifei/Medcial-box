import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const read = path => fs.readFileSync(new URL(path, root), "utf8");
const app = JSON.parse(read("app.json"));
const route = name => `pages/${name}/${name}`;
const expected = {
  login: "mine", "family-entry": "mine", index: "index", "family-create": "mine",
  "medicine-edit": "index", "medicine-detail": "index", "batch-edit": "index",
  "export-preview": "mine", invite: "mine", pending: "pending", "medication-plans": "plans",
  "plan-detail": "plans", "plan-create": "plans", "release-notes": "mine", "care-profiles": "mine",
  mine: "mine", "family-settings": "mine", "app-link": "mine", stocktake: "index", restock: "mine",
  trash: "mine", audit: "mine", "backup-restore": "mine", "notification-settings": "mine", "account-settings": "mine",
};
function fixture({ pages = [], dirty = null, confirm = true } = {}) {
  let definition;
  let stack = pages;
  const calls = [];
  vm.runInNewContext(ts.transpileModule(read("components/business-nav/business-nav.ts"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports: {}, Component: value => { definition = value; },
    getCurrentPages: () => { if (stack instanceof Error) throw stack; return stack; },
    require: name => {
      assert.equal(name, "../../services/draft-guard");
      return { peekDirtyDraft: () => dirty };
    },
    wx: {
      showModal: options => options.success({ confirm }),
      switchTab: options => calls.push(["tab", options.url]),
      navigateTo: options => calls.push(["page", options.url]),
      showToast: options => calls.push(["toast", options.title]),
    },
  });
  const component = { ...definition.methods, data: structuredClone(definition.data),
    setData(patch) { Object.assign(this.data, patch); } };
  return { component, calls, attach: () => definition.lifetimes.attached.call(component),
    show: () => definition.pageLifetimes.show.call(component), setStack(value) { stack = value; } };
}

test("all 25 registered routes have explicit direct-entry highlight ownership", () => {
  assert.equal(app.pages.length, 25);
  assert.deepEqual([...app.pages].sort(), Object.keys(expected).map(route).sort());
  for (const [name, tab] of Object.entries(expected)) {
    const f = fixture({ pages: [{ route: route(name) }] });
    f.attach();
    assert.equal(f.component.data.activeTab, tab, name);
  }
});

test("subpages retain the nearest primary tab and refresh on every show", () => {
  const tabs = { index: "index", "medication-plans": "plans", pending: "pending", mine: "mine" };
  const f = fixture();
  f.attach();
  for (const [primary, tab] of Object.entries(tabs)) {
    for (const name of Object.keys(expected).filter(name => !Object.hasOwn(tabs, name))) {
      f.setStack([{ route: route("mine") }, { route: route(primary) }, { route: route(name) }]);
      f.show();
      assert.equal(f.component.data.activeTab, tab, `${primary} -> ${name}`);
    }
  }
  f.setStack([{ route: route("mine") }, { route: route("invite") }]); f.show();
  assert.equal(f.component.data.activeTab, "mine");
  f.setStack([{ route: route("pending") }]); f.show();
  assert.equal(f.component.data.activeTab, "pending");
});

test("empty, unknown and unavailable page stacks fail safely to home", () => {
  const f = fixture();
  for (const stack of [[], [{ route: "pages/unknown/unknown" }], new Error("synthetic unavailable")]) {
    f.component.data.activeTab = "mine";
    f.setStack(stack); f.show();
    assert.equal(f.component.data.activeTab, "index");
  }
});

test("navigation retains busy, cancel and failed draft-save guards", async () => {
  const target = "/pages/index/index";
  const busy = fixture(); busy.component.data.busy = true;
  await busy.component.navigate(target, true); assert.deepEqual(busy.calls, []);
  const cancel = fixture({ dirty: { save: async () => assert.fail("cancel must not save") }, confirm: false });
  await cancel.component.navigate(target, true); assert.deepEqual(cancel.calls, []);
  assert.equal(cancel.component.data.busy, false);
  const failure = fixture({ dirty: { save: async () => { throw new Error("synthetic storage failure"); } } });
  await failure.component.navigate(target, true);
  assert.equal(failure.calls.filter(([type]) => type === "tab").length, 0);
  assert.equal(failure.component.data.busy, false);
  let saved = false;
  const success = fixture({ dirty: { save: async () => { saved = true; } } });
  for (const tab of app.tabBar.list) {
    await success.component.go({ currentTarget: { dataset: { url: `/${tab.pagePath}` } } });
  }
  assert.equal(saved, true);
  assert.deepEqual(success.calls, app.tabBar.list.map(tab => ["tab", `/${tab.pagePath}`]));
});

function contrast(a, b) {
  const luminance = hex => hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
test("native and business tabs share legible colors and retain footer structure", () => {
  const css = read("components/business-nav/business-nav.wxss");
  const normal = css.match(/\.business-nav-text\s*\{[^}]*color:\s*(#[\da-f]+)/i)[1];
  const active = css.match(/\.business-nav-tab\.active \.business-nav-text\s*\{[^}]*color:\s*(#[\da-f]+)/i)[1];
  assert.equal(normal, "#52685c"); assert.equal(normal, app.tabBar.color);
  assert.equal(active, "#3f7d5c"); assert.equal(active, app.tabBar.selectedColor);
  assert.ok(contrast(normal, "#ffffff") >= 4.5);
  assert.ok(contrast(active, "#ffffff") >= 4.5);
  assert.doesNotMatch(css, /!important/);
  assert.match(css, /\.business-nav-tab\s*\{[^}]*width:\s*25%[^}]*min-height:\s*96rpx/);
  assert.match(css, /flex-wrap:\s*nowrap/);
  assert.match(css, /padding-bottom:\s*env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.business-nav-wrapper\s*\{\s*position:\s*fixed/);
  assert.match(css, /\.business-nav-wrapper\.embedded\s*\{\s*position:\s*static/);
  const markup = read("components/business-nav/business-nav.wxml");
  assert.equal((markup.match(/<button\b/g) ?? []).length, 4);
  assert.equal((markup.match(/disabled="\{\{busy\}\}"/g) ?? []).length, 4);
});
