import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';

class PausedStore extends MemoryInventoryLocalStore {
  final entered = Completer<void>();
  final release = Completer<void>();
  @override
  Future<void> saveInventory(List<MedicineRecord> value) async {
    entered.complete();
    await release.future;
    await super.saveInventory(value);
  }
}

void main() {
  test('identity clear is serialized after started storage write and drops queued old writes', () async {
    final inner = PausedStore();
    final store = IdentityLocalStore(inner);
    final write = store.saveInventory([
      const MedicineRecord(id: 'old', name: 'old'),
    ]);
    await inner.entered.future;
    final queued = store.saveLastSyncedAt(DateTime(2026));
    final clearing = store.clearFamilyData();
    inner.release.complete();
    await Future.wait([write, queued, clearing]);
    expect(inner.inventory, isNull);
    expect(inner.lastSyncedAt, isNull);
    await store.saveDraft('new', 'new');
    expect(await store.readDraft('new'), 'new');
  });
}
