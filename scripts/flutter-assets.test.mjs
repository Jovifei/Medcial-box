import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const flutterRoot = join(import.meta.dirname, "..", "apps", "flutter");
test("runtime license stays bundled while the large font remains a host-test fixture", async () => {
  const manifest = await readFile(join(flutterRoot, "pubspec.yaml"), "utf8");
  assert.match(manifest, /^\s+- assets\/fonts\/NotoSansSC-OFL\.txt$/m);
  assert.doesNotMatch(manifest, /^\s+- (?:asset:\s*)?assets\/fonts\/MedBoxSansSC-Regular\.ttf$/m);
  assert.ok((await stat(join(flutterRoot, "assets/fonts/MedBoxSansSC-Regular.ttf"))).size > 0);
  for (const name of ["pdf_export_test.dart", "medicine_entry_layout_test.dart"]) {
    const source = await readFile(join(flutterRoot, "test", name), "utf8");
    assert.match(source, /loadChineseFontFixture\(\)/);
    assert.doesNotMatch(source, /rootBundle\.load\(['"]assets\/fonts\/MedBoxSansSC-Regular\.ttf/);
  }
});
