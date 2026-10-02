import 'package:flutter/foundation.dart';

import '../models/medicine_models.dart';
import 'api_client.dart';
import 'app_stores.dart';

class ApiMedicineRepository extends ChangeNotifier {
  ApiMedicineRepository({required this.api, required this.localStore});

  final ApiClient api;
  final LocalAppStore localStore;
  bool isOffline = false;
  bool hasPendingWrites = false;
  DateTime? lastSyncedAt;
  List<MedicineRecord> _medicines = const [];
  List<MedicineRecord> get medicines => List.unmodifiable(_medicines);

  /// 会话切换（退出 / 换账号 / 换家庭）时必须调用：
  /// 长期共享的 repository 内存快照若不清空，新会话会看到上一个家庭的库存（A03）。
  void clearSessionSnapshot() {
    _medicines = const [];
    isOffline = false;
    hasPendingWrites = false;
    lastSyncedAt = null;
    notifyListeners();
  }

  Future<List<MedicineRecord>> listMedicines({bool includeArchived = false}) async {
    try {
      final json = await api.get(
        '/api/v1/medicines${includeArchived ? '?includeArchived=true' : ''}',
      ) as Map<String, dynamic>;
      final result = (json['medicines'] as List<dynamic>? ?? [])
          .whereType<Map<String, dynamic>>()
          .map(MedicineRecord.fromJson)
          .toList(growable: false);
      _medicines = result;
      isOffline = false;
      lastSyncedAt = DateTime.now();
      await localStore.saveInventory(result);
      await localStore.saveLastSyncedAt(lastSyncedAt!);
      notifyListeners();
      return result;
    } on ApiNetworkException {
      final cached = await localStore.readInventory();
      if (cached == null) rethrow;
      _medicines = cached;
      isOffline = true;
      lastSyncedAt = await localStore.readLastSyncedAt();
      notifyListeners();
      return cached;
    }
  }

  Future<MedicineRecord> getMedicine(String id) async {
    try {
      final json = await api.get('/api/v1/medicines/$id');
      final medicine = MedicineRecord.fromJson(json as Map<String, dynamic>);
      await _upsertMedicine(medicine);
      return medicine;
    } on ApiNetworkException {
      final cached = _findCached(id);
      if (cached == null) rethrow;
      isOffline = true;
      lastSyncedAt ??= await localStore.readLastSyncedAt();
      return cached;
    }
  }

  Future<MedicineRecord> createMedicine(Map<String, Object?> payload) async {
    final json = await api.post('/api/v1/medicines', body: payload) as Map<String, dynamic>;
    final medicine = MedicineRecord.fromJson(json);
    await _upsertMedicine(medicine, prepend: true);
    return medicine;
  }

  Future<MedicineRecord> updateMedicine(MedicineRecord medicine) async {
    final payload = <String, Object?>{
      'name': medicine.name,
      'specification': medicine.specification,
      'manufacturer': medicine.manufacturer,
      'approvalNumber': medicine.approvalNumber,
      // B01：条码与标签必须在完整更新中回传，否则会清空小程序录入的字段。
      'barcodeValue': medicine.barcodeValue,
      'activeIngredients': medicine.activeIngredients,
      'purposeCategory': medicine.purposeCategory,
      'populationTags': medicine.populationTags,
      'purposeTags': medicine.purposeTags,
      'tagSource': medicine.tagSource,
      'leaflet': medicine.leaflet.toJson(),
      'lowStockThreshold': medicine.lowStockThreshold?.toJson(),
      'version': medicine.version,
      'batches': medicine.batches.map(_batchUpdatePayload).toList(),
    };
    final json = await api.put('/api/v1/medicines/${medicine.id}', payload)
        as Map<String, dynamic>;
    final updated = MedicineRecord.fromJson(json);
    await _upsertMedicine(updated);
    return updated;
  }

  Future<BatchRecord> createBatch(
    String medicineId,
    Map<String, Object?> payload,
  ) async {
    final json = await api.post('/api/v1/medicines/$medicineId/batches', body: payload)
        as Map<String, dynamic>;
    final batch = BatchRecord.fromJson(json);
    final existing = _findCached(medicineId);
    if (existing != null) {
      await _upsertMedicine(existing.copyWith(
        batches: [...existing.batches, batch],
        version: existing.version + 1,
      ));
    }
    return batch;
  }

  Future<BatchRecord> updateBatch(
    String medicineId,
    BatchRecord batch,
  ) async {
    final json = await api.put(
      '/api/v1/medicines/$medicineId/batches/${batch.id}',
      _batchUpdatePayload(batch),
    ) as Map<String, dynamic>;
    final updated = BatchRecord.fromJson(json);
    final medicine = _findCached(medicineId);
    if (medicine != null) {
      await _upsertMedicine(
        medicine.copyWith(
          batches: medicine.batches
              .map((current) => current.id == batch.id ? updated : current)
              .toList(growable: false),
          version: medicine.version + 1,
        ),
      );
    }
    return updated;
  }

  Future<MedicineRecord> splitAndOpenBatch({
    required MedicineRecord medicine,
    required BatchRecord batch,
    required int openedQuantity,
    required String openedAt,
    AfterOpeningLimit? afterOpeningLimit,
  }) async {
    if (batch.openedState != 'unopened') {
      throw const ApiException(
        statusCode: 409,
        code: 'BATCH_OPENING_STATE_UNKNOWN',
        message: '只有已确认未开封的批次可以拆分；状态未记录时请先核实，或按整批记录开封。',
      );
    }
    if (batch.quantity == null || openedQuantity <= 0 || batch.quantity! <= openedQuantity) {
      throw const ApiException(
        statusCode: 400,
        code: 'INVALID_SPLIT_QUANTITY',
        message: '拆分数量必须小于该批次的已知剩余数量。',
      );
    }
    if (!medicine.batches.any((current) => current.id == batch.id)) {
      throw const ApiException(
        statusCode: 404,
        code: 'BATCH_NOT_FOUND',
        message: '当前药品中找不到要开封的库存批次，请刷新后重试。',
      );
    }
    final json = await api.post(
      '/api/v1/medicines/${medicine.id}/batches/${batch.id}/open-split',
      body: {
        'version': batch.version,
        'openedQuantity': openedQuantity,
        'openedAt': openedAt,
        if (afterOpeningLimit != null)
          'afterOpeningLimit': afterOpeningLimit.toJson(),
        'confirmed': true,
      },
    ) as Map<String, dynamic>;
    final openedBatch = BatchRecord.fromJson(
      json['openedBatch'] as Map<String, dynamic>,
    );
    final remainingBatch = BatchRecord.fromJson(
      json['remainingBatch'] as Map<String, dynamic>,
    );
    final batches = <BatchRecord>[];
    for (final current in medicine.batches) {
      if (current.id == batch.id) {
        batches
          ..add(remainingBatch)
          ..add(openedBatch);
      } else {
        batches.add(current);
      }
    }
    final updated = medicine.copyWith(
      batches: batches,
      version: medicine.version + 1,
    );
    await _upsertMedicine(updated);
    return updated;
  }

  Future<void> deleteBatch(String medicineId, String batchId) async {
    await api.delete('/api/v1/medicines/$medicineId/batches/$batchId');
    final medicine = _findCached(medicineId);
    if (medicine != null) {
      await _upsertMedicine(
        medicine.copyWith(
          batches: medicine.batches.where((batch) => batch.id != batchId).toList(),
          version: medicine.version + 1,
        ),
      );
    }
  }

  Future<void> archiveMedicine(String id) async {
    await api.delete('/api/v1/medicines/$id');
    _medicines = _medicines.where((medicine) => medicine.id != id).toList();
    await _persistCache();
    notifyListeners();
  }

  Future<DosageNoteRecord> createDosageNote(
    String medicineId, {
    required String content,
    String visibility = 'private',
  }) async {
    final json = await api.post(
      '/api/v1/medicines/$medicineId/dosage-notes',
      body: {'content': content, 'visibility': visibility},
    ) as Map<String, dynamic>;
    final note = DosageNoteRecord.fromJson(json);
    final medicine = _findCached(medicineId);
    if (medicine != null) {
      _medicines = _medicines
          .map((item) => item.id == medicineId
              ? item.copyWith(dosageNotes: [...item.dosageNotes, note])
              : item)
          .toList(growable: false);
      // Private dosage notes are intentionally excluded from the plain local cache.
      await _persistCache();
      notifyListeners();
    }
    return note;
  }

  Future<DosageNoteRecord> updateDosageNote(
    String medicineId,
    DosageNoteRecord note, {
    required String content,
  }) async {
    final json = await api.put(
      '/api/v1/medicines/$medicineId/dosage-notes/${note.id}',
      {'content': content, 'visibility': note.visibility, 'version': note.version},
    ) as Map<String, dynamic>;
    final updated = DosageNoteRecord.fromJson(json);
    final medicine = _findCached(medicineId);
    if (medicine != null) {
      _medicines = _medicines
          .map((item) => item.id == medicineId
              ? item.copyWith(
                  dosageNotes: item.dosageNotes
                      .map((current) => current.id == note.id ? updated : current)
                      .toList(growable: false),
                )
              : item)
          .toList(growable: false);
      await _persistCache();
      notifyListeners();
    }
    return updated;
  }

  Future<List<DosageNoteRecord>> listDosageNotes(String medicineId) async {
    final json = await api.get('/api/v1/medicines/$medicineId/dosage-notes')
        as Map<String, dynamic>;
    final notes = (json['notes'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .map(DosageNoteRecord.fromJson)
        .toList(growable: false);
    final medicine = _findCached(medicineId);
    if (medicine != null) {
      _medicines = _medicines
          .map((item) => item.id == medicineId ? item.copyWith(dosageNotes: notes) : item)
          .toList(growable: false);
      notifyListeners();
    }
    return notes;
  }

  Future<void> _persistCache() => localStore.saveInventory(_medicines);

  Future<void> _upsertMedicine(MedicineRecord medicine, {bool prepend = false}) async {
    final existingIndex = _medicines.indexWhere((item) => item.id == medicine.id);
    if (existingIndex >= 0) {
      final copy = List<MedicineRecord>.of(_medicines);
      copy[existingIndex] = medicine;
      _medicines = copy;
    } else if (prepend) {
      _medicines = [medicine, ..._medicines];
    } else {
      _medicines = [..._medicines, medicine];
    }
    await _persistCache();
    isOffline = false;
    notifyListeners();
  }

  MedicineRecord? _findCached(String id) {
    for (final medicine in _medicines) {
      if (medicine.id == id) return medicine;
    }
    return null;
  }

  Map<String, Object?> _batchUpdatePayload(BatchRecord batch) => {
    'id': batch.id.isEmpty ? null : batch.id,
    'lotNumber': batch.lotNumber,
    'expiry': {'value': batch.expiryValue, 'precision': batch.expiryPrecision},
    'quantity': batch.quantity,
    'unit': batch.unit,
    'confirmedUnitsPerPackage': batch.confirmedUnitsPerPackage,
    'storageLocation': batch.storageLocation,
    'openedState': batch.openedState,
    'openedAt': batch.openedAt,
    'afterOpeningLimit': batch.afterOpeningLimit?.toJson(),
    'version': batch.version,
  };
}
