// 结构化标签的导出文案：值域与 contracts 的 PurposeTag/PopulationTag 白名单一致
// （apps/api/src/inputs.ts 校验、小程序 services/medicine-tags.ts 同源维护）。
// 导出面向家人与外部 AI，输出中文标签；未知值原样保留便于发现数据异常。
const PURPOSE_TAG_LABELS: Record<string, string> = {
  fever: "发热",
  cough: "咳嗽",
  throat: "咽喉",
  nasal: "鼻部",
  gastro: "胃肠",
  pain: "疼痛",
  topical: "外用",
  allergy: "抗过敏",
  itch: "止痒",
  eye: "眼部",
  oral: "口腔",
  constipation: "便秘",
  diarrhea: "腹泻",
  other: "其他",
};

const POPULATION_TAG_LABELS: Record<string, string> = {
  adult: "成人",
  child: "儿童",
};

export function purposeTagLabel(tag: string): string {
  return Object.hasOwn(PURPOSE_TAG_LABELS, tag) ? PURPOSE_TAG_LABELS[tag] : tag;
}

export function populationTagLabel(tag: string): string {
  return Object.hasOwn(POPULATION_TAG_LABELS, tag) ? POPULATION_TAG_LABELS[tag] : tag;
}
