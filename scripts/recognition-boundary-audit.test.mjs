import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("recognition pipeline keeps draft and confirmation boundary", async () => {
  const source = await readFile("apps/api/src/services/medicine-recognition.ts", "utf8");
  assert.match(source, /requiresConfirmation/);
  assert.match(source, /context_limit/);
  assert.match(source, /invalid_json/);
  assert.match(source, /temperature: 0/);
  assert.doesNotMatch(source, /auto.*save|auto.*commit/i);
});

test("recognition prompt does not infer dosage from duration", async () => {
  const source = await readFile("apps/api/src/services/medicine-recognition.ts", "utf8");
  assert.match(source, /12小时、24小时是持续时间/);
  assert.match(source, /不要推断未见的日期、数量、服用剂量/);
});
