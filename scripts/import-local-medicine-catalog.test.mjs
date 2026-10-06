import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importLocalCatalog } from "./import-local-medicine-catalog.mjs";

test("concurrent catalog imports preserve both reviewed products and upsert exact barcode", async () => {
  const folder = await mkdtemp(join(tmpdir(), "jf-catalog-import-"));
  try {
    const first = join(folder, "first.json"), second = join(folder, "second.json"), output = join(folder, "catalog.json");
    const entry = { barcodeValue: "6900000000001", name: "合成药一", source: "合成测试", reviewed: true };
    await writeFile(first, JSON.stringify({ version: 1, entries: [entry] }));
    await writeFile(second, JSON.stringify({ version: 1, entries: [{ ...entry, barcodeValue: "6900000000002", name: "合成药二" }] }));
    await Promise.all([importLocalCatalog(first, output), importLocalCatalog(second, output)]);
    assert.equal(JSON.parse(await readFile(output, "utf8")).entries.length, 2);
    await writeFile(first, JSON.stringify({ version: 1, entries: [{ ...entry, name: "合成药一改" }] }));
    await importLocalCatalog(first, output);
    const stored = JSON.parse(await readFile(output, "utf8"));
    assert.equal(stored.entries.length, 2);
    assert.equal(stored.entries.find(value => value.barcodeValue === entry.barcodeValue).name, "合成药一改");
    const before = await readFile(output, "utf8");
    await writeFile(first, JSON.stringify({ version: 1, entries: [{ ...entry, person: "不允许" }] }));
    await assert.rejects(importLocalCatalog(first, output));
    assert.equal(await readFile(output, "utf8"), before);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
