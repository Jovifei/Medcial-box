import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';

void main() {
  test('maps opening deadline and threshold from the shared inventory API', () async {
    final repository = ApiMedicineRepository(
      api: ApiClient(
        baseUrl: 'https://medicine.example',
        tokenProvider: () async => 'session-token',
        client: MockClient((request) async {
          expect(request.headers['authorization'], 'Bearer session-token');
          return http.Response.bytes(
            utf8.encode(jsonEncode({
              'medicines': [
                {
                  'id': 'm1',
                  'name': '测试药',
                  'specification': null,
                  'manufacturer': null,
                  'approvalNumber': null,
                  'activeIngredients': ['成分甲'],
                  'purposeCategory': '用途待核对',
                  'leaflet': {'reviewStatus': 'unverified'},
                  'batches': [
                    {
                      'id': 'b1',
                      'lotNumber': null,
                      'expiry': {'value': '2027-03', 'precision': 'month'},
                      'expiryState': {'state': 'ok', 'label': '有效'},
                      'quantity': null,
                      'unit': 'bottle',
                      'confirmedUnitsPerPackage': null,
                      'storageLocation': '冰箱上层',
                      'openedState': 'opened',
                      'openedAt': '2026-09-20',
                      'afterOpeningLimit': {
                        'value': 30,
                        'unit': 'day',
                        'source': '说明书',
                      },
                      'openedExpiryDate': '2026-10-20',
                      'managementExpiryDate': '2026-10-20',
                      'managementExpirySource': 'opened',
                      'managementExpiryState': {'state': 'ok', 'label': '有效'},
                      'dispositionStatus': 'handled',
                      'version': 4,
                    },
                  ],
                  'lowStockThreshold': {'quantity': 2, 'unit': 'bottle'},
                  'stockStatus': {'state': 'unknown', 'quantity': null, 'unit': 'bottle'},
                  'expiryState': {'state': 'ok', 'label': '有效'},
                  'isArchived': false,
                  'version': 7,
                },
              ],
            })),
            200,
          );
        }),
      ),
      localStore: MemoryInventoryLocalStore(),
    );

    final medicines = await repository.listMedicines();

    expect(medicines.single.batches.single.quantity, isNull);
    expect(medicines.single.batches.single.expiryValue, '2027-03');
    expect(medicines.single.batches.single.openedExpiryDate, '2026-10-20');
    expect(medicines.single.batches.single.managementExpirySource, 'opened');
    expect(medicines.single.batches.single.dispositionStatus, 'handled');
    expect(medicines.single.lowStockThreshold?.quantity, 2);
    expect(medicines.single.stockStatus, 'unknown');
    expect(repository.isOffline, isFalse);
    expect(await (repository.localStore as MemoryInventoryLocalStore).readLastSyncedAt(), isNotNull);
  });

  test('network failure returns the last cache and marks it as stale', () async {
    final cache = MemoryInventoryLocalStore();
    final repository = ApiMedicineRepository(
      api: ApiClient(
        baseUrl: 'https://medicine.example',
        tokenProvider: () async => 'session-token',
        client: MockClient((_) => throw http.ClientException('offline')),
      ),
      localStore: cache,
    );
    await cache.saveInventory([
      MedicineRecord(
        id: 'cached',
        name: '缓存药',
        batches: const [],
      ),
    ]);
    final lastSync = DateTime.utc(2026, 9, 28, 8, 30);
    await cache.saveLastSyncedAt(lastSync);

    final medicines = await repository.listMedicines();

    expect(medicines.single.id, 'cached');
    expect(repository.isOffline, isTrue);
    expect(repository.lastSyncedAt, lastSync);
  });

  test('rejected inventory write never changes the local snapshot', () async {
    final cache = MemoryInventoryLocalStore();
    final original = MedicineRecord(id: 'm1', name: '原药名', batches: const []);
    await cache.saveInventory([original]);
    final repository = ApiMedicineRepository(
      api: ApiClient(
        baseUrl: 'https://medicine.example',
        tokenProvider: () async => 'session-token',
        client: MockClient(
          (_) async => http.Response.bytes(
            utf8.encode(jsonEncode({'error': {'code': 'VERSION_CONFLICT', 'message': '记录已更新'}})),
            409,
          ),
        ),
      ),
      localStore: cache,
    );

    await expectLater(
      repository.createMedicine({'name': '不应写入'}),
      throwsA(isA<ApiException>()),
    );

    expect((await cache.readInventory())!.single.name, '原药名');
    expect(repository.hasPendingWrites, isFalse);
  });

  test('opening a portion makes one atomic request and replaces the two local batch records', () async {
    final batch = BatchRecord(
      id: 'batch-1',
      lotNumber: 'LOT-1',
      expiryValue: '2027-12-31',
      expiryPrecision: 'day',
      quantity: 10,
      unit: 'box',
      openedState: 'unopened',
      version: 7,
    );
    final medicine = MedicineRecord(
      id: 'medicine-1',
      name: '测试药',
      batches: [batch],
      version: 12,
    );
    final cache = MemoryInventoryLocalStore();
    await cache.saveInventory([medicine]);
    var writeCount = 0;
    final repository = ApiMedicineRepository(
      api: ApiClient(
        baseUrl: 'https://medicine.example',
        tokenProvider: () async => 'session-token',
        client: MockClient((request) async {
          expect(request.method, 'POST');
          expect(
            request.url.path,
            '/api/v1/medicines/medicine-1/batches/batch-1/open-split',
          );
          expect(request.headers['authorization'], 'Bearer session-token');
          writeCount++;
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          expect(body.keys.toSet(), {
            'version',
            'openedQuantity',
            'openedAt',
            'afterOpeningLimit',
            'confirmed',
          });
          expect(body['version'], 7);
          expect(body['openedQuantity'], 2);
          expect(body['openedAt'], '2026-09-29');
          expect(body['afterOpeningLimit'], {'value': 30, 'unit': 'day', 'source': 'user'});
          expect(body['confirmed'], isTrue);
          return http.Response.bytes(
            utf8.encode(jsonEncode({
              'openedBatch': _splitBatchJson(
                id: 'opened-1', quantity: 2, openedState: 'opened', version: 1,
              ),
              'remainingBatch': _splitBatchJson(
                id: 'batch-1', quantity: 8, openedState: 'unopened', version: 8,
              ),
            })),
            200,
          );
        }),
      ),
      localStore: cache,
    );

    final updated = await repository.splitAndOpenBatch(
      medicine: medicine,
      batch: batch,
      openedQuantity: 2,
      openedAt: '2026-09-29',
      afterOpeningLimit: const AfterOpeningLimit.duration(
        value: 30,
        unit: 'day',
        source: 'user',
      ),
    );

    expect(writeCount, 1);
    expect(updated.batches.map((item) => item.id), ['batch-1', 'opened-1']);
    expect(updated.batches.map((item) => item.quantity), [8, 2]);
    expect(updated.batches.last.openedAt, '2026-09-29');
    final cached = await cache.readInventory();
    expect(cached!.single.batches.map((item) => item.quantity), [8, 2]);
  });

  test('a stale atomic open-split conflict does not report success or change local inventory', () async {
    final medicine = MedicineRecord(
      id: 'medicine-1',
      name: '测试药',
      batches: const [
        BatchRecord(
          id: 'batch-1',
          quantity: 10,
          unit: 'box',
          openedState: 'unopened',
          version: 7,
        ),
      ],
    );
    final cache = MemoryInventoryLocalStore();
    await cache.saveInventory([medicine]);
    final repository = ApiMedicineRepository(
      api: ApiClient(
        baseUrl: 'https://medicine.example',
        tokenProvider: () async => 'session-token',
        client: MockClient((request) async {
          expect(request.method, 'POST');
          expect(request.url.path, endsWith('/open-split'));
          return http.Response.bytes(
            utf8.encode(jsonEncode({
              'error': {'code': 'VERSION_CONFLICT', 'message': '批次已被家人修改'},
            })),
            409,
          );
        }),
      ),
      localStore: cache,
    );

    await expectLater(
      repository.splitAndOpenBatch(
        medicine: medicine,
        batch: medicine.batches.single,
        openedQuantity: 2,
        openedAt: '2026-09-29',
      ),
      throwsA(isA<ApiException>().having((error) => error.statusCode, 'statusCode', 409)),
    );
    final cached = await cache.readInventory();
    expect(cached!.single.batches, hasLength(1));
    expect(cached.single.batches.single.quantity, 10);
    expect(cached.single.batches.single.openedState, 'unopened');
  });

  test('unknown opening state cannot use the split endpoint', () async {
    var requests = 0;
    final batch = BatchRecord(
      id: 'batch-1',
      quantity: 10,
      unit: 'box',
      openedState: 'unknown',
      version: 7,
    );
    final medicine = MedicineRecord(id: 'medicine-1', name: '测试药', batches: [batch]);
    final cache = MemoryInventoryLocalStore();
    await cache.saveInventory([medicine]);
    final repository = ApiMedicineRepository(
      api: ApiClient(
        baseUrl: 'https://medicine.example',
        tokenProvider: () async => 'session-token',
        client: MockClient((request) async {
          requests += 1;
          return http.Response('{}', 201);
        }),
      ),
      localStore: cache,
    );

    await expectLater(
      repository.splitAndOpenBatch(
        medicine: medicine,
        batch: batch,
        openedQuantity: 2,
        openedAt: '2026-09-29',
      ),
      throwsA(isA<ApiException>().having((error) => error.statusCode, 'statusCode', 409)),
    );
    expect(requests, 0);
    expect((await cache.readInventory())!.single.batches.single.openedState, 'unknown');
  });
}

Map<String, Object?> _splitBatchJson({
  required String id,
  required int quantity,
  required String openedState,
  required int version,
}) => {
  'id': id,
  'lotNumber': 'LOT-1',
  'expiry': {'value': '2027-12-31', 'precision': 'day'},
  'expiryState': {'state': 'ok', 'label': '有效'},
  'quantity': quantity,
  'unit': 'box',
  'confirmedUnitsPerPackage': null,
  'storageLocation': null,
  'openedState': openedState,
  'openedAt': openedState == 'opened' ? '2026-09-29' : null,
  'afterOpeningLimit': openedState == 'opened'
      ? {'value': 30, 'unit': 'day', 'source': 'user'}
      : null,
  'openedExpiryDate': openedState == 'opened' ? '2026-10-29' : null,
  'managementExpiryDate': '2026-10-29',
  'managementExpirySource': 'opened',
  'managementExpiryState': {'state': 'ok', 'label': '有效'},
  'version': version,
};
