import { api, ApiError } from "../../services/api";
import { ensureLoggedIn } from "../../services/auth";
import { parseQuantityByUnit } from "../../services/input-validation";
import type { QuantityUnit, StocktakeItemInput, StocktakeSession } from "../../services/api-types";

type Outcome = StocktakeItemInput["outcome"];
interface StocktakeViewItem {
  batchId: string;
  version: number;
  medicineId: string;
  medicineName: string;
  quantity: number | null;
  unit: string;
  outcome: Outcome;
  outcomeIndex: number;
  adjustedQuantity: string;
  result: "pending" | "saved" | "conflict" | "not_found";
  resultLabel: string;
}

interface StocktakePageData {
  stocktake: StocktakeSession | null;
  items: StocktakeViewItem[];
  loading: boolean;
  submitting: boolean;
  errorMessage: string;
  outcomeLabels: string[];
  outcomeValues: Outcome[];
}

Page({
  data: {
    stocktake: null as StocktakeSession | null,
    items: [] as StocktakeViewItem[],
    loading: true,
    submitting: false,
    errorMessage: "",
    outcomeLabels: ["暂不核对", "数量没变化", "修改余量", "已用完", "已处理"],
    outcomeValues: ["deferred", "unchanged", "adjusted", "empty", "handled"] as Outcome[],
  },
  onShow(): void { void this.refresh(); },
  onPullDownRefresh(): void { void this.refresh().finally(() => wx.stopPullDownRefresh()); },

  async refresh(): Promise<void> {
    this.setData({ loading: true, errorMessage: "" });
    try {
      await ensureLoggedIn();
      const result = await api.getCurrentStocktake();
      const session = result.stocktake;
      if (session === null) {
        this.applySession(null);
        return;
      }
      const conflicted = session.items.filter((item) => item.result === "conflict");
      if (conflicted.length === 0) {
        this.applySession(session);
        return;
      }
      const medicineIds = [...new Set(conflicted.map((item) => item.medicineId))];
      const latestMedicines = await Promise.all(medicineIds.map(async (medicineId) => {
        try {
          return { medicineId, medicine: await api.getMedicine(medicineId) };
        } catch (error) {
          if (error instanceof ApiError && error.statusCode === 404) return { medicineId, medicine: null };
          throw error;
        }
      }));
      const medicinesById = new Map(latestMedicines.map((entry) => [entry.medicineId, entry.medicine]));
      const refreshedSession: StocktakeSession = {
        ...session,
        items: session.items.map((item) => {
          if (item.result !== "conflict") return item;
          const medicine = medicinesById.get(item.medicineId);
          const batch = medicine?.batches.find((entry) => entry.id === item.batchId);
          if (batch === undefined) return { ...item, result: "not_found" as const };
          return { ...item, version: batch.version, quantity: batch.quantity, unit: batch.unit };
        }),
      };
      this.applySession(refreshedSession);
    } catch (error) {
      this.setData({ errorMessage: error instanceof ApiError ? error.message : "暂时无法读取盘点" });
    } finally {
      this.setData({ loading: false });
    }
  },

  applySession(stocktake: StocktakeSession | null): void {
    const items = stocktake?.items.map((item) => ({
      batchId: item.batchId,
      version: item.version,
      medicineId: item.medicineId,
      medicineName: item.medicineName,
      quantity: item.quantity,
      unit: item.unit,
      outcome: "deferred" as Outcome,
      outcomeIndex: 0,
      adjustedQuantity: item.quantity === null ? "" : String(item.quantity),
      result: item.result,
      resultLabel: item.result === "conflict"
        ? `家人已修改此批次；当前数量：${item.quantity === null ? "未知" : `${item.quantity} ${item.unit}`}，请重新核对。`
        : item.result === "not_found" ? "批次已删除或不可见。"
          : item.result === "saved" ? "已保存" : "",
    })) ?? [];
    this.setData({ stocktake, items });
  },

  async onStart(): Promise<void> {
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      await ensureLoggedIn();
      const result = await api.startStocktake();
      this.applySession(result.stocktake);
    } catch (error) {
      wx.showToast({ title: error instanceof ApiError ? error.message : "无法开始盘点", icon: "none" });
    } finally {
      this.setData({ submitting: false });
    }
  },

  onOutcomeChange(event: { currentTarget: { dataset: { index?: string } }; detail: { value: string | number } }): void {
    const index = Number(event.currentTarget.dataset.index);
    const items = [...(this.data.items as StocktakeViewItem[])];
    const value = Number(event.detail.value);
    if (!items[index]) return;
    items[index] = { ...items[index], outcome: this.data.outcomeValues[value] ?? "deferred", outcomeIndex: value, result: "pending", resultLabel: "" };
    this.setData({ items });
  },

  onQuantityInput(event: { currentTarget: { dataset: { index?: string } }; detail: { value: string } }): void {
    const index = Number(event.currentTarget.dataset.index);
    const items = [...(this.data.items as StocktakeViewItem[])];
    if (!items[index]) return;
    items[index] = { ...items[index], adjustedQuantity: event.detail.value, outcome: "adjusted", outcomeIndex: 2, result: "pending", resultLabel: "" };
    this.setData({ items });
  },

  async onSubmit(): Promise<void> {
    const data = this.data as StocktakePageData;
    const session = data.stocktake;
    if (session === null || data.submitting) return;
    if (data.items.some((item) => item.result === "conflict")) {
      wx.showToast({ title: "请先重新选择冲突批次的盘点结果", icon: "none" });
      return;
    }
    const payload: StocktakeItemInput[] = [];
    for (const item of data.items.filter((entry) => entry.result !== "saved" && entry.result !== "not_found")) {
      let quantity: number | null | undefined;
      if (item.outcome === "adjusted") {
        const parsed = parseQuantityByUnit(item.adjustedQuantity, item.unit as QuantityUnit);
        if (parsed === null) {
          wx.showToast({ title: `请填写“${item.medicineName}”的真实余量`, icon: "none" });
          return;
        }
        quantity = parsed;
      } else if (item.outcome === "empty") {
        quantity = 0;
      }
      payload.push({ batchId: item.batchId, version: item.version, outcome: item.outcome, ...(quantity !== undefined ? { quantity } : {}) });
    }
    this.setData({ submitting: true });
    try {
      await ensureLoggedIn();
      const result = await api.submitStocktakeItems(session.id, payload);
      const conflicts = result.results.filter((item) => item.outcome !== "saved");
      if (conflicts.length > 0) {
        await this.refresh();
        this.setData({ errorMessage: `${conflicts.length} 个批次已被家人修改或已删除；其余项目已保存，请查看标记项。` });
        return;
      }
      const completed = await api.completeStocktake(session.id);
      wx.showToast({ title: completed.completed ? "盘点已完成" : "盘点结果已保存", icon: "success" });
      await this.refresh();
    } catch (error) {
      wx.showToast({ title: error instanceof ApiError ? error.message : "盘点保存失败，请重试", icon: "none" });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
