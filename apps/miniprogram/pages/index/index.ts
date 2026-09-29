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
  stateClass: string;
  stateLabel: string;
  stockState: string;
  needsInfo: boolean;
  searchText: string;
  isExample: boolean;
}

type CabinetFilter = "all" | "expiring" | "low" | "missing";

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
  const activeExpiryStates = medicine.batches.map((batch) => batch.managementExpiryState?.state ?? batch.expiryState.state);
  const severity: Record<ExpiryState, number> = { expired: 0, due_this_month: 1, expiring_soon: 2, ok: 3, unknown: 4 };
  const state = activeExpiryStates.length > 0
    ? [...activeExpiryStates].sort((left, right) => severity[left] - severity[right])[0]
    : medicine.expiryState?.state ?? "unknown";
  const dateRecords = medicine.batches.map((batch) => ({
    date: batch.managementExpiryDate ?? batch.expiry.value,
    label: batch.managementExpiryState?.label ?? batch.expiryState.label,
  })).filter((item): item is { date: string; label: string } => item.date !== null);
  dateRecords.sort((left, right) => left.date.localeCompare(right.date));
  const stateLabels: Record<ExpiryState, string> = {
    expired: "已过期或开封期限已到",
    due_this_month: "本月到期",
    expiring_soon: "30 天内到期",
    ok: "有效期正常",
    unknown: "有效期未知",
  };
  return {
    id: medicine.id,
    name: medicine.name,
    specification: medicine.specification ?? "规格未记录",
    purpose: purposeText(medicine),
    quantityText: quantitySummary(medicine),
    expiryText: dateRecords.length > 0 ? `最早需处理：${dateRecords[0].date}` : medicine.expiryState?.label ?? "有效期未知",
    state,
    stateClass: state === "due_this_month" ? "due" : state === "expiring_soon" ? "soon" : state,
    stateLabel: stateLabels[state],
    stockState: medicine.stockStatus?.state ?? "unknown",
    needsInfo: medicine.specification === null || medicine.manufacturer === null ||
      medicine.activeIngredients.length === 0 || medicine.leaflet.reviewStatus === "unverified",
    searchText: [medicine.name, medicine.specification, medicine.manufacturer,
      medicine.approvalNumber, ...medicine.activeIngredients,
      ...medicine.batches.map((batch) => batch.storageLocation)]
      .filter((value): value is string => typeof value === "string")
      .join(" ").toLocaleLowerCase(),
    isExample: false,
  };
}

interface IndexPageData {
  stageLabel: string;
  isExample: boolean;
  isFiltered: boolean;
  expiringCount: number;
  expiredCount: number;
  lowStockCount: number;
  missingInfoCount: number;
  keyword: string;
  filterKind: CabinetFilter;
  filters: Array<{ id: CabinetFilter; label: string; count: number }>;
  familyName: string;
  items: CabinetItem[];
  allItems: CabinetItem[];
  errorMessage: string;
  entrySheetVisible: boolean;
}

Page({
  data: {
    stageLabel: "药箱首页",
    isExample: false,
    isFiltered: false,
    expiringCount: 0,
    expiredCount: 0,
    lowStockCount: 0,
    missingInfoCount: 0,
    keyword: "",
    filterKind: "all" as CabinetFilter,
    filters: [] as Array<{ id: CabinetFilter; label: string; count: number }>,
    familyName: "",
    items: [] as CabinetItem[],
    allItems: [] as CabinetItem[],
    errorMessage: "",
    entrySheetVisible: false,
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
    for (const item of allItems) {
      const state = item.state;
      if (state === "expired") expiredCount += 1;
      else if (state === "due_this_month" || state === "expiring_soon") expiringCount += 1;
    }
    this.setData({ isExample: false, familyName, allItems, expiredCount, expiringCount, errorMessage: "", stageLabel: "药箱首页" });
    const lowStockCount = allItems.filter((item) => item.stockState === "low").length;
    const missingInfoCount = allItems.filter((item) => item.needsInfo).length;
    this.setData({
      lowStockCount,
      missingInfoCount,
      filters: [
        { id: "expiring", label: "临期 / 过期", count: expiredCount + expiringCount },
        { id: "low", label: "库存不足", count: lowStockCount },
        { id: "missing", label: "待补资料", count: missingInfoCount },
      ],
    });
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
      lowStockCount: 0,
      missingInfoCount: 0,
      errorMessage: message,
    });
  },

  applyFilter(): void {
    const data = this.data as IndexPageData;
    const keyword = data.keyword.trim().toLocaleLowerCase();
    const items = data.allItems.filter((item) => {
      const matchesKeyword = keyword === "" || item.searchText.includes(keyword);
      const matchesFilter = data.filterKind === "all" ||
        (data.filterKind === "expiring" && (item.state === "expired" || item.state === "due_this_month" || item.state === "expiring_soon")) ||
        (data.filterKind === "low" && item.stockState === "low") ||
        (data.filterKind === "missing" && item.needsInfo);
      return matchesKeyword && matchesFilter;
    });
    this.setData({ items, isFiltered: keyword !== "" || data.filterKind !== "all" });
  },

  onSelectFilter(event: { currentTarget: { dataset: { kind?: CabinetFilter } } }): void {
    const selected = event.currentTarget.dataset.kind;
    if (!selected) return;
    const current = (this.data as IndexPageData).filterKind;
    this.setData({ filterKind: current === selected ? "all" : selected });
    this.applyFilter();
  },

  onClearFilters(): void {
    this.setData({ keyword: "", filterKind: "all" });
    this.applyFilter();
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
    this.setData({ entrySheetVisible: true });
  },

  onCloseEntrySheet(): void {
    this.setData({ entrySheetVisible: false });
  },

  onSelectEntry(event: { currentTarget: { dataset: { action?: string } } }): void {
    const action = event.currentTarget.dataset.action;
    this.setData({ entrySheetVisible: false });
    if (action === "camera" || action === "album") {
      wx.navigateTo({ url: `/pages/medicine-edit/medicine-edit?capture=${action}` });
      return;
    }
    if (action === "scan") {
      wx.navigateTo({ url: "/pages/medicine-edit/medicine-edit?scan=1" });
      return;
    }
    if (action === "manual") wx.navigateTo({ url: "/pages/medicine-edit/medicine-edit" });
  },

  noop(): void {
    // 遮罩层阻止触摸事件穿透到底部页面。
  },

  onTapExport(): void {
    wx.navigateTo({ url: "/pages/export-preview/export-preview" });
  },

  onTapInvite(): void {
    wx.navigateTo({ url: "/pages/invite/invite" });
  },

  onTapFamily(): void {
    wx.navigateTo({ url: "/pages/family-settings/family-settings" });
  },

  onRetry(): void {
    this.refresh();
  },
});
