import 'package:flutter_test/flutter_test.dart';

import 'package:home_medicine_flutter/data/demo_repositories.dart';

void main() {
  test('personal note update is persisted by the demo repository', () async {
    final repository = DemoMedicineRepository();

    repository.updatePersonalNote('paracetamol', '仅作为家庭记录');

    final medicine = await repository.getMedicine('paracetamol');
    expect(medicine.personalNote, '仅作为家庭记录');
  });

  test('adding a batch persists quantity, unit and expiry', () async {
    final repository = DemoMedicineRepository();

    repository.addBatch(
      medicineId: 'paracetamol',
      quantity: 3,
      unit: '盒',
      expiry: '2028-01-31',
    );

    final medicine = await repository.getMedicine('paracetamol');
    expect(medicine.batches, hasLength(2));
    expect(medicine.batches.last.quantity, 3);
    expect(medicine.batches.last.unit, '盒');
    expect(medicine.batches.last.expiry, '2028-01-31');
  });

  test('archiving moves a medicine into the optional export collection', () {
    final repository = DemoMedicineRepository();

    repository.archive('paracetamol');

    expect(
      repository.medicines.any((medicine) => medicine.id == 'paracetamol'),
      isFalse,
    );
    expect(repository.archivedMedicines.single.id, 'paracetamol');
  });
}
