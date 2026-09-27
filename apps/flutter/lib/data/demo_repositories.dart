import 'package:flutter/foundation.dart';

import '../models/demo_models.dart';

abstract class AuthRepository {
  Future<DemoSession> signIn();
}

abstract class MedicineRepository {
  Future<List<DemoMedicine>> listMedicines();
  Future<DemoMedicine> getMedicine(String id);
}

class DemoAuthRepository implements AuthRepository {
  @override
  Future<DemoSession> signIn() async => const DemoSession(signedIn: true);
}

class DemoMedicineRepository extends ChangeNotifier
    implements MedicineRepository {
  final List<DemoMedicine> _medicines = [
    const DemoMedicine(
      id: 'paracetamol',
      name: '对乙酰氨基酚片',
      specification: '0.5 g × 12 片',
      purpose: '缓解疼痛、退热',
      leafletStatus: LeafletReviewStatus.userConfirmed,
      personalNote: '家人备注：成人一次 1 片，仅作记录。',
      batches: [
        DemoBatch(
          id: 'para-1',
          quantity: 6,
          unit: '片',
          expiry: '2026-10',
          state: ExpiryState.expiringSoon,
          lotNumber: 'P202610',
          storageLocation: '客厅药箱',
        ),
      ],
    ),
    const DemoMedicine(
      id: 'cold-granule',
      name: '感冒清热颗粒',
      specification: '每袋 12 g',
      purpose: '感冒相关不适记录',
      leafletStatus: LeafletReviewStatus.matched,
      batches: [
        DemoBatch(
          id: 'cold-1',
          quantity: 8,
          unit: '袋',
          expiry: '2027-03-31',
          state: ExpiryState.ok,
          lotNumber: 'C202703',
          storageLocation: '厨房抽屉',
        ),
      ],
    ),
    const DemoMedicine(
      id: 'saline',
      name: '生理性海水鼻腔喷雾',
      specification: '60 ml / 瓶',
      purpose: '鼻腔清洁护理',
      leafletStatus: LeafletReviewStatus.unverified,
      batches: [
        DemoBatch(
          id: 'saline-1',
          quantity: null,
          unit: '瓶',
          expiry: '待补充',
          state: ExpiryState.unknown,
          storageLocation: '卧室柜',
        ),
      ],
    ),
  ];

  final List<DemoMedicine> _archivedMedicines = [];

  List<DemoMedicine> get medicines => List.unmodifiable(_medicines);

  List<DemoMedicine> get archivedMedicines =>
      List.unmodifiable(_archivedMedicines);

  @override
  Future<List<DemoMedicine>> listMedicines() async => medicines;

  @override
  Future<DemoMedicine> getMedicine(String id) async =>
      _medicines.firstWhere((medicine) => medicine.id == id);

  void addDemoMedicine(String name) {
    addFromDraft(name: name);
  }

  void addFromDraft({
    required String name,
    String specification = '规格待补充',
    String purpose = '用途待确认',
    String expiry = '待补充',
  }) {
    final state = expiry == '待补充' ? ExpiryState.unknown : ExpiryState.ok;
    _medicines.insert(
      0,
      DemoMedicine(
        id: 'demo-${DateTime.now().microsecondsSinceEpoch}',
        name: name,
        specification: specification,
        purpose: purpose,
        leafletStatus: LeafletReviewStatus.unverified,
        batches: [
          DemoBatch(
            id: 'new-batch',
            quantity: null,
            unit: '盒',
            expiry: expiry,
            state: state,
          ),
        ],
      ),
    );
    notifyListeners();
  }

  void updatePersonalNote(String id, String note) {
    final index = _medicines.indexWhere((medicine) => medicine.id == id);
    if (index < 0) return;
    _medicines[index] = _medicines[index].copyWith(personalNote: note);
    notifyListeners();
  }

  void addBatch({
    required String medicineId,
    required int? quantity,
    required String unit,
    required String expiry,
  }) {
    final index = _medicines.indexWhere(
      (medicine) => medicine.id == medicineId,
    );
    if (index < 0) return;
    final normalizedExpiry = expiry.trim().isEmpty ? '待补充' : expiry.trim();
    final batch = DemoBatch(
      id: 'batch-${DateTime.now().microsecondsSinceEpoch}',
      quantity: quantity,
      unit: unit.trim().isEmpty ? '盒' : unit.trim(),
      expiry: normalizedExpiry,
      state: normalizedExpiry == '待补充' ? ExpiryState.unknown : ExpiryState.ok,
    );
    final medicine = _medicines[index];
    _medicines[index] = medicine.copyWith(
      batches: [...medicine.batches, batch],
    );
    notifyListeners();
  }

  void archive(String id) {
    final index = _medicines.indexWhere((medicine) => medicine.id == id);
    if (index < 0) return;
    _archivedMedicines.add(_medicines.removeAt(index));
    notifyListeners();
  }
}
