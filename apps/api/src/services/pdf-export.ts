import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { InventoryExportSnapshot } from "./export-snapshot.js";
import { EXPORT_COLUMNS, inventoryExportRows } from "./csv-export.js";

/** Same OFL Chinese font as Android, with real embedded text and pagination. */
export async function renderPdfExport(snapshot: InventoryExportSnapshot): Promise<Uint8Array> {
 const document = await PDFDocument.create();
 document.registerFontkit(fontkit);
 const bytes = await readFile(new URL("../../assets/fonts/MedBoxSansSC-Regular.ttf", import.meta.url));
 const font = await document.embedFont(bytes, { subset: true });
 const supported = new Set(font.getCharacterSet());
 const plain = (value: string): string => [...value.replace(/[\r\t]/g, " ")].map((character) => character === "\n" || supported.has(character.codePointAt(0)!) ? character : "□").join("");
 const width = 595; const height = 842; const margin = 40; const size = 10; const leading = 15;
 let page = document.addPage([width, height]); let y = height - margin;
 const write = (text: string): void => {
  for (const paragraph of plain(text).split("\n")) {
   let line = "";
   const flush = (): void => {
    if (y < margin) { page = document.addPage([width, height]); y = height - margin; }
    if (line !== "") page.drawText(line, { x: margin, y, font, size });
    y -= leading; line = "";
   };
   for (const character of paragraph) {
    if (font.widthOfTextAtSize(line + character, size) > width - 2 * margin) flush();
    line += character;
   }
   flush();
  }
 };
 write("家庭药箱库存清单"); write(`快照时间：${snapshot.generatedAt}`);
 write("信息仅供家庭管理参考，以说明书和医嘱为准。");
 write(`个人剂量备注：${snapshot.options.includePersonalDosage ? "仅包含当前用户可见备注" : "未包含"}`);
 for (const row of inventoryExportRows(snapshot)) {
  write(""); row.forEach((value, index) => { if (value !== "") write(`${EXPORT_COLUMNS[index]}：${value}`); });
 }
 document.setTitle("家庭药箱库存清单"); document.setCreationDate(new Date(snapshot.generatedAt));
 return document.save();
}
