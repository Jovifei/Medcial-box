import { open, rename, unlink, mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readLocalCatalog, validateLocalCatalog, LOCAL_CATALOG_MAX_BYTES } from "../apps/api/dist/services/local-medicine-catalog.js";

export async function importLocalCatalog(input, output) {
  if (!isAbsolute(input) || !isAbsolute(output) || input === output) throw new Error("输入与输出须为不同的绝对路径");
  const incoming = await readLocalCatalog(input);
  await mkdir(dirname(output), { recursive: true });
  const lockPath = `${output}.lock`;
  let lock;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { lock = await open(lockPath, "wx"); break; }
    catch (error) { if (error.code !== "EEXIST") throw error; await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  if (!lock) throw new Error("商品资料库正在导入，请稍后重试");
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    let existing = { version: 1, entries: [] };
    try { existing = await readLocalCatalog(output); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const entries = new Map(existing.entries.map(entry => [entry.barcodeValue, entry]));
    for (const entry of incoming.entries) entries.set(entry.barcodeValue, entry);
    const document = validateLocalCatalog({ version: 1, entries: [...entries.values()] });
    const content = JSON.stringify(document, null, 2) + "\n";
    if (Buffer.byteLength(content) > LOCAL_CATALOG_MAX_BYTES) throw new Error("合并商品资料库超过5MB");
    const file = await open(temporary, "wx");
    try { await file.writeFile(content, "utf8"); await file.sync(); } finally { await file.close(); }
    await rename(temporary, output);
    return { imported: incoming.entries.length, total: document.entries.length };
  } finally {
    try { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    finally { await lock.close(); await unlink(lockPath); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const input = args[args.indexOf("--input") + 1];
  const output = args[args.indexOf("--output") + 1];
  try {
    if (!args.includes("--input") || !args.includes("--output")) throw new Error("用法：node scripts/import-local-medicine-catalog.mjs --input ABSOLUTE.json --output ABSOLUTE.json");
    console.log(JSON.stringify(await importLocalCatalog(input, output)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
