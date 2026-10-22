export interface ParsedBarcodeResult {
  raw: string;
  queryBarcode: string | null;
  kind: "standard" | "extracted_69" | "gs1" | "traceability_unextracted" | "unsupported";
  statusText: string;
  extractedLotNumber?: string;
  extractedExpiry?: {
    value: string;
    precision: "day" | "month";
  };
}

export const UNSUPPORTED_CATALOG_CODE =
  "此码可能是追溯码或其他标识；当前资料服务仅支持8–14位数字商品条码。20位码可能是追溯码，不按商品条码查询。原码已保留，可拍药盒尝试生成待核对草稿，或手动填写。";

/**
 * 智能解析扫描读取的药品条码、GS1复合码或20位药品监管追溯码。
 * 当存在前缀/后缀或嵌入的 13 位 69 商品条码时，自动截取有效数字进行资料检索。
 */
export function parseMedicineBarcode(input: string): ParsedBarcodeResult {
  const raw = (input ?? "").trim();
  if (!raw) {
    return {
      raw: "",
      queryBarcode: null,
      kind: "unsupported",
      statusText: "没有读到条码，请重试或手动录入。",
    };
  }

  // 1. 标准 8-14 位纯数字条码（EAN-8, UPC-A, EAN-13, GTIN-14）
  if (/^[0-9]{8,14}$/.test(raw)) {
    return {
      raw,
      queryBarcode: raw,
      kind: "standard",
      statusText: `已读取商品码 ${raw}，正在查询候选…`,
    };
  }

  // 2. 清理常见条码枪/扫描仪的 AIM Symbology 标识符（如 ]C1, ]d2, ]Q3, ]e0）
  let clean = raw.replace(/^\][A-Za-z0-9]{2}/, "").trim();

  // 3. GS1 AI (应用标识符) 结构化条码解析
  // 支持括号形式 (01)...(17)...(10)... 以及连续无括号形式 01...17...10...
  let gs1Gtin: string | null = null;
  let gs1Expiry: { value: string; precision: "day" | "month" } | undefined;
  let gs1Lot: string | undefined;

  // 检查是否包含括号形式 AI
  const paren01 = clean.match(/\(01\)([0-9]{14})/);
  const paren17 = clean.match(/\(17\)([0-9]{6})/);
  const paren10 = clean.match(/\(10\)([a-zA-Z0-9_\-]+)/);
  if (paren01) {
    gs1Gtin = paren01[1];
    if (paren17) gs1Expiry = parseGs1Date(paren17[1]);
    if (paren10) gs1Lot = paren10[1];
  } else if (/^01[0-9]{14}/.test(clean)) {
    // 连续无括号 GS1: 01 后紧跟 14 位 GTIN
    gs1Gtin = clean.slice(2, 16);
    const rest = clean.slice(16);
    const dateMatch = rest.match(/17([0-9]{6})/);
    if (dateMatch) gs1Expiry = parseGs1Date(dateMatch[1]);
    const lotMatch = rest.match(/10([a-zA-Z0-9_\-]{1,20})/);
    if (lotMatch) gs1Lot = lotMatch[1];
  }

  if (gs1Gtin) {
    // GTIN-14 如果以 0 开头且后面是 13 位，提取为 13 位商品码（EAN-13）
    const query = gs1Gtin.startsWith("0") ? gs1Gtin.slice(1) : gs1Gtin;
    return {
      raw,
      queryBarcode: query,
      kind: "gs1",
      statusText: `已从 GS1 复合码中提取商品码 ${query}，正在查询候选…`,
      extractedLotNumber: gs1Lot,
      extractedExpiry: gs1Expiry,
    };
  }

  // 4. 包含 13 位以 69 开头的中国商品条形码（690-699）
  // 常见于：
  // - 20位药品追溯码内部嵌入了 13 位商品码（如 81093690127825858280 -> 6901278258582）
  // - 包装码附带批次/序列号的组合条码
  const match69 = clean.match(/69[0-9]{11}/);
  if (match69) {
    const extracted = match69[0];
    return {
      raw,
      queryBarcode: extracted,
      kind: "extracted_69",
      statusText: `已从包装码中截取有效商品码 ${extracted}，正在查询候选…`,
    };
  }

  // 5. 纯 20 位数字（中国药品追溯码/电子监管码，未嵌入 69 商品码）
  if (/^[0-9]{20}$/.test(clean)) {
    return {
      raw,
      queryBarcode: null,
      kind: "traceability_unextracted",
      statusText: UNSUPPORTED_CATALOG_CODE,
    };
  }

  // 6. 其他非纯数字或不支持的条码
  return {
    raw,
    queryBarcode: null,
    kind: "unsupported",
    statusText: UNSUPPORTED_CATALOG_CODE,
  };
}

function parseGs1Date(yyMMdd: string): { value: string; precision: "day" | "month" } | undefined {
  if (yyMMdd.length !== 6 || !/^\d{6}$/.test(yyMMdd)) return undefined;
  const yy = Number(yyMMdd.slice(0, 2));
  const mm = Number(yyMMdd.slice(2, 4));
  const dd = Number(yyMMdd.slice(4, 6));
  if (mm < 1 || mm > 12) return undefined;
  const year = yy >= 50 ? 1900 + yy : 2000 + yy;
  const monthStr = String(mm).padStart(2, "0");
  if (dd === 0) {
    return { value: `${year}-${monthStr}`, precision: "month" };
  }
  const dayStr = String(Math.min(31, Math.max(1, dd))).padStart(2, "0");
  return { value: `${year}-${monthStr}-${dayStr}`, precision: "day" };
}
