import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/medicine_draft_queue.dart';
import 'package:home_medicine_flutter/features/medicine/medicine_entry_api_page.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';

http.Response json(Object value, [int status = 200]) => http.Response.bytes(
  utf8.encode(jsonEncode(value)),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

Map<String, dynamic> photo(
  String clientId,
  String serverId,
  int sequence,
  String name,
) => {
  'path': 'synthetic-$clientId.png',
  'purpose': 'box_front',
  'state': 'ready',
  'clientPhotoId': clientId,
  'uploadedId': serverId,
  'sequence': sequence,
  'recognitionStatus': 'recognized',
  'recognitionFields': {'name': name},
};

Future<void> openDraft(
  WidgetTester tester,
  MemoryInventoryLocalStore store,
  ApiClient api,
) async {
  tester.view.physicalSize = const Size(600, 1200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      home: MedicineEntryApiPage(
        repository: ApiMedicineRepository(api: api, localStore: store),
        workflow: ApiWorkflowRepository(api: api),
        localStore: store,
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.byTooltip('导入草稿'));
  await tester.pumpAndSettle();
  await tester.tap(find.text('合成药一').last);
  await tester.pumpAndSettle();
}

void main() {
  for (final field in [
    'brand',
    'purposeCategory',
    'populationTags',
    'purposeTags',
  ]) {
    for (final manual in [false, true]) {
      testWidgets(
        '$field ${manual ? 'manual state remains authoritative' : 'conflict requires a choice'}',
        (tester) async {
          final store = MemoryInventoryLocalStore();
          final values = switch (field) {
            'brand' => ('品牌甲', '品牌乙'),
            'purposeCategory' => ('用途甲', '用途乙'),
            'populationTags' => (<String>['adult'], <String>['child']),
            _ => (<String>['fever'], <String>['pain']),
          };
          final a = photo('a', first, 1, '合成药一');
          final b = photo('b', second, 2, '合成药一');
          a['recognitionFields'] = <String, dynamic>{
            'name': '合成药一',
            field: values.$1,
          };
          b['recognitionFields'] = <String, dynamic>{
            'name': '合成药一',
            field: values.$2,
          };
          final draftField = field == 'purposeCategory' ? 'purpose' : field;
          final manualValue = switch (field) {
            'brand' => '手工品牌',
            'purposeCategory' => '',
            _ => <String>[],
          };
          await MedicineDraftQueue(store).save('draft-$field-$manual', {
            'name': '合成药一',
            draftField: manual ? manualValue : values.$1,
            'photos': [a, b],
            'recognitionSources': {
              field: {
                'source': manual ? 'manual' : 'recognized',
                'photoIds': manual ? <String>[] : ['a'],
                'reviewed': manual,
              },
            },
          });
          final creates = <Map<String, dynamic>>[];
          final api = ApiClient(
            baseUrl: 'https://synthetic.invalid',
            tokenProvider: () async => 'synthetic',
            client: MockClient((request) async {
              if (request.method == 'POST' &&
                  request.url.path == '/api/v1/medicines') {
                creates.add(jsonDecode(request.body) as Map<String, dynamic>);
                return json({
                  'id': 'created',
                  'name': '合成药一',
                  'version': 1,
                  'batches': [],
                }, 201);
              }
              throw StateError('unexpected ${request.url.path}');
            }),
          );
          addTearDown(api.close);
          await openDraft(tester, store, api);
          if (!manual) {
            await tester.tap(find.widgetWithText(FilledButton, '核对后保存'));
            await tester.pumpAndSettle();
            expect(creates, isEmpty);
            expect(find.text('药品信息存在不同识别结果，请先在逐图核对中明确选择。'), findsOneWidget);
            final display = values.$2 is List
                ? (values.$2 as List).join('、')
                : values.$2;
            final choice = find.textContaining('$display · 图2 · 使用此建议');
            await Scrollable.ensureVisible(
              tester.element(choice),
              alignment: 0.3,
            );
            await tester.pumpAndSettle();
            await tester.tap(choice);
            await tester.pumpAndSettle();
          }
          await tester.tap(find.widgetWithText(FilledButton, '核对后保存'));
          await tester.pumpAndSettle();
          await tester.tap(find.text('只保存库存'));
          await tester.pumpAndSettle();
          final expected = manual ? manualValue : values.$2;
          expect(creates.single[field], expected == '' ? null : expected);
        },
      );
    }
  }

  for (final mode in [
    'valid',
    'revision',
    'medicineVersion',
    'photo',
    'fields',
    'warnings',
    'fieldSources',
    'batchSources',
    'availability',
    'extraPhoto',
    'extraSource',
    'extraBatch',
    'extraEvidence',
  ]) {
    testWidgets(
      'evidence acknowledgement $mode must match the frozen request',
      (tester) async {
        final store = MemoryInventoryLocalStore();
        final item = photo('a', first, 1, '合成药一');
        item['recognitionFields'] = <String, dynamic>{
          ...Map<String, dynamic>.from(item['recognitionFields'] as Map),
          'expiryValue': '2028-03',
          'expiryPrecision': 'month',
        };
        item['recognitionWarnings'] = ['原始警告'];
        await MedicineDraftQueue(store).save('draft-ack', {
          'name': '合成药一',
          'expiry': '2028-03',
          'expiryPrecision': 'month',
          'savedMedicineId': 'created',
          'savedMedicineVersion': 2,
          'savedBatchId': 'batch-1',
          'savedBatchIdConfirmed': true,
          'attemptedPayload': {'name': '合成药一'},
          'usePhotoAsCover': false,
          'photos': [item],
          'recognitionSources': {
            'name': {
              'source': 'recognized',
              'photoIds': ['a'],
              'reviewed': false,
            },
            'expiryValue': {
              'source': 'recognized',
              'photoIds': ['a'],
              'reviewed': false,
            },
          },
        });
        final writes = <Map<String, dynamic>>[];
        final api = ApiClient(
          baseUrl: 'https://synthetic.invalid',
          tokenProvider: () async => 'synthetic',
          client: MockClient((request) async {
            if (request.url.path == '/api/v1/medicines/created') {
              return json({
                'id': 'created',
                'name': '合成药一',
                'version': 2,
                'batches': [],
              });
            }
            if (request.method == 'GET') {
              return json({
                'evidence': null,
                'capabilities': {'coverPhotoVersionGuard': true},
              });
            }
            final sent = jsonDecode(request.body) as Map<String, dynamic>;
            writes.add(sent);
            final responsePhotos = (jsonDecode(
              jsonEncode(sent['photos']),
            ) as List).cast<Map<String, dynamic>>();
            final responseSources = jsonDecode(
              jsonEncode(sent['fieldSources']),
            ) as Map<String, dynamic>;
            final responseBatches = (jsonDecode(
              jsonEncode(sent['batchSources']),
            ) as List).cast<Map<String, dynamic>>();
            for (final value in responsePhotos) {
              value['available'] = mode != 'availability';
            }
            for (final value in responseBatches) {
              value['batchAvailable'] = true;
            }
            if (mode == 'photo') responsePhotos.clear();
            if (mode == 'fields') {
              responsePhotos.single['fields']['name'] = '伪造内容';
            }
            if (mode == 'warnings') {
              responsePhotos.single['warnings'] = ['丢失原始警告'];
            }
            if (mode == 'fieldSources') {
              responseSources['name']['reviewed'] = true;
            }
            if (mode == 'batchSources') {
              responseBatches.single['reviewed'] = true;
            }
            if (mode == 'extraPhoto') {
              responsePhotos.single['unexpected'] = 'synthetic';
            }
            if (mode == 'extraSource') {
              responseSources['name']['unexpected'] = 'synthetic';
            }
            if (mode == 'extraBatch') {
              responseBatches.single['unexpected'] = 'synthetic';
            }
            final evidence = <String, dynamic>{
              'schemaVersion': 1,
              'revision': mode == 'revision' ? 2 : 1,
              'medicineVersion': mode == 'medicineVersion' ? 3 : 2,
              'currentMedicineVersion': 2,
              'stale': false,
              'photos': responsePhotos,
              'fieldSources': responseSources,
              'batchSources': responseBatches,
            };
            if (mode == 'extraEvidence') evidence['unexpected'] = 'synthetic';
            return json({'evidence': evidence});
          }),
        );
        addTearDown(api.close);
        await openDraft(tester, store, api);
        await tester.tap(find.widgetWithText(FilledButton, '重试原提交'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('确认上传照片'));
        await tester.pumpAndSettle();
        expect(writes, hasLength(1));
        final stored = (await MedicineDraftQueue(store).list()).single;
        expect(stored['evidenceRequest'], writes.single);
        expect(stored['evidenceSynced'], mode == 'valid');
        if (mode == 'availability') {
          expect(stored['evidenceAcknowledged'], isNotNull);
          expect(find.textContaining('原版本资料已收到保存回执'), findsWidgets);
        } else if (mode != 'valid') {
          expect(stored['evidenceAcknowledged'], isNull);
          expect(find.textContaining('资料来源待同步'), findsWidgets);
        }
      },
    );
  }

  testWidgets('manual batch number is included in the created batch', (
    tester,
  ) async {
    final store = MemoryInventoryLocalStore();
    final writes = <Map<String, dynamic>>[];
    final api = ApiClient(
      baseUrl: 'https://synthetic.invalid',
      tokenProvider: () async => 'synthetic',
      client: MockClient((request) async {
        writes.add(jsonDecode(request.body) as Map<String, dynamic>);
        return json({
          'id': 'created',
          'name': '合成药一',
          'version': 1,
          'batches': [],
        }, 201);
      }),
    );
    addTearDown(api.close);
    await tester.pumpWidget(
      MaterialApp(
        home: MedicineEntryApiPage(
          repository: ApiMedicineRepository(api: api, localStore: store),
          workflow: ApiWorkflowRepository(api: api),
          localStore: store,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, '合成药一');
    final details = find.text('品牌、规格与厂家（选填）');
    final list = find.byType(ListView).first;
    for (
      var attempt = 0;
      attempt < 4 && details.evaluate().isEmpty;
      attempt++
    ) {
      await tester.drag(list, const Offset(0, -520));
      await tester.pumpAndSettle();
    }
    await tester.tap(details);
    await tester.pumpAndSettle();
    final lot = find.byWidgetPredicate(
      (widget) =>
          widget is TextField && widget.decoration?.labelText == '批号（选填）',
      skipOffstage: false,
    );
    await tester.enterText(lot, '合成批号');
    await tester.tap(find.widgetWithText(FilledButton, '核对后保存'));
    await tester.pumpAndSettle();
    expect((writes.single['batches'] as List).single['lotNumber'], '合成批号');
  });

  for (final mode in ['confirmed', 'missing', 'legacy']) {
    testWidgets('lot number evidence $mode batch identity', (tester) async {
      final hasBatch = mode != 'missing';
      final confirmed = mode == 'confirmed';
      final store = MemoryInventoryLocalStore();
      final entryPhoto = photo('a', first, 1, '合成药一');
      (entryPhoto['recognitionFields'] as Map)['lotNumber'] = '合成批号';
      entryPhoto['recognitionWarnings'] = ['请核对批号'];
      await MedicineDraftQueue(store).save('draft-lot', {
        'name': '合成药一',
        'lotNumber': '合成批号',
        'savedMedicineId': 'created',
        'savedMedicineVersion': 2,
        if (hasBatch) 'savedBatchId': 'batch-1',
        if (confirmed) 'savedBatchIdConfirmed': true,
        'attemptedPayload': {'name': '合成药一'},
        'usePhotoAsCover': false,
        'photos': [entryPhoto],
        'recognitionSources': {
          'lotNumber': {
            'source': 'recognized',
            'photoIds': ['a'],
            'reviewed': false,
          },
        },
      });
      final writes = <Map<String, dynamic>>[];
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => 'synthetic',
        client: MockClient((request) async {
          if (request.url.path == '/api/v1/medicines/created') {
            return json({
              'id': 'created',
              'name': '合成药一',
              'version': 2,
              'batches': [],
            });
          }
          if (request.method == 'GET') {
            return json({
              'evidence': null,
              'capabilities': {'coverPhotoVersionGuard': true},
            });
          }
          final sent = jsonDecode(request.body) as Map<String, dynamic>;
          writes.add(sent);
          return json({
            'evidence': {
              'schemaVersion': 1,
              'revision': 1,
              'medicineVersion': 2,
              'currentMedicineVersion': 2,
              'stale': false,
              'photos': [(sent['photos'] as List).single..['available'] = true],
              'fieldSources': sent['fieldSources'],
              'batchSources': [
                for (final item in sent['batchSources'] as List)
                  {...item as Map<String, dynamic>, 'batchAvailable': true},
              ],
            },
          });
        }),
      );
      addTearDown(api.close);
      await openDraft(tester, store, api);
      await tester.tap(find.widgetWithText(FilledButton, '重试原提交'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('确认上传照片'));
      await tester.pumpAndSettle();
      if (confirmed) {
        expect(writes, hasLength(1));
        expect(writes.single['batchSources'], [
          {
            'batchId': 'batch-1',
            'field': 'lotNumber',
            'source': 'recognized',
            'photoIds': [first],
            'reviewed': false,
          },
        ]);
        expect((writes.single['photos'] as List).single['warnings'], ['请核对批号']);
        expect(
          (writes.single['fieldSources'] as Map).containsKey('lotNumber'),
          isFalse,
        );
      } else {
        expect(writes, isEmpty);
        expect(
          (await MedicineDraftQueue(store).list()).single['savedMedicineId'],
          'created',
        );
      }
    });
  }

  for (final field in [
    'purposeSummary',
    'packageUsageSummary',
    'contraindicationsSummary',
    'precautionsSummary',
  ]) {
    testWidgets('conflicting leaflet $field requires a choice', (tester) async {
      final store = MemoryInventoryLocalStore();
      final a = photo('a', first, 1, '合成药一');
      final b = photo('b', second, 2, '合成药一');
      (a['recognitionFields'] as Map)[field] = '原文甲';
      (b['recognitionFields'] as Map)[field] = '原文乙';
      await MedicineDraftQueue(store).save('draft-leaflet', {
        'name': '合成药一',
        'leaflet': {field: '原文甲'},
        'photos': [a, b],
        'recognitionSources': {
          field: {
            'source': 'recognized',
            'photoIds': ['a'],
            'reviewed': false,
          },
        },
      });
      final creates = <Map<String, dynamic>>[];
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => 'synthetic',
        client: MockClient((request) async {
          if (request.method == 'POST' &&
              request.url.path == '/api/v1/medicines') {
            creates.add(jsonDecode(request.body) as Map<String, dynamic>);
            return json({
              'id': 'created',
              'name': '合成药一',
              'version': 1,
              'batches': [],
            }, 201);
          }
          throw StateError('unexpected ${request.url.path}');
        }),
      );
      addTearDown(api.close);
      await openDraft(tester, store, api);
      await tester.tap(find.widgetWithText(FilledButton, '核对后保存'));
      await tester.pumpAndSettle();
      expect(creates, isEmpty);
      final choice = find.textContaining('原文乙 · 图2 · 使用此建议');
      await Scrollable.ensureVisible(tester.element(choice), alignment: 0.3);
      await tester.pumpAndSettle();
      await tester.tap(choice);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, '核对后保存'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('只保存库存'));
      await tester.pumpAndSettle();
      expect((creates.single['leaflet'] as Map)[field], '原文乙');
    });
  }

  testWidgets(
    'manually cleared leaflet field stays empty despite different suggestions',
    (tester) async {
      final store = MemoryInventoryLocalStore();
      final a = photo('a', first, 1, '合成药一');
      final b = photo('b', second, 2, '合成药一');
      (a['recognitionFields'] as Map)['purposeSummary'] = '原文甲';
      (b['recognitionFields'] as Map)['purposeSummary'] = '原文乙';
      await MedicineDraftQueue(store).save('draft-manual', {
        'name': '合成药一',
        'leaflet': {'purposeSummary': ''},
        'photos': [a, b],
        'recognitionSources': {
          'purposeSummary': {
            'source': 'manual',
            'photoIds': [],
            'reviewed': true,
          },
        },
      });
      final creates = <Map<String, dynamic>>[];
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => 'synthetic',
        client: MockClient((request) async {
          creates.add(jsonDecode(request.body) as Map<String, dynamic>);
          return json({
            'id': 'created',
            'name': '合成药一',
            'version': 1,
            'batches': [],
          }, 201);
        }),
      );
      addTearDown(api.close);
      await openDraft(tester, store, api);
      await tester.tap(find.widgetWithText(FilledButton, '核对后保存'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('只保存库存'));
      await tester.pumpAndSettle();
      expect((creates.single['leaflet'] as Map)['purposeSummary'], isNull);
    },
  );

  for (final hasBatch in [true, false]) {
    testWidgets(
      'expiry provenance ${hasBatch ? 'uses the saved batch' : 'never guesses a batch'}',
      (tester) async {
        final store = MemoryInventoryLocalStore();
        final entryPhoto = photo('a', first, 1, '合成药一');
        entryPhoto['recognitionFields'] = {
          'name': '合成药一',
          'expiryValue': '2028-03',
          'expiryPrecision': 'month',
        };
        await MedicineDraftQueue(store).save('draft-expiry', {
          'name': '合成药一',
          'expiry': '2028-03',
          'expiryPrecision': 'month',
          'savedMedicineId': 'created',
          'savedMedicineVersion': 2,
          if (hasBatch) 'savedBatchId': 'batch-1',
          if (hasBatch) 'savedBatchIdConfirmed': true,
          'attemptedPayload': {'name': '合成药一'},
          'usePhotoAsCover': false,
          'photos': [entryPhoto],
          'recognitionSources': {
            'expiryValue': {
              'source': 'recognized',
              'photoIds': ['a'],
              'reviewed': false,
            },
          },
        });
        final requests = <Map<String, dynamic>>[];
        final api = ApiClient(
          baseUrl: 'https://synthetic.invalid',
          tokenProvider: () async => 'synthetic',
          client: MockClient((request) async {
            if (request.url.path == '/api/v1/medicines/created') {
              return json({
                'id': 'created',
                'name': '合成药一',
                'version': 2,
                'batches': [],
              });
            }
            if (request.method == 'GET') {
              return json({
                'evidence': null,
                'capabilities': {'coverPhotoVersionGuard': true},
              });
            }
            final sent = jsonDecode(request.body) as Map<String, dynamic>;
            requests.add(sent);
            return json({
              'evidence': {
                'schemaVersion': 1,
                'revision': 1,
                'medicineVersion': 2,
                'currentMedicineVersion': 2,
                'stale': false,
                'photos': [
                  (sent['photos'] as List).single..['available'] = true,
                ],
                'fieldSources': sent['fieldSources'],
                'batchSources': [
                  for (final item in sent['batchSources'] as List)
                    {...item as Map<String, dynamic>, 'batchAvailable': true},
                ],
              },
            });
          }),
        );
        addTearDown(api.close);
        await openDraft(tester, store, api);
        await tester.tap(find.widgetWithText(FilledButton, '重试原提交'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('确认上传照片'));
        await tester.pumpAndSettle();
        if (hasBatch) {
          expect(requests, hasLength(1));
          expect(requests.single['batchSources'], [
            {
              'batchId': 'batch-1',
              'field': 'expiry',
              'source': 'recognized',
              'photoIds': [first],
              'reviewed': false,
            },
          ]);
          expect(
            (requests.single['fieldSources'] as Map).containsKey('expiryValue'),
            isFalse,
          );
          expect(
            (requests.single['photos'] as List)
                .single['fields']['expiryPrecision'],
            'month',
          );
        } else {
          expect(requests, isEmpty);
          expect(
            (await MedicineDraftQueue(store).list()).single['savedMedicineId'],
            'created',
          );
          expect(find.textContaining('资料来源待同步'), findsWidgets);
        }
      },
    );
  }

  for (final mode in [
    'offline',
    'old-service',
    'no-capability',
    'concurrent',
    'lost-cover-ack',
  ]) {
    testWidgets(
      'cover intent $mode preserves version and does not repeat the write',
      (tester) async {
        final store = MemoryInventoryLocalStore();
        await MedicineDraftQueue(store).save('draft-cover', {
          'name': '合成药一',
          'savedMedicineId': 'created',
          'savedMedicineVersion': 2,
          'attemptedPayload': {'name': '合成药一'},
          'usePhotoAsCover': true,
          'photos': [photo('a', first, 1, '合成药一')],
          'recognitionSources': {
            'name': {
              'source': 'recognized',
              'photoIds': ['a'],
              'reviewed': false,
            },
          },
        });
        var version = mode == 'concurrent' ? 3 : 2;
        String? cover;
        var coverWrites = 0;
        var creates = 0;
        final api = ApiClient(
          baseUrl: 'https://synthetic.invalid',
          tokenProvider: () async => 'synthetic',
          client: MockClient((request) async {
            if (request.method == 'POST' &&
                request.url.path == '/api/v1/medicines') {
              creates++;
            }
            if (request.url.path == '/api/v1/medicines/created') {
              if (mode == 'offline') {
                throw http.ClientException('synthetic offline');
              }
              return json({
                'id': 'created',
                'name': '合成药一',
                'version': version,
                'coverPhotoId': cover,
                'batches': [],
              });
            }
            if (request.url.path.endsWith('/recognition-evidence') &&
                request.method == 'GET') {
              if (mode == 'old-service') {
                return json({
                  'error': {'code': 'NOT_FOUND', 'message': 'unavailable'},
                }, 404);
              }
              return json({
                'evidence': null,
                if (mode != 'no-capability')
                  'capabilities': {'coverPhotoVersionGuard': true},
              });
            }
            if (request.url.path.endsWith('/cover-photo')) {
              final body = jsonDecode(request.body) as Map;
              expect(body['version'], 2);
              coverWrites++;
              cover = body['photoId'] as String;
              version++;
              if (mode == 'lost-cover-ack') {
                throw http.ClientException('synthetic lost response');
              }
              return json({'coverPhotoId': cover, 'version': version});
            }
            if (request.url.path.endsWith('/recognition-evidence') &&
                request.method == 'POST') {
              final sent = jsonDecode(request.body) as Map<String, dynamic>;
              return json({
                'evidence': {
                  'schemaVersion': 1,
                  'revision': 1,
                  'medicineVersion': version,
                  'currentMedicineVersion': version,
                  'stale': false,
                  'photos': [
                    (sent['photos'] as List).single..['available'] = true,
                  ],
                  'fieldSources': sent['fieldSources'],
                },
              });
            }
            throw StateError(
              'unexpected ${request.method} ${request.url.path}',
            );
          }),
        );
        addTearDown(api.close);
        await openDraft(tester, store, api);
        Future<void> retry() async {
          await tester.tap(find.widgetWithText(FilledButton, '重试原提交'));
          await tester.pumpAndSettle();
          await tester.tap(find.text('确认上传照片'));
          await tester.pumpAndSettle();
        }

        await retry();
        expect(find.textContaining('资料来源待同步'), findsWidgets);
        expect(
          (await MedicineDraftQueue(store).list()).single['savedMedicineId'],
          'created',
        );
        if (mode == 'lost-cover-ack') {
          expect(coverWrites, 1);
          await retry();
          expect(coverWrites, 1);
          expect(
            (await MedicineDraftQueue(
              store,
            ).list()).single['savedMedicineVersion'],
            3,
          );
        } else {
          expect(coverWrites, 0);
        }
        expect(creates, 0);
      },
    );
  }

  testWidgets('conflicting names block save until the user chooses a photo', (
    tester,
  ) async {
    final store = MemoryInventoryLocalStore();
    await MedicineDraftQueue(store).save('draft-conflict', {
      'name': '合成药一',
      'nextPhotoSequence': 3,
      'photos': [photo('a', first, 1, '合成药一'), photo('b', second, 2, '合成药二')],
      'recognitionSources': {
        'name': {
          'source': 'recognized',
          'photoIds': ['a'],
          'reviewed': false,
        },
      },
    });
    final creates = <Map<String, dynamic>>[];
    final api = ApiClient(
      baseUrl: 'https://synthetic.invalid',
      tokenProvider: () async => 'synthetic',
      client: MockClient((request) async {
        if (request.method == 'POST' &&
            request.url.path == '/api/v1/medicines') {
          creates.add(jsonDecode(request.body) as Map<String, dynamic>);
          return json({
            'id': 'created',
            'name': '合成药二',
            'version': 1,
            'batches': [],
          }, 201);
        }
        throw StateError('unexpected request ${request.url.path}');
      }),
    );
    addTearDown(api.close);
    await openDraft(tester, store, api);
    await tester.tap(find.widgetWithText(FilledButton, '核对后保存'));
    await tester.pumpAndSettle();
    expect(creates, isEmpty);
    expect(find.text('药品信息存在不同识别结果，请先在逐图核对中明确选择。'), findsOneWidget);
    final choice = find.textContaining('合成药二 · 图2 · 使用此建议');
    await tester.ensureVisible(choice);
    await tester.tap(choice);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '核对后保存'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('只保存库存'));
    await tester.pumpAndSettle();
    expect(creates.single['name'], '合成药二');
  });

  for (final reviewed in [false, true]) {
    testWidgets(
      'failed evidence sync retains and replays the exact request with reviewed=$reviewed',
      (tester) async {
        final store = MemoryInventoryLocalStore();
        await MedicineDraftQueue(store).save('draft-saved', {
          'name': '合成药一',
          'savedMedicineId': 'created',
          'savedMedicineVersion': 2,
          'attemptedPayload': {'name': '合成药一'},
          'usePhotoAsCover': false,
          'photos': [photo('a', first, 1, '合成药一')],
          'recognitionSources': {
            'name': {
              'source': 'recognized',
              'photoIds': ['a'],
              'reviewed': reviewed,
            },
          },
        });
        final evidencePosts = <String>[];
        var creates = 0;
        final api = ApiClient(
          baseUrl: 'https://synthetic.invalid',
          tokenProvider: () async => 'synthetic',
          client: MockClient((request) async {
            if (request.url.path == '/api/v1/medicines' &&
                request.method == 'POST') {
              creates++;
            }
            if (request.url.path == '/api/v1/medicines/created') {
              return json({
                'id': 'created',
                'name': '合成药一',
                'version': 2,
                'batches': [],
              });
            }
            if (request.url.path.endsWith('/recognition-evidence') &&
                request.method == 'GET') {
              return json({
                'evidence': null,
                'capabilities': {'coverPhotoVersionGuard': true},
              });
            }
            if (request.url.path.endsWith('/recognition-evidence') &&
                request.method == 'POST') {
              evidencePosts.add(request.body);
              if (evidencePosts.length == 1) {
                return json({
                  'error': {'code': 'UNAVAILABLE', 'message': 'offline'},
                }, 503);
              }
              final sent = jsonDecode(request.body) as Map<String, dynamic>;
              return json({
                'evidence': {
                  'schemaVersion': 1,
                  'revision': 1,
                  'medicineVersion': 2,
                  'currentMedicineVersion': 2,
                  'stale': false,
                  'photos': [
                    (sent['photos'] as List).single..['available'] = true,
                  ],
                  'fieldSources': sent['fieldSources'],
                },
              });
            }
            throw StateError('unexpected request ${request.url.path}');
          }),
        );
        addTearDown(api.close);
        await openDraft(tester, store, api);
        Future<void> retry() async {
          await tester.tap(find.widgetWithText(FilledButton, '重试原提交'));
          await tester.pumpAndSettle();
          await tester.tap(find.text('确认上传照片'));
          await tester.pumpAndSettle();
        }

        await retry();
        expect(evidencePosts, hasLength(1));
        expect(
          (jsonDecode(evidencePosts.single)
              as Map)['fieldSources']['name']['reviewed'],
          reviewed,
        );
        final retained = (await MedicineDraftQueue(store).list()).single;
        expect(retained['evidenceRequest'], jsonDecode(evidencePosts.single));
        expect(find.textContaining('资料来源待同步'), findsWidgets);
        await retry();
        expect(evidencePosts, hasLength(2));
        expect(evidencePosts.last, evidencePosts.first);
        expect(creates, 0);
      },
    );
  }
}
