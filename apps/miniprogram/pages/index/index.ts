import { api, ApiError, readToken } from "../../services/api";
import { scopedStorageKey } from "../../services/session-scope";
import { ensureLoggedIn } from "../../services/auth";
import type {
  ExpiryState,
  MedicationSummary,
  QuantityUnit,
} from "../../services/api-types";

interface CabinetItem {
  id: string;
  updatedAt: string;
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
  /** 人群整理标签（展示文案，kind 用于配色：蓝=成人、绿=儿童）。 */
  populationTags: Array<{ kind: "adult" | "child"; label: string }>;
  /** 用途整理标签（展示文案，紫色）。 */
  purposeTags: string[];
  /** 卡片上最多显示 3 个标签，其余合并为 +N。 */
  displayTags: Array<{ kind: string; label: string }>;
  extraTagCount: number;
  /** 最早管理截止日期（未知为 null，排序时置末）。 */
  earliestDate: string | null;
  /** 封面照片 id（无则空串）；首页缩略图据此按需下载（S5-A）。 */
  coverPhotoId: string;
  /** 已下载到本地的封面临时路径；空串表示未加载/无封面，模板显示占位。 */
  coverPhotoPath: string;
  /** 存放位置摘要（去重后最多两处，多余合并为「等 N 处」；无则空串）。 */
  locationText: string;
  /** 开封状态文案（S5-A：显式化此前静默的开封态，空串=无已开封批次）。 */
  openedText: string;
  /** 是否已归档（归档不驱动到期提醒，但首页需明确标注）。 */
  isArchived: boolean;
}

type CabinetFilter = "all" | "expiring" | "low" | "missing" | "expired" | "opened" | "archived" | "unknown" | "exhausted";

const UNIT_SHORT: Record<QuantityUnit, string> = {
  tablet: "片",
  capsule: "粒",
  sachet: "袋",
  bottle: "瓶",
  tube: "支",
  box: "盒",
  blister: "板",
  ml: "毫升",
  other: "份",
};

function quantitySummary(medicine: MedicationSummary): string {
  // B23：卡片数量摘要只统计当前在库批次，已处置（handled）历史不再显示。
  const inCabinet = medicine.batches.filter((batch) => batch.dispositionStatus !== "handled");
  if (inCabinet.length === 0) {
    return medicine.batches.length > 0 ? "批次均已处理" : "暂无批次记录";
  }
  const parts = inCabinet.map((batch) => {
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
  // B23：在库口径 = 未处置批次（含已过期但尚未处理的待处理项）。
  // 已处置（handled）批次保留在详情/历史中，但不再驱动卡片日期、状态与提醒。
  const inCabinet = medicine.batches.filter((batch) => batch.dispositionStatus !== "handled");
  const activeExpiryStates = inCabinet.map((batch) => batch.managementExpiryState?.state ?? batch.expiryState.state);
  const severity: Record<ExpiryState, number> = { expired: 0, due_this_month: 1, expiring_soon: 2, ok: 3, unknown: 4 };
  const state = activeExpiryStates.length > 0
    ? [...activeExpiryStates].sort((left, right) => severity[left] - severity[right])[0]
    : medicine.expiryState?.state ?? "unknown";
  const dateRecords = inCabinet.map((batch) => ({
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
  // S5-A「完整状态」：存放位置 + 开封态在 TS 预计算成文案，模板只读取字段（延续 R17）。
  const locations: string[] = [];
  for (const batch of inCabinet) {
    const raw = batch.storageLocation;
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value !== "" && !locations.includes(value)) locations.push(value);
  }
  const locationText = locations.length === 0
    ? ""
    : locations.length <= 2
      ? locations.join(" / ")
      : `${locations.slice(0, 2).join(" / ")} 等 ${locations.length} 处`;
  const openedCount = inCabinet.filter((batch) => batch.openedState === "opened").length;
  const openedText = openedCount === 0 ? "" : openedCount === 1 ? "已开封" : `已开封 · ${openedCount} 批`;
  return {
    id: medicine.id,
    updatedAt: medicine.createdAt ?? medicine.updatedAt ?? "",
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
    populationTags: medicine.populationTags?.map((tag) => ({ kind: tag, label: tag === "adult" ? "成人" : "儿童" })) ?? [],
    purposeTags: (medicine.purposeTags ?? []).map((tag) => PURPOSE_TAG_LABELS[tag] ?? tag),
    displayTags: [],
    extraTagCount: 0,
    earliestDate: dateRecords.length > 0 ? dateRecords[0].date : null,
    coverPhotoId: medicine.coverPhotoId ?? "",
    coverPhotoPath: "",
    locationText,
    openedText,
    isArchived: medicine.isArchived === true,
  };
}

const PURPOSE_TAG_LABELS: Record<string, string> = {
  fever: "发热", cough: "咳嗽", throat: "咽喉", nasal: "鼻部", gastro: "胃肠",
  pain: "疼痛", topical: "外用", allergy: "过敏", other: "其他",
};

/** R17：筛选标签在 TS 里预计算选中态，模板只读取字段，不在 WXML 里调用 indexOf。 */
const POPULATION_CHIPS: Array<{ value: string; label: string }> = [
  { value: "adult", label: "成人" }, { value: "child", label: "儿童" },
];
const PURPOSE_CHIPS: Array<{ value: string; label: string }> = [
  { value: "发热", label: "发热" }, { value: "咳嗽", label: "咳嗽" }, { value: "咽喉", label: "咽喉" },
  { value: "鼻部", label: "鼻部" }, { value: "胃肠", label: "胃肠" }, { value: "疼痛", label: "疼痛" },
  { value: "外用", label: "外用" }, { value: "过敏", label: "过敏" }, { value: "其他", label: "其他" },
];
interface FilterChip { value: string; label: string; selected: boolean; }
function chipOptions(base: Array<{ value: string; label: string }>, selected: string[]): FilterChip[] {
  return base.map((chip) => ({ ...chip, selected: selected.includes(chip.value) }));
}

function withDisplayTags(item: CabinetItem): CabinetItem {
  const merged = [
    ...item.populationTags.map((tag) => ({ kind: `pop-${tag.kind}`, label: tag.label })),
    ...item.purposeTags.map((label) => ({ kind: "purpose", label })),
  ];
  return { ...item, displayTags: merged.slice(0, 3), extraTagCount: Math.max(0, merged.length - 3) };
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
  filterLabel: string;
  filters: Array<{ id: CabinetFilter; label: string; count: number }>;
  selectedPopulations: string[];
  selectedPurposes: string[];
  populationChips: FilterChip[];
  purposeChips: FilterChip[];
  sortKey: string;
  sortLabels: string[];
  sortIndex: number;
  familyName: string;
  items: CabinetItem[];
  allItems: CabinetItem[];
  errorMessage: string;
  highlightedId: string;
  savedMessage: string;
  filterPanel: string;
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
    filterLabel: "全部",
    filters: [] as Array<{ id: CabinetFilter; label: string; count: number }>,
    /** 人群多选：空数组 = 不筛选；同维度任一匹配即命中。 */
    selectedPopulations: [] as string[],
    /** 用途多选：空数组 = 不筛选。 */
    selectedPurposes: [] as string[],
    populationChips: chipOptions(POPULATION_CHIPS, []),
    purposeChips: chipOptions(PURPOSE_CHIPS, []),
    /** 排序：最早管理截止升序（默认）/降序/名称；未知日期始终置末。 */
    sortKey: "deadline_asc",
    sortLabels: ["最早截止在前", "最早截止在后", "名称 A-Z", "最近添加"],
    sortIndex: 0,
    familyName: "",
    items: [] as CabinetItem[],
    allItems: [] as CabinetItem[],
    errorMessage: "",
    highlightedId: "",
    savedMessage: "",
    filterPanel: "",
    entrySheetVisible: false,
  },

  redirecting: false,

  /** 缩略图代次：每次新的 loadCovers 自增，令此刻仍在途的旧下载回写作废（对齐 R10/R11 纪律）。 */
  coverToken: 0,
  /** coverPhotoId → 本地临时路径缓存，令切 tab 回前台不重复下载。 */
  coverCache: null as Map<string, string> | null,

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
      // 首页需要支持“已归档”筛选，因此取完整集合；默认视图仍只展示未归档药品。
      const list = await api.listMedicines(true);
      this.applyMedicines(list.medicines, family.family.name);
      void this.loadCovers();
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
    const currentItems = allItems.filter((item) => !item.isArchived);
    let expiredCount = 0;
    let expiringCount = 0;
    for (const item of currentItems) {
      const state = item.state;
      if (state === "expired") expiredCount += 1;
      else if (state === "due_this_month" || state === "expiring_soon") expiringCount += 1;
    }
    this.setData({ isExample: false, familyName, allItems, expiredCount, expiringCount, errorMessage: "", stageLabel: "药箱首页" });
    const lowStockCount = currentItems.filter((item) => item.stockState === "low" || item.stockState === "exhausted").length;
    const missingInfoCount = currentItems.filter((item) => item.needsInfo).length;
    this.setData({
      lowStockCount,
      missingInfoCount,
      filters: [
        { id: "expiring", label: "临期 / 过期", count: expiredCount + expiringCount },
        { id: "low", label: "库存不足", count: lowStockCount },
        { id: "missing", label: "待补资料", count: missingInfoCount },
      ],
    });
    const highlightKey = scopedStorageKey("cabinet-saved-highlight");
    let id: string | undefined;
    try {
      if (highlightKey) {
        id = wx.getStorageSync(highlightKey) as string | undefined;
        if (id) wx.removeStorageSync(highlightKey);
      }
    } catch {
      // 高亮是纯展示增强；本地存储不可用不能阻断首页数据。
    }
    if (id) this.setData({ highlightedId: id });
    this.applyFilter();
    if (id) this.setData({ savedMessage: this.data.items.some((item) => item.id === id) ? "已添加，药品在下方突出显示；可继续添加或点开查看。" : "已保存，当前筛选未显示；可点击查看，筛选保持原样。" });
  },

  /**
   * 首页缩略图（S5-A）：私有封面接口需带 Bearer，<image> 无法直接带头，
   * 复用详情的 downloadLeafletPhoto 下载到本地临时路径再展示。
   * - 按 coverPhotoId 缓存，切 tab 回前台不重复下载；
   * - coverToken 代次守卫：新一次刷新会令此刻仍在途的旧下载回写作废（对齐 R10/R11）；
   * - 任何失败都保持占位、不影响列表其余内容。
   */
  async loadCovers(): Promise<void> {
    if (typeof api.downloadLeafletPhoto !== "function") return;
    const initial = this.data as IndexPageData;
    const targets = initial.allItems.filter((item) => item.coverPhotoId !== "" && item.coverPhotoPath === "");
    if (targets.length === 0) return;
    const cache = this.coverCache ?? (this.coverCache = new Map<string, string>());
    const token = (this.coverToken += 1);
    const resolved = new Map<string, string>();
    for (const item of targets.slice(0, 60)) {
      if (token !== this.coverToken) return;
      const cached = cache.get(item.coverPhotoId);
      if (cached !== undefined) {
        resolved.set(item.id, cached);
        continue;
      }
      try {
        const tempFilePath = await api.downloadLeafletPhoto(item.id, item.coverPhotoId);
        if (token !== this.coverToken) return;
        if (typeof tempFilePath === "string" && tempFilePath !== "") {
          cache.set(item.coverPhotoId, tempFilePath);
          resolved.set(item.id, tempFilePath);
        }
      } catch {
        if (token !== this.coverToken) return;
      }
    }
    if (token !== this.coverToken || resolved.size === 0) return;
    const current = this.data as IndexPageData;
    const allItems = current.allItems.map((entry) => {
      const path = resolved.get(entry.id);
      return path === undefined ? entry : { ...entry, coverPhotoPath: path };
    });
    this.setData({ allItems });
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
    const filtered = data.allItems.filter((item) => {
      const matchesKeyword = keyword === "" || item.searchText.includes(keyword);
      const matchesArchive = data.filterKind === "archived" ? item.isArchived : !item.isArchived;
      const matchesFilter = (data.filterKind === "all" ||
        (data.filterKind === "expiring" && (item.state === "expired" || item.state === "due_this_month" || item.state === "expiring_soon")) ||
        (data.filterKind === "low" && (item.stockState === "low" || item.stockState === "exhausted")) ||
        (data.filterKind === "missing" && item.needsInfo) ||
        (data.filterKind === "expired" && item.state === "expired") ||
        (data.filterKind === "opened" && item.openedText !== "") ||
        (data.filterKind === "archived" && item.isArchived) ||
        (data.filterKind === "unknown" && (item.stockState === "unknown" || item.state === "unknown")) ||
        (data.filterKind === "exhausted" && item.stockState === "exhausted")) && matchesArchive;
      // 人群/用途多选：同一维度任选匹配（some），不同维度需同时满足。
      const matchesPopulation = data.selectedPopulations.length === 0 ||
        item.populationTags.some((tag) => data.selectedPopulations.includes(tag.kind));
      const matchesPurpose = data.selectedPurposes.length === 0 ||
        item.purposeTags.some((label) => data.selectedPurposes.includes(label));
      return matchesKeyword && matchesFilter && matchesPopulation && matchesPurpose;
    });
    const items = filtered.map(withDisplayTags).sort((left, right) => {
      if (data.sortKey === "recent") return right.updatedAt.localeCompare(left.updatedAt);
      if (data.sortKey === "name") return left.name.localeCompare(right.name, "zh-Hans-CN");
      // B19：未知日期两种方向都置末；已知日期按方向比较，同日期保持稳定排序。
      if (left.earliestDate === null && right.earliestDate === null) return 0;
      if (left.earliestDate === null) return 1;
      if (right.earliestDate === null) return -1;
      const compared = left.earliestDate.localeCompare(right.earliestDate);
      return data.sortKey === "deadline_desc" ? -compared : compared;
    });
    const tagFiltersActive = data.selectedPopulations.length > 0 || data.selectedPurposes.length > 0 || data.sortKey !== "deadline_asc";
    const labels: Record<CabinetFilter, string> = { all: "全部", expiring: "临期/过期", expired: "已过期", low: "库存不足", missing: "待补资料", opened: "已开封", archived: "已归档", unknown: "数量/日期未知", exhausted: "已用完" };
    this.setData({ items, filterLabel: labels[data.filterKind], isFiltered: keyword !== "" || data.filterKind !== "all" || tagFiltersActive });
  },

  onTogglePopulation(event: { currentTarget: { dataset: { value?: string } } }): void {
    const value = event.currentTarget.dataset.value;
    if (!value) return;
    const current = (this.data as IndexPageData).selectedPopulations;
    const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
    this.setData({ selectedPopulations: next });
    this.syncFilterChips();
    this.applyFilter();
  },

  onTogglePurpose(event: { currentTarget: { dataset: { value?: string } } }): void {
    const value = event.currentTarget.dataset.value;
    if (!value) return;
    const current = (this.data as IndexPageData).selectedPurposes;
    const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
    this.setData({ selectedPurposes: next });
    this.syncFilterChips();
    this.applyFilter();
  },

  /** R17：把选中态算进标签数组，模板只读取 item.selected，不在 WXML 里调用方法。 */
  syncFilterChips(): void {
    const data = this.data as IndexPageData;
    this.setData({
      populationChips: chipOptions(POPULATION_CHIPS, data.selectedPopulations),
      purposeChips: chipOptions(PURPOSE_CHIPS, data.selectedPurposes),
    });
  },

  onSortChange(event: { detail: { value: string | number } }): void {
    const index = Number(event.detail.value);
    const keys = ["deadline_asc", "deadline_desc", "name", "recent"];
    this.setData({ sortIndex: index, sortKey: keys[index] ?? "deadline_asc" });
    this.applyFilter();
  },

  onSelectFilter(event: { currentTarget: { dataset: { kind?: CabinetFilter } } }): void {
    const selected = event.currentTarget.dataset.kind;
    if (!selected) return;
    const current = (this.data as IndexPageData).filterKind;
    this.setData({ filterKind: current === selected ? "all" : selected });
    this.applyFilter();
  },

  onOpenFilterPanel(event: { currentTarget: { dataset: { panel?: string } } }): void {
    this.setData({ filterPanel: this.data.filterPanel === event.currentTarget.dataset.panel ? "" : event.currentTarget.dataset.panel ?? "" });
  },
  onViewSaved(): void { if (this.data.highlightedId) wx.navigateTo({ url: `/pages/medicine-detail/medicine-detail?id=${this.data.highlightedId}` }); },
  onClearSearch(): void {
    this.setData({ keyword: "" });
    this.applyFilter();
  },

  onClearFilters(): void {
    this.setData({ keyword: "", filterKind: "all", selectedPopulations: [], selectedPurposes: [], sortKey: "deadline_asc", sortIndex: 0 });
    this.syncFilterChips();
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
    wx.navigateTo({ url: "/pages/medicine-edit/medicine-edit" });
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
