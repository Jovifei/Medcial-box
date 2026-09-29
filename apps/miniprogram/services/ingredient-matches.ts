import type { MedicationSummary } from "./api-types";

function ingredientKeys(values: readonly string[]): Set<string> {
  return new Set(values
    .flatMap((value) => value.split(/[,，、;；\s]+/))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean));
}

export function findVerifiedIngredientMatches(
  candidateIngredients: readonly string[],
  medicines: readonly MedicationSummary[],
  candidateIngredientsVerified: boolean,
  excludeMedicineId = "",
): MedicationSummary[] {
  if (!candidateIngredientsVerified) return [];
  const candidateKeys = ingredientKeys(candidateIngredients);
  if (candidateKeys.size === 0) return [];
  return medicines.filter((medicine) => {
    if (medicine.id === excludeMedicineId || medicine.isArchived) return false;
    if (medicine.leaflet.reviewStatus === "unverified") return false;
    return [...ingredientKeys(medicine.activeIngredients)].some((ingredient) => candidateKeys.has(ingredient));
  });
}

export function confirmIngredientOverlap(matches: readonly MedicationSummary[]): Promise<boolean> {
  const names = matches.slice(0, 6).map((medicine) => medicine.name).join("、");
  return new Promise((resolve) => {
    wx.showModal({
      title: "家中已有相同成分记录",
      content: `成分资料已核验的药品：${names}。请对照包装核对，这只是重复成分提醒，不是选药建议。仍要保存库存吗？`,
      confirmText: "仍然保存",
      cancelText: "返回核对",
      success: (result) => resolve(result.confirm),
      fail: () => resolve(false),
    });
  });
}
