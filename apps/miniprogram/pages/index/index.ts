import { api, ApiError, readToken } from "../../services/api";
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
  errorMessage: string;
}

Page({
  data: {
    stageLabel: "药箱首页",
    isExample: false,
    isFiltered: false,
    expiringCount: 0,
    expiredCount: 0,
    keyword: "",
    familyName: "",
    items: [] as CabinetItem[],
    allItems: [] as CabinetItem[],
    errorMessage: "",
  },

  redirecting: false,

  onShow() {
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh());
  },

  async refresh(): Promise<void> {
    if (readToken() === "") {
      if (!this.redirecting) {
        this.redirecting = true;
        wx.reLaunch({ url: "/pages/login/login" });
      }
      return;
    }
    try {
      await ensureLoggedIn({ allowInteractive: false });
    } catch (error) {
      if (error instanceof ApiError && (error.statusCode === 401 || error.code === "UNAUTHENTICATED")) {
        if (!this.redirecting) {
          this.redirecting = true;
          wx.reLaunch({ url: "/pages/login/login" });
        }
        return;
      }
      this.showUnavailable(error);
      return;
    }
    try {
      const family = await api.getCurrentFamily();
      const list = await api.listMedicines();
      this.applyMedicines(list.medicines, family.family.name);
    } catch (error) {
      if (error instanceof ApiError && error.code === "FAMILY_NOT_FOUND") {
        // 尚未创建或加入家庭：先让用户选择创建还是加入。
        wx.navigateTo({ url: "/pages/family-entry/family-entry" });
        return;
      }
      this.showUnavailable(error);
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
    this.setData({ isExample: false, familyName, allItems, expiredCount, expiringCount, errorMessage: "", stageLabel: "药箱首页" });
    this.applyFilter();
  },

  showUnavailable(error: unknown): void {
    const message = error instanceof ApiError ? error.message : "服务暂时不可用，请稍后重试";
    this.setData({
      stageLabel: "暂时无法连接",
      isExample: false,
      familyName: "",
      allItems: [],
      items: [],
      expiredCount: 0,
      expiringCount: 0,
      errorMessage: message,
    });
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

  onRetry(): void {
    this.refresh();
  },
});
