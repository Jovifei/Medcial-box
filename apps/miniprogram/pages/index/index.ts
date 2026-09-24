import { api } from "../../services/api";
import { ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import type {
  ExpiryState,
  MedicationSummary,
  QuantityUnit,
} from "../../services/api-types";

interface CabinetItem {
  id: string;
  name: string;
  specification: string;
  purpose: string;
  quantityText: string;
  expiryText: string;
  state: ExpiryState;
  isExample: boolean;
}

const UNIT_SHORT: Record<QuantityUnit, string> = {
  tablet: "片",
  capsule: "粒",
  sachet: "袋",
  bottle: "瓶",
  box: "盒",
  other: "份",
};

// 合成示例兜底：服务不可用时展示，并始终带"合成数据"标注，不冒充真实库存。
const exampleItems: CabinetItem[] = [
  {
    id: "example-1",
    name: "示例：对乙酰氨基酚片",
    specification: "0.5 g × 12 片",
    purpose: "示例用途：缓解疼痛、退热",
    quantityText: "剩余：6 片（合成数据）",
    expiryText: "有效期：2026-10（合成数据）",
    state: "expiring_soon",
    isExample: true,
  },
  {
    id: "example-2",
    name: "示例：感冒颗粒",
    specification: "每袋 10 g",
    purpose: "用途待确认",
    quantityText: "剩余：数量未知（合成数据）",
    expiryText: "有效期：待补充（合成数据）",
    state: "unknown",
    isExample: true,
  },
];

function quantitySummary(medicine: MedicationSummary): string {
  if (medicine.batches.length === 0) return "暂无批次记录";
  const parts = medicine.batches.map((batch) => {
    if (batch.quantity === null) return "数量未知";
    if (batch.quantity === 0) return "已耗尽";
    return `${batch.quantity}${UNIT_SHORT[batch.unit] ?? "份"}`;
  });
  return `数量：${parts.join(" / ")}`;
}

function purposeText(medicine: MedicationSummary): string {
  if (medicine.purposeCategory !== null && medicine.purposeCategory !== "") {
    return medicine.purposeCategory;
  }
  if (medicine.leaflet.purposeSummary !== null && medicine.leaflet.purposeSummary !== "") {
    return medicine.leaflet.purposeSummary;
  }
  return "用途待确认";
}

function toCabinetItem(medicine: MedicationSummary): CabinetItem {
  return {
    id: medicine.id,
    name: medicine.name,
    specification: medicine.specification ?? "规格未记录",
    purpose: purposeText(medicine),
    quantityText: quantitySummary(medicine),
    expiryText: medicine.expiryState?.label ?? "有效期未知",
    state: medicine.expiryState?.state ?? "unknown",
    isExample: false,
  };
}

interface IndexPageData {
  stageLabel: string;
  isExample: boolean;
  isFiltered: boolean;
  expiringCount: number;
  expiredCount: number;
  keyword: string;
  familyName: string;
  items: CabinetItem[];
  allItems: CabinetItem[];
}

Page({
  data: {
    stageLabel: "药箱首页",
    isExample: true,
    isFiltered: false,
    expiringCount: 0,
    expiredCount: 0,
    keyword: "",
    familyName: "",
    items: exampleItems,
    allItems: exampleItems,
  },

  onShow() {
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh());
  },

  async refresh(): Promise<void> {
    try {
      await ensureLoggedIn();
    } catch {
      this.useExampleData("服务不可用，展示合成示例");
      return;
    }
    try {
      const family = await api.getCurrentFamily();
      const list = await api.listMedicines();
      this.applyMedicines(list.medicines, family.family.name);
    } catch (error) {
      if (error instanceof ApiError && error.code === "FAMILY_NOT_FOUND") {
        // 尚未创建家庭：引导到创建页。
        wx.navigateTo({ url: "/pages/family-create/family-create" });
        return;
      }
      this.useExampleData("服务不可用，展示合成示例");
    }
  },

  applyMedicines(medicines: MedicationSummary[], familyName: string): void {
    const allItems = medicines.map(toCabinetItem);
    let expiredCount = 0;
    let expiringCount = 0;
    for (const medicine of medicines) {
      const state = medicine.expiryState?.state ?? "unknown";
      if (state === "expired") expiredCount += 1;
      else if (state === "due_this_month" || state === "expiring_soon") expiringCount += 1;
    }
    this.setData({ isExample: false, familyName, allItems, expiredCount, expiringCount });
    this.applyFilter();
  },

  useExampleData(label: string): void {
    this.setData({
      stageLabel: label,
      isExample: true,
      familyName: "",
      allItems: exampleItems,
      expiredCount: 0,
      expiringCount: 1,
    });
    this.applyFilter();
  },

  applyFilter(): void {
    const keyword = (this.data as IndexPageData).keyword.trim();
    const allItems = (this.data as IndexPageData).allItems;
    const items =
      keyword === "" ? allItems : allItems.filter((item) => item.name.includes(keyword));
    this.setData({ items, isFiltered: keyword !== "" });
  },

  onSearchInput(event: { detail: { value: string } }): void {
    this.setData({ keyword: event.detail.value });
    this.applyFilter();
  },

  onTapMedicine(event: { currentTarget: { dataset: { id?: string } } }): void {
    const id = event.currentTarget.dataset.id;
    if (!id || id.startsWith("example-")) return;
    wx.navigateTo({ url: `/pages/medicine-detail/medicine-detail?id=${id}` });
  },

  onTapAdd(): void {
    wx.navigateTo({ url: "/pages/medicine-edit/medicine-edit" });
  },

  onTapExport(): void {
    wx.navigateTo({ url: "/pages/export-preview/export-preview" });
  },

  onTapInvite(): void {
    wx.navigateTo({ url: "/pages/invite/invite" });
  },
});
