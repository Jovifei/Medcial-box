interface CabinetPreviewItem {
  id: string;
  name: string;
  specification: string;
  purpose: string;
  quantityText: string;
  expiryText: string;
  expiryState: "soon" | "normal";
  isExample: boolean;
}

// 使用显式类型注解而非 satisfies，兼容较旧版本的微信开发者工具 TypeScript 编译插件。
const exampleItems: CabinetPreviewItem[] = [
  {
    id: "example-1",
    name: "示例：对乙酰氨基酚片",
    specification: "0.5 g × 12 片",
    purpose: "示例用途：缓解疼痛、退热",
    quantityText: "剩余：6 片（合成数据）",
    expiryText: "有效期：2026-10（合成数据）",
    expiryState: "soon",
    isExample: true,
  },
  {
    id: "example-2",
    name: "示例：感冒颗粒",
    specification: "每袋 10 g",
    purpose: "用途待确认",
    quantityText: "剩余：数量未知（合成数据）",
    expiryText: "有效期：待补充",
    expiryState: "normal",
    isExample: true,
  },
];

Page({
  data: {
    stageLabel: "项目骨架预览",
    exampleLabel: "合成示例",
    expiringCount: 1,
    items: exampleItems,
  },
});
