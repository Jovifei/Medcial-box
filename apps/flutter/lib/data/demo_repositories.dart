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
        ),
      ],
    ),
  ];

  List<DemoMedicine> get medicines => List.unmodifiable(_medicines);

  @override
  Future<List<DemoMedicine>> listMedicines() async => medicines;

  @override
  Future<DemoMedicine> getMedicine(String id) async =>
      _medicines.firstWhere((medicine) => medicine.id == id);

  void addDemoMedicine(String name) {
    _medicines.insert(
      0,
      DemoMedicine(
        id: 'demo-${DateTime.now().microsecondsSinceEpoch}',
        name: name,
        specification: '规格待补充',
        purpose: '用途待确认',
        leafletStatus: LeafletReviewStatus.unverified,
        batches: const [
          DemoBatch(
            id: 'new-batch',
            quantity: null,
            unit: '盒',
            expiry: '待补充',
            state: ExpiryState.unknown,
          ),
        ],
      ),
    );
    notifyListeners();
  }

  void archive(String id) {
    _medicines.removeWhere((medicine) => medicine.id == id);
    notifyListeners();
  }
}
