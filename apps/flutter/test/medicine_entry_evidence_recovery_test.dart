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

const photoId = '00000000-0000-4000-8000-000000000001';

http.Response json(Object value, [int status = 200]) => http.Response.bytes(
  utf8.encode(jsonEncode(value)),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

Map<String, dynamic> original() => {
  'idempotencyKey': 'draft-synthetic',
  'name': '合成药',
  'brand': null,
  'specification': null,
  'manufacturer': null,
  'approvalNumber': null,
  'barcodeValue': null,
  'activeIngredients': <String>[],
  'purposeCategory': null,
  'populationTags': <String>[],
  'purposeTags': <String>[],
  'leaflet': {
    'purposeSummary': null,
    'packageUsageSummary': null,
    'contraindicationsSummary': null,
    'precautionsSummary': null,
    'reviewStatus': 'unverified',
  },
  'batches': [
    {
      'lotNumber': null,
      'expiry': {'value': null, 'precision': 'unknown'},
    },
  ],
};

Map<String, dynamic> latest(
  int version, {
  String name = '合成药',
  List<Object> batches = const [],
}) => {
  'id': 'created',
  'name': name,
  'version': version,
  'brand': null,
  'specification': null,
  'manufacturer': null,
  'approvalNumber': null,
  'barcodeValue': null,
  'activeIngredients': <String>[],
  'purposeCategory': null,
  'populationTags': <String>[],
  'purposeTags': <String>[],
  'leaflet': {
    'purposeSummary': null,
    'packageUsageSummary': null,
    'contraindicationsSummary': null,
    'precautionsSummary': null,
  },
  'batches': batches,
};

Map<String, dynamic> draft({
  Map<String, dynamic>? request,
  Map<String, dynamic>? ack,
}) => {
  'name': '合成药',
  'savedMedicineId': 'created',
  'savedMedicineVersion': 2,
  'attemptedPayload': original(),
  'usePhotoAsCover': false,
  'evidenceRequest': ?request,
  'evidenceAcknowledged': ?ack,
  'photos': [
    {
      'path': 'synthetic-photo.png',
      'purpose': 'box_front',
      'state': 'ready',
      'clientPhotoId': 'a',
      'uploadedId': photoId,
      'sequence': 1,
      'recognitionStatus': 'recognized',
      'recognitionFields': {'name': '合成药', 'rawOcrText': '  原始文字\n'},
      'recognitionWarnings': ['合成提醒'],
    },
  ],
  'recognitionSources': {
    'name': {
      'source': 'recognized',
      'photoIds': ['a'],
      'reviewed': false,
    },
  },
};

Map<String, dynamic> request({
  int revision = 0,
  int version = 2,
  String key = 'evidence_original_1234',
}) => {
  'schemaVersion': 1,
  'revision': revision,
  'medicineVersion': version,
  'idempotencyKey': key,
  'photos': [
    {
      'photoId': photoId,
      'sequence': 1,
      'status': 'recognized',
      'fields': {'name': '合成药', 'rawOcrText': '  原始文字\n'},
      'warnings': ['合成提醒'],
    },
  ],
  'fieldSources': {
    'name': {
      'source': 'recognized',
      'photoIds': [photoId],
      'reviewed': false,
    },
  },
};

Map<String, dynamic> batchDraft() {
  final entry = draft();
  entry['savedBatchId'] = 'batch-1';
  entry['savedBatchIdConfirmed'] = true;
  entry['savedBatchVersion'] = 1;
  entry['expiry'] = '2030-06';
  entry['expiryPrecision'] = 'month';
  entry['lotNumber'] = '合成批号';
  (entry['attemptedPayload'] as Map)['batches'] = [
    {
      'lotNumber': '合成批号',
      'quantity': 10,
      'unit': 'box',
      'expiry': {'value': '2030-06', 'precision': 'month'},
    },
  ];
  final photo = (entry['photos'] as List).single as Map;
  photo['purpose'] = 'expiry';
  photo['recognitionFields'] = {
    'name': '合成药',
    'rawOcrText': '  原始文字\n',
    'expiryValue': '2030-06',
    'expiryPrecision': 'month',
    'lotNumber': '合成批号',
  };
  final sources = Map<String, dynamic>.from(entry['recognitionSources'] as Map);
  sources['expiryValue'] = {
    'source': 'recognized',
    'photoIds': ['a'],
    'reviewed': false,
  };
  sources['lotNumber'] = {
    'source': 'recognized',
    'photoIds': ['a'],
    'reviewed': false,
  };
  entry['recognitionSources'] = sources;
  return entry;
}

Map<String, dynamic> currentBatch({
  String id = 'batch-1',
  int version = 2,
  num quantity = 8,
  String lot = '合成批号',
  String expiry = '2030-06',
}) => {
  'id': id,
  'version': version,
  'quantity': quantity,
  'unit': 'box',
  'lotNumber': lot,
  'expiry': {'value': expiry, 'precision': 'month'},
};

Map<String, dynamic> responseFor(
  Map<String, dynamic> sent, {
  int currentVersion = 3,
  bool stale = true,
}) => {
  'schemaVersion': 1,
  'revision': (sent['revision'] as int) + 1,
  'medicineVersion': sent['medicineVersion'],
  'currentMedicineVersion': currentVersion,
  'stale': stale,
  'photos': [
    for (final p in sent['photos'] as List)
      {...p as Map<String, dynamic>, 'available': true},
  ],
  'fieldSources': sent['fieldSources'],
  if (sent['batchSources'] is List)
    'batchSources': [
      for (final source in sent['batchSources'] as List)
        {...source as Map<String, dynamic>, 'batchAvailable': true},
    ],
};

Future<void> open(
  WidgetTester tester,
  MemoryInventoryLocalStore store,
  ApiClient api,
) async {
  tester.view.physicalSize = const Size(700, 1200);
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
  await tester.tap(find.text('合成药').last);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'offline draft can recover after another member changes only quantity',
    (tester) async {
      final store = MemoryInventoryLocalStore();
      await MedicineDraftQueue(store).save('draft-batch', batchDraft());
      var offline = true;
      var medicineReads = 0;
      var sourceReads = 0;
      final posts = <Map<String, dynamic>>[];
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => 'synthetic',
        client: MockClient((r) async {
          if (r.url.path == '/api/v1/medicines/created') {
            if (offline) throw http.ClientException('synthetic offline');
            medicineReads++;
            return json(latest(3, batches: [currentBatch()]));
          }
          if (r.method == 'GET' &&
              r.url.path.endsWith('/recognition-evidence')) {
            sourceReads++;
            return json({'evidence': null});
          }
          if (r.method == 'POST' &&
              r.url.path.endsWith('/recognition-evidence')) {
            final sent = jsonDecode(r.body) as Map<String, dynamic>;
            posts.add(sent);
            return json({'evidence': responseFor(sent, stale: false)});
          }
          throw StateError('unexpected ${r.url.path}');
        }),
      );
      addTearDown(api.close);
      await open(tester, store, api);
      await tester.tap(find.widgetWithText(FilledButton, '重试原提交'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('确认上传照片'));
      await tester.pumpAndSettle();
      expect(
        (await MedicineDraftQueue(store).list()).single['evidenceRequest'],
        isNull,
      );
      offline = false;
      await tester.tap(find.byTooltip('核对来源同步'));
      await tester.pumpAndSettle();
      expect(find.textContaining('批次版本：原记录 1；当前 2。当前余量：8 盒'), findsOneWidget);
      expect(find.textContaining('有效期：原录入 2030-06'), findsOneWidget);
      expect(posts, isEmpty);
      await tester.tap(find.text('确认并准备重试'));
      await tester.pumpAndSettle();
      final prepared = (await MedicineDraftQueue(store).list()).single;
      expect(medicineReads, 2);
      expect(sourceReads, 2);
      expect(prepared['savedMedicineVersion'], 3);
      expect(prepared['savedBatchVersion'], 2);
      expect(prepared['evidenceHistory'].single['batchVersion'], 1);
      expect(
        (prepared['evidenceRequest']['batchSources'] as List).every(
          (s) => s['batchId'] == 'batch-1',
        ),
        isTrue,
      );
      expect(
        prepared['photos'].single['recognitionFields']['rawOcrText'],
        '  原始文字\n',
      );
      await tester.tap(find.widgetWithText(FilledButton, '重试原提交'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('确认上传照片'));
      await tester.pumpAndSettle();
      expect(posts.single, prepared['evidenceRequest']);
    },
  );

  for (final change in ['medicine', 'source']) {
    testWidgets(
      'changes to $change during confirmation preserve old intent and photos',
      (tester) async {
        final store = MemoryInventoryLocalStore();
        await MedicineDraftQueue(store).save('draft-batch', batchDraft());
        var changed = false;
        var medicineReads = 0;
        var sourceReads = 0;
        var posts = 0;
        final api = ApiClient(
          baseUrl: 'https://synthetic.invalid',
          tokenProvider: () async => 'synthetic',
          client: MockClient((r) async {
            if (r.method == 'POST') posts++;
            if (r.url.path == '/api/v1/medicines/created') {
              medicineReads++;
              return json(
                changed && change == 'medicine'
                    ? latest(
                        4,
                        batches: [currentBatch(version: 3, quantity: 7)],
                      )
                    : latest(3, batches: [currentBatch()]),
              );
            }
            if (r.method == 'GET') {
              sourceReads++;
              return json({
                'evidence': changed && change == 'source'
                    ? responseFor(request())
                    : null,
              });
            }
            throw StateError('unexpected ${r.url.path}');
          }),
        );
        addTearDown(api.close);
        await open(tester, store, api);
        await tester.tap(find.byTooltip('核对来源同步'));
        await tester.pumpAndSettle();
        expect(find.text('确认并准备重试'), findsOneWidget);
        changed = true;
        await tester.tap(find.text('确认并准备重试'));
        await tester.pumpAndSettle();
        expect(find.text('核对期间药品或来源发生变化，请重新核对；原请求和照片仍保留。'), findsOneWidget);
        final kept = (await MedicineDraftQueue(store).list()).single;
        expect(kept['evidenceRequest'], isNull);
        expect(kept['savedMedicineVersion'], 2);
        expect(kept['savedBatchVersion'], 1);
        expect(
          kept['photos'].single['recognitionFields']['rawOcrText'],
          '  原始文字\n',
        );
        expect(kept['evidenceHistory'], isEmpty);
        expect(medicineReads, 2);
        expect(sourceReads, 2);
        expect(posts, 0);
      },
    );
  }

  for (final change in ['batch-id', 'lot', 'expiry', 'version-regression']) {
    testWidgets('recovery does not accept changed $change', (tester) async {
      final store = MemoryInventoryLocalStore();
      await MedicineDraftQueue(store).save('draft-batch', batchDraft());
      final batch = switch (change) {
        'batch-id' => currentBatch(id: 'other-batch'),
        'lot' => currentBatch(lot: '其他批号'),
        'expiry' => currentBatch(expiry: '2031-06'),
        _ => currentBatch(version: 0),
      };
      var posts = 0;
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => 'synthetic',
        client: MockClient((r) async {
          if (r.method == 'POST') posts++;
          if (r.url.path == '/api/v1/medicines/created') {
            return json(latest(3, batches: [batch]));
          }
          if (r.method == 'GET') return json({'evidence': null});
          throw StateError('unexpected ${r.url.path}');
        }),
      );
      addTearDown(api.close);
      await open(tester, store, api);
      await tester.tap(find.byTooltip('核对来源同步'));
      await tester.pumpAndSettle();
      expect(find.text('确认并准备重试'), findsNothing);
      expect(posts, 0);
      final kept = (await MedicineDraftQueue(store).list()).single;
      expect(kept['evidenceRequest'], isNull);
      expect(
        kept['photos'].single['recognitionFields']['rawOcrText'],
        '  原始文字\n',
      );
    });
  }

  for (final change in ['raw', 'photo']) {
    testWidgets(
      'stale receipt with newer $change change retains the only OCR original',
      (tester) async {
        final store = MemoryInventoryLocalStore();
        final frozen = request();
        await MedicineDraftQueue(store)
            .save('draft-old', draft(request: frozen));
        final newer = responseFor(request(revision: 1));
        if (change == 'raw') {
          (newer['photos'] as List).single['fields']['rawOcrText'] =
              '其他设备修改后的文字';
        } else {
          newer['photos'] = <Object>[];
          newer['fieldSources'] = {
            'name': {
              'source': 'removed',
              'photoIds': <String>[],
              'reviewed': false,
            },
          };
        }
        var writes = 0;
        final api = ApiClient(
          baseUrl: 'https://synthetic.invalid',
          tokenProvider: () async => 'synthetic',
          client: MockClient((r) async {
            if (r.url.path == '/api/v1/medicines/created') {
              return json(latest(3));
            }
            if (r.method == 'POST' &&
                r.url.path.endsWith('/recognition-evidence')) {
              writes++;
              return json({'evidence': responseFor(frozen)});
            }
            if (r.method == 'GET') return json({'evidence': newer});
            throw StateError('unexpected ${r.url.path}');
          }),
        );
        addTearDown(api.close);
        await open(tester, store, api);
        await tester.tap(find.widgetWithText(FilledButton, '重试原提交'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('确认上传照片'));
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('核对来源同步'));
        await tester.pumpAndSettle();
        expect(find.text('确认并准备重试'), findsNothing);
        final kept = (await MedicineDraftQueue(store).list()).single;
        expect(kept['evidenceRequest'], frozen);
        expect(
          kept['evidenceAcknowledged']['idempotencyKey'],
          frozen['idempotencyKey'],
        );
        expect(
          kept['photos'].single['recognitionFields']['rawOcrText'],
          '  原始文字\n',
        );
        expect(writes, 1);
      },
    );
  }

  testWidgets(
    'matching stale POST receipt can be explicitly rebased without losing the old key',
    (tester) async {
      final store = MemoryInventoryLocalStore();
      final frozen = request();
      await MedicineDraftQueue(store).save('draft-old', draft(request: frozen));
      final posts = <Map<String, dynamic>>[];
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => 'synthetic',
        client: MockClient((r) async {
          if (r.url.path == '/api/v1/medicines/created') return json(latest(3));
          if (r.method == 'GET' &&
              r.url.path.endsWith('/recognition-evidence')) {
            return json({'evidence': responseFor(frozen)});
          }
          if (r.method == 'POST' &&
              r.url.path.endsWith('/recognition-evidence')) {
            final sent = jsonDecode(r.body) as Map<String, dynamic>;
            posts.add(sent);
            return json({
              'evidence': responseFor(sent, stale: posts.length == 1),
            });
          }
          throw StateError('unexpected ${r.url.path}');
        }),
      );
      addTearDown(api.close);
      await open(tester, store, api);
      await tester.tap(find.widgetWithText(FilledButton, '重试原提交'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('确认上传照片'));
      await tester.pumpAndSettle();
      expect(posts.single, frozen);
      await tester.tap(find.byTooltip('核对来源同步'));
      await tester.pumpAndSettle();
      expect(find.textContaining('当前来源与已收到的原回执一致'), findsOneWidget);
      await tester.tap(find.text('确认并准备重试'));
      await tester.pumpAndSettle();
      final prepared = (await MedicineDraftQueue(store).list()).single;
      expect(prepared['evidenceRequest']['revision'], 1);
      expect(prepared['evidenceRequest']['medicineVersion'], 3);
      expect(
        prepared['evidenceRequest']['idempotencyKey'],
        isNot(frozen['idempotencyKey']),
      );
      expect(prepared['evidenceHistory'].single['request'], frozen);
      expect(prepared['evidenceHistory'].single['acknowledged']['revision'], 1);
      await tester.tap(find.widgetWithText(FilledButton, '重试原提交'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('确认上传照片'));
      await tester.pumpAndSettle();
      expect(posts, hasLength(2));
      expect(posts.last, prepared['evidenceRequest']);
    },
  );

  testWidgets(
    'stale replay is recorded only after the exact POST receipt and remains pending',
    (tester) async {
      final store = MemoryInventoryLocalStore();
      final frozen = request();
      await MedicineDraftQueue(store).save('draft-old', draft(request: frozen));
      final posts = <Map<String, dynamic>>[];
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => 'synthetic',
        client: MockClient((r) async {
          if (r.url.path == '/api/v1/medicines/created') return json(latest(3));
          if (r.method == 'POST' &&
              r.url.path.endsWith('/recognition-evidence')) {
            final value = jsonDecode(r.body) as Map<String, dynamic>;
            posts.add(value);
            return json({'evidence': responseFor(value)});
          }
          throw StateError('unexpected ${r.url.path}');
        }),
      );
      addTearDown(api.close);
      await open(tester, store, api);
      await tester.tap(find.widgetWithText(FilledButton, '重试原提交'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('确认上传照片'));
      await tester.pumpAndSettle();
      final kept = (await MedicineDraftQueue(store).list()).single;
      expect(posts.single, frozen);
      expect(kept['evidenceAcknowledged'], {
        'idempotencyKey': frozen['idempotencyKey'],
        'revision': 1,
        'medicineVersion': 2,
      });
      expect(kept['evidenceSynced'], false);
      expect(kept['photos'], hasLength(1));
      expect(find.textContaining('原版本资料已收到保存回执'), findsWidgets);
    },
  );

  testWidgets(
    'old service recovery requires confirmation and freezes a fresh intent',
    (tester) async {
      final store = MemoryInventoryLocalStore();
      await MedicineDraftQueue(store).save('draft-old', draft());
      final posts = <Map<String, dynamic>>[];
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => 'synthetic',
        client: MockClient((r) async {
          if (r.url.path == '/api/v1/medicines/created') return json(latest(3));
          if (r.method == 'GET' &&
              r.url.path.endsWith('/recognition-evidence')) {
            return json({'evidence': null});
          }
          if (r.method == 'POST' &&
              r.url.path.endsWith('/recognition-evidence')) {
            final value = jsonDecode(r.body) as Map<String, dynamic>;
            posts.add(value);
            return json({'evidence': responseFor(value, stale: false)});
          }
          throw StateError('unexpected ${r.url.path}');
        }),
      );
      addTearDown(api.close);
      await open(tester, store, api);
      await tester.tap(find.byTooltip('核对来源同步'));
      await tester.pumpAndSettle();
      expect(find.textContaining('原录入 合成药；当前药箱 合成药'), findsOneWidget);
      expect(posts, isEmpty);
      await tester.tap(find.text('确认并准备重试'));
      await tester.pumpAndSettle();
      final prepared = (await MedicineDraftQueue(store).list()).single;
      expect(prepared['savedMedicineVersion'], 3);
      expect(prepared['evidenceRequest']['revision'], 0);
      expect(prepared['evidenceRequest']['medicineVersion'], 3);
      expect(prepared['evidenceRequest']['idempotencyKey'], isNotEmpty);
      expect(prepared['evidenceHistory'], hasLength(1));
      expect(posts, isEmpty);
      await tester.tap(find.widgetWithText(FilledButton, '重试原提交'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('确认上传照片'));
      await tester.pumpAndSettle();
      expect(posts.single, prepared['evidenceRequest']);
      expect(posts.single['photos'].single['fields']['rawOcrText'], '  原始文字\n');
    },
  );

  for (final mode in [
    'medicine-changed',
    'source-changed',
    'source-reset',
    'unconfirmed-batch',
  ]) {
    testWidgets('recovery blocks $mode and preserves the original draft', (
      tester,
    ) async {
      final store = MemoryInventoryLocalStore();
      final entry = draft();
      if (mode == 'source-reset') {
        entry['evidenceRequest'] = request(revision: 1);
      }
      if (mode == 'unconfirmed-batch') {
        entry['savedBatchId'] = 'batch-1';
        entry['savedBatchIdConfirmed'] = true;
        entry['recognitionSources']['lotNumber'] = {
          'source': 'manual',
          'photoIds': [],
          'reviewed': true,
        };
      }
      await MedicineDraftQueue(store).save('draft-old', entry);
      var posts = 0;
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => 'synthetic',
        client: MockClient((r) async {
          if (r.method == 'POST') posts++;
          if (r.url.path == '/api/v1/medicines/created') {
            return json(
              latest(3, name: mode == 'medicine-changed' ? '另一种药' : '合成药'),
            );
          }
          if (r.method == 'GET') {
            return json({
              'evidence': mode == 'source-changed'
                  ? responseFor(request())
                  : null,
            });
          }
          throw StateError('unexpected ${r.url.path}');
        }),
      );
      addTearDown(api.close);
      await open(tester, store, api);
      await tester.tap(find.byTooltip('核对来源同步'));
      await tester.pumpAndSettle();
      expect(find.text('确认并准备重试'), findsNothing);
      expect(find.byType(AlertDialog), findsOneWidget);
      await tester.tap(find.text('关闭'));
      await tester.pumpAndSettle();
      final kept = (await MedicineDraftQueue(store).list()).single;
      if (mode == 'source-reset') {
        expect(kept['evidenceRequest'], request(revision: 1));
      } else {
        expect(kept['evidenceRequest'], isNull);
      }
      expect(kept['photos'], hasLength(1));
      expect(posts, 0);
    });
  }
}
