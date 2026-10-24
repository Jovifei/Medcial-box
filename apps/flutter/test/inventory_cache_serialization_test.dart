import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class DelayedInventoryStore extends MemoryInventoryLocalStore {
  final entered = Completer<void>();
  final release = Completer<void>();
  final writes = <String>[];

  @override
  Future<void> saveInventory(List<MedicineRecord> medicines) async {
    writes.add(medicines.single.id);
    if (writes.length == 1) {
      entered.complete();
      await release.future;
    }
    await super.saveInventory(medicines);
  }
}

http.Response inventoryResponse(String id) => http.Response(
  jsonEncode({'medicines': [{'id': id, 'name': id, 'batches': []}]}),
  200,
);

void main() {
  test('production IdentityLocalStore keeps latest list when first disk write is pending', () async {
    final delegate = DelayedInventoryStore();
    final store = IdentityLocalStore(delegate);
    final secondRequested = Completer<void>();
    var calls = 0;
    final repository = ApiMedicineRepository(
      api: ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => 'synthetic-token',
        client: MockClient((_) async {
          calls++;
          if (calls == 2) secondRequested.complete();
          return inventoryResponse(calls == 1 ? 'older' : 'newer');
        }),
      ),
      localStore: store,
    );
    final older = repository.listMedicines();
    await delegate.entered.future;
    final newer = repository.listMedicines();
    await secondRequested.future;
    delegate.release.complete();
    await Future.wait([older, newer]);
    expect(delegate.writes, ['older', 'newer']);
    expect(repository.medicines.single.id, 'newer');
    expect((await store.readInventory())!.single.id, 'newer');
    expect(await store.readLastSyncedAt(), isNotNull);
  });

  test('late network failure cannot replace the newest list with offline cache', () async {
    final firstStarted = Completer<void>();
    final failFirst = Completer<void>();
    var calls = 0;
    final store = IdentityLocalStore(MemoryInventoryLocalStore());
    final repository = ApiMedicineRepository(
      api: ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => 'synthetic-token',
        client: MockClient((_) async {
          calls++;
          if (calls == 1) {
            firstStarted.complete();
            await failFirst.future;
            throw http.ClientException('synthetic delayed offline');
          }
          return inventoryResponse('newer');
        }),
      ),
      localStore: store,
    );
    final older = repository.listMedicines();
    await firstStarted.future;
    await repository.listMedicines();
    failFirst.complete();
    await older;
    expect(repository.medicines.single.id, 'newer');
    expect((await store.readInventory())!.single.id, 'newer');
    expect(repository.isOffline, isFalse);
  });
}
