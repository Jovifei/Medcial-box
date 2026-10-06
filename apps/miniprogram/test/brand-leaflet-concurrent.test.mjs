import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { harness, edit, select } from "./photo-queue-test-harness.mjs";

for (const first of ["brand", "leafletText"]) test(`cross-page ${first} edit survives interleaved other-field update and fresh draft restore`, async () => {
  const h = harness(); const d = h.draft(); h.seed([d]);
  const a = h.a, b = h.page(); a.loadPhotoDrafts(); select(a, d.id); b.loadPhotoDrafts(); select(b, d.id);
  const second = first === "brand" ? "leafletText" : "brand";
  edit(a, first, `synthetic first ${first}`); edit(b, second, `synthetic second ${second}`);
  assert.equal(h.read()[0].fields[first], `synthetic first ${first}`);
  assert.equal(h.read()[0].fields[second], `synthetic second ${second}`);
  a.onShow(); await tick();
  assert.equal(a.data[first], `synthetic first ${first}`); assert.equal(a.data[second], `synthetic second ${second}`);
  edit(a, first, `synthetic final ${first}`);
  const restored = h.page(); restored.loadPhotoDrafts(); select(restored, d.id);
  assert.equal(restored.data[first], `synthetic final ${first}`); assert.equal(restored.data[second], `synthetic second ${second}`);
  assert.equal(h.read()[0].fields[second], `synthetic second ${second}`);
});

test("unacknowledged local brand edit survives remote leafletText update and fresh restore", async () => {
  let fail = false;
  const h = harness({ store: key => { if (fail && key === h.key) throw Error("synthetic storage full"); } });
  const d = h.draft(); h.seed([d]); h.a.loadPhotoDrafts(); select(h.a, d.id);
  fail = true; edit(h.a, "brand", "synthetic local brand");
  assert.notEqual(h.read()[0].fields.brand, "synthetic local brand"); fail = false;
  const b = h.page(); b.loadPhotoDrafts(); select(b, d.id); edit(b, "leafletText", "synthetic remote leaflet");
  h.a.onShow(); await tick();
  assert.equal(h.a.data.brand, "synthetic local brand"); assert.equal(h.a.data.leafletText, "synthetic remote leaflet");
  edit(h.a, "specification", "synthetic acknowledgement");
  const restored = h.page(); restored.loadPhotoDrafts(); select(restored, d.id);
  assert.equal(restored.data.brand, "synthetic local brand"); assert.equal(restored.data.leafletText, "synthetic remote leaflet");
});
