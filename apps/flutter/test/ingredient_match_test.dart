import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/domain/ingredient_match.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';

void main() {
  final verified = MedicineRecord(
    id: 'verified',
    name: '已核验药品',
    activeIngredients: const ['对乙酰氨基酚', '咖啡因'],
    leaflet: const LeafletRecord(reviewStatus: 'user_confirmed'),
  );
  final unverified = MedicineRecord(
    id: 'unverified',
    name: '未核验药品',
    activeIngredients: const ['布洛芬'],
  );
  final archived = MedicineRecord(
    id: 'archived',
    name: '已归档药品',
    activeIngredients: const ['布洛芬'],
    leaflet: const LeafletRecord(reviewStatus: 'matched'),
    isArchived: true,
  );

  test(
    'only exact overlap with verified active ingredients produces a reminder',
    () {
      final matches = findVerifiedIngredientMatches(
        candidateIngredients: const [' 咖啡因 '],
        medicines: [verified, unverified, archived],
        candidateIngredientsVerified: true,
      );

      expect(matches.map((item) => item.id), ['verified']);
    },
  );

  test('unverified, unconfirmed, substring, and same medicine records do not match', () {
    expect(
      findVerifiedIngredientMatches(
        candidateIngredients: const ['对乙酰氨基酚'],
        medicines: [verified],
        candidateIngredientsVerified: false,
      ),
      isEmpty,
    );
    expect(
      findVerifiedIngredientMatches(
        candidateIngredients: const ['对乙酰氨基酚'],
        medicines: [verified],
        candidateIngredientsVerified: true,
        excludeMedicineId: 'verified',
      ),
      isEmpty,
    );
    expect(
      findVerifiedIngredientMatches(
        candidateIngredients: const ['基氨基酚'],
        medicines: [verified, unverified],
        candidateIngredientsVerified: true,
      ),
      isEmpty,
    );
  });
}
