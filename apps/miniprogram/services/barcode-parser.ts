export interface ParsedBarcodeResult {
  raw: string;
  queryBarcode: string | null;
  kind: "standard" | "gs1" | "traceability_unextracted" | "unsupported";
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
 * 解析商品条码和结构明确的 GS1 复合码；追溯码保留原文供人工核对。
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
  const clean = raw.replace(/^\][A-Za-z0-9]{2}/, "").trim();

  // 3. GS1 AI (应用标识符) 结构化条码解析
  // 支持括号形式 (01)...(17)...(10)... 以及连续无括号形式 01...17...10/21...
  let gs1Gtin: string | null = null;
  let gs1Expiry: { value: string; precision: "day" | "month" } | undefined;
  let gs1Lot: string | undefined;
  let invalidExpiry = false;

  // 检查是否包含括号形式 AI
  const paren01 = clean.match(/^\(01\)([0-9]{14})(?:\(17\)[0-9]{6})?(?:\(10\)[a-zA-Z0-9_-]{1,20})?$/);
  const paren17 = clean.match(/\(17\)([0-9]{6})/);
  const paren10 = clean.match(/\(10\)([a-zA-Z0-9_-]+)/);
  if (paren01) {
    gs1Gtin = paren01[1];
    if (paren17) {
      gs1Expiry = parseGs1Date(paren17[1]);
      invalidExpiry = !gs1Expiry;
    }
    if (paren10) gs1Lot = paren10[1];
  } else if (/^01[0-9]{14}/.test(clean)) {
    // 连续无括号 GS1: 01 后紧跟 14 位 GTIN。变长 AI 只能是最后一段：
    // 批号(10)或序列号(21)。序列号不是批号，不回填批次字段。
    gs1Gtin = clean.slice(2, 16);
    const rest = clean.slice(16);
    if (!/^(?:17[0-9]{6})?(?:10[a-zA-Z0-9_-]{1,20}|21[a-zA-Z0-9_-]{1,24})?$/.test(rest)) {
      // 结构不完整时不再直接拒绝：药盒常把商品码与序列号印在同一条码上
      // （Jovi 2026-10-25 决策）。只要 01 后 14 位通过 GTIN 校验位就提取
      // 商品码查询候选，其余内容仅作提示核对，不回填批次/有效期。
      const extracted = extractLeadingGtin(raw, clean);
      if (extracted) return extracted;
      return { raw, queryBarcode: null, kind: "unsupported", statusText: UNSUPPORTED_CATALOG_CODE };
    }
    const dateMatch = rest.match(/17([0-9]{6})/);
    if (dateMatch) {
      gs1Expiry = parseGs1Date(dateMatch[1]);
      invalidExpiry = !gs1Expiry;
    }
    const lotMatch = rest.match(/10([a-zA-Z0-9_-]{1,20})/);
    if (lotMatch) gs1Lot = lotMatch[1];
  } else if (/^[0-9]{15,48}$/.test(clean)) {
    // 无 01 前缀的长数字串：追溯码常见形态是"14 位商品码 + 序列号"。
    // 只有前 14 位通过 GTIN 校验位才提取（Jovi 2026-10-25 决策），
    // 校验不过仍按追溯码保留原码，不猜测内部片段。
    const extracted = extractLeadingGtin(raw, clean);
    if (extracted) return extracted;
    return { raw, queryBarcode: null, kind: "traceability_unextracted", statusText: UNSUPPORTED_CATALOG_CODE };
  }

  if (gs1Gtin) {
    if (!hasValidGtinCheckDigit(gs1Gtin)) {
      return { raw, queryBarcode: null, kind: "unsupported", statusText: UNSUPPORTED_CATALOG_CODE };
    }
    if (invalidExpiry) {
      return {
        raw,
        queryBarcode: null,
        kind: "unsupported",
        statusText: "GS1 码内有效期无效，原码已保留；请对照药盒手动核对或重新扫描。",
      };
    }
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

  // 4. 其他非纯数字或不支持的条码
  return {
    raw,
    queryBarcode: null,
    kind: "unsupported",
    statusText: UNSUPPORTED_CATALOG_CODE,
  };
}

/**
 * 长数字串的商品码提取：优先按 AI(01)+14 位读，其次按"前 14 位即 GTIN-14"读。
 * 只有 GTIN 校验位通过才返回提取结果；序列号等其余内容不回填任何批次字段。
 */
function extractLeadingGtin(raw: string, clean: string): ParsedBarcodeResult | null {
  const candidates: string[] = [];
  if (/^01[0-9]{14}/.test(clean)) candidates.push(clean.slice(2, 16));
  if (/^[0-9]{14}/.test(clean)) candidates.push(clean.slice(0, 14));
  for (const gtin of candidates) {
    if (!hasValidGtinCheckDigit(gtin)) continue;
    const query = gtin.startsWith("0") ? gtin.slice(1) : gtin;
    return {
      raw,
      queryBarcode: query,
      kind: "gs1",
      statusText: `已从追溯码中提取商品码 ${query}（请核对包装）；正在查询候选…`,
    };
  }
  return null;
}

function hasValidGtinCheckDigit(digits: string): boolean {
  if (!/^[0-9]{14}$/.test(digits)) return false;
  const sum = [...digits.slice(0, -1)].reverse()
    .reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - sum % 10) % 10 === Number(digits.at(-1));
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
  if (dd > new Date(Date.UTC(year, mm, 0)).getUTCDate()) return undefined;
  const dayStr = String(dd).padStart(2, "0");
  return { value: `${year}-${monthStr}-${dayStr}`, precision: "day" };
}
