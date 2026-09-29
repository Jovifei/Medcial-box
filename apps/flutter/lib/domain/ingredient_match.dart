import '../models/medicine_models.dart';

List<MedicineRecord> findVerifiedIngredientMatches({
  required Iterable<String> candidateIngredients,
  required Iterable<MedicineRecord> medicines,
  required bool candidateIngredientsVerified,
  String? excludeMedicineId,
}) {
  if (!candidateIngredientsVerified) return const [];
  final candidateKeys = _ingredientKeys(candidateIngredients);
  if (candidateKeys.isEmpty) return const [];
  return medicines
      .where((medicine) {
        if (medicine.id == excludeMedicineId || medicine.isArchived) {
          return false;
        }
        if (medicine.leaflet.reviewStatus == 'unverified') return false;
        return _ingredientKeys(medicine.activeIngredients)
            .any(candidateKeys.contains);
      })
      .toList(growable: false);
}

Set<String> _ingredientKeys(Iterable<String> values) => values
    .expand((value) => value.split(RegExp(r'[,，、;；\s]+')))
    .map((value) => value.trim().toLowerCase())
    .where((value) => value.isNotEmpty)
    .toSet();
