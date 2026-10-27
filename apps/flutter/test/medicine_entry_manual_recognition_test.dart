import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/medicine_draft_queue.dart';
import 'package:home_medicine_flutter/data/medicine_recognition.dart';
import 'package:home_medicine_flutter/features/medicine/medicine_entry_api_page.dart';
import 'package:home_medicine_flutter/features/medicine/leaflet_photo_page.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
// Test adapters for the interfaces supplied by existing plugins.
// ignore: depend_on_referenced_packages
import 'package:image_picker_platform_interface/image_picker_platform_interface.dart';
// ignore: depend_on_referenced_packages
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';

class _Picker extends ImagePickerPlatform {
  _Picker(this.path);
  final String path;
  @override
  Future<XFile?> getImageFromSource({
    required ImageSource source,
    ImagePickerOptions options = const ImagePickerOptions(),
  }) async => XFile(path);
}

class _Paths extends PathProviderPlatform {
  _Paths(this.path);
  final String path;
  @override
  Future<String?> getApplicationSupportPath() async => path;
}

class _LocalRecognition implements MedicineRecognitionRepository {
  @override
  Future<MedicineRecognitionDraft> recognize(XFile image) async =>
      const MedicineRecognitionDraft(
        name: '合成药',
        specification: '',
        expiry: '待补充',
        rawText: '  本机原文\n第二行\t',
        warnings: ['请核对原文'],
      );
}

void main() {
  testWidgets(
    'local OCR raw text survives evidence save and photo page reopen',
    (tester) async {
      await tester.runAsync(() async {
        final root = await Directory.systemTemp.createTemp(
          'medicine-local-ocr-',
        );
        final oldPicker = ImagePickerPlatform.instance;
        final oldPaths = PathProviderPlatform.instance;
        addTearDown(() async {
          ImagePickerPlatform.instance = oldPicker;
          PathProviderPlatform.instance = oldPaths;
          await root.delete(recursive: true);
        });
        final bytes = List<int>.filled(128, 0)
          ..setRange(0, 8, [137, 80, 78, 71, 13, 10, 26, 10])
          ..setRange(120, 128, [73, 69, 78, 68, 174, 66, 96, 130]);
        final file = await File('${root.path}/synthetic.png')
            .writeAsBytes(bytes);
        ImagePickerPlatform.instance = _Picker(file.path);
        PathProviderPlatform.instance = _Paths(root.path);
        final store = MemoryInventoryLocalStore();
        Map<String, dynamic>? remoteEvidence;
        final api = ApiClient(
          baseUrl: 'https://synthetic.invalid',
          tokenProvider: () async => 'synthetic',
          client: MockClient((r) async {
            http.Response response(Object value) =>
                http.Response.bytes(utf8.encode(jsonEncode(value)), 200);
            if (r.method == 'POST' && r.url.path == '/api/v1/medicines') {
              return response({
                'id': 'created',
                'name': '合成药',
                'version': 1,
                'batches': [],
              });
            }
            if (r.url.path == '/api/v1/medicines/created') {
              return response({
                'id': 'created',
                'name': '合成药',
                'version': 1,
                'batches': [],
              });
            }
            if (r.url.path.endsWith('/leaflet-photos') && r.method == 'POST') {
              return response({
                'photo': {
                  'id': '00000000-0000-4000-8000-000000000001',
                  'medicineId': 'created',
                  'contentType': 'image/png',
                  'sizeBytes': 128,
                  'createdAt': '2026-10-27',
                  'url': '/synthetic',
                },
              });
            }
            if (r.url.path.endsWith('/leaflet-photos') && r.method == 'GET') {
              return response({'photos': []});
            }
            if (r.url.path.endsWith('/recognition-evidence') &&
                r.method == 'GET') {
              return response({
                'evidence': remoteEvidence,
                'capabilities': {'coverPhotoVersionGuard': true},
              });
            }
            if (r.url.path.endsWith('/recognition-evidence') &&
                r.method == 'POST') {
              final sent = jsonDecode(r.body) as Map<String, dynamic>;
              remoteEvidence = {
                'schemaVersion': 1,
                'revision': 1,
                'medicineVersion': 1,
                'currentMedicineVersion': 1,
                'stale': false,
                'photos': [
                  for (final item in sent['photos'] as List)
                    {...item as Map<String, dynamic>, 'available': true},
                ],
                'fieldSources': sent['fieldSources'],
              };
              return response({'evidence': remoteEvidence});
            }
            throw StateError('unexpected ${r.method} ${r.url.path}');
          }),
        );
        addTearDown(api.close);
        final repository = ApiMedicineRepository(api: api, localStore: store);
        final workflow = ApiWorkflowRepository(api: api);
        await tester.pumpWidget(
          MaterialApp(
            home: MedicineEntryApiPage(
              repository: repository,
              workflow: workflow,
              localStore: store,
              localRecognition: _LocalRecognition(),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('拍药盒'));
        for (var i = 0; i < 100 && find.text('仅本机识别').evaluate().isEmpty; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
          await tester.pump();
        }
        await tester.tap(find.text('仅本机识别'));
        for (var i = 0; i < 60; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
          await tester.pump();
        }
        final dynamic state = tester.state(find.byType(MedicineEntryApiPage));
        expect(state.nameController.text, '合成药');
        state.usePhotoAsCover = false;
        await tester.tap(find.widgetWithText(FilledButton, '核对后保存'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('确认上传照片'));
        for (var i = 0; i < 100 && remoteEvidence == null; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
          await tester.pump();
        }
        expect(
          remoteEvidence!['photos'].single['fields']['rawOcrText'],
          '  本机原文\n第二行\t',
        );
        expect(remoteEvidence!['photos'].single['warnings'], ['请核对原文']);
        await tester.pumpWidget(
          MaterialApp(
            home: LeafletPhotoPage(medicineId: 'created', repository: workflow),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('本机识别原文：  本机原文\n第二行\t'), findsOneWidget);
      });
    },
  );

  testWidgets(
    'different retry result waits for explicit field selection and preserves manual text',
    (tester) async {
      await tester.runAsync(() async {
        final root = await Directory.systemTemp.createTemp(
          'medicine-retry-test-',
        );
        addTearDown(() async => root.delete(recursive: true));
        final bytes = List<int>.filled(128, 0)
          ..setRange(0, 8, [137, 80, 78, 71, 13, 10, 26, 10])
          ..setRange(120, 128, [73, 69, 78, 68, 174, 66, 96, 130]);
        final file = await File('${root.path}/synthetic.png')
            .writeAsBytes(bytes);
        final store = MemoryInventoryLocalStore();
        await MedicineDraftQueue(store).save('retry-draft', {
          'name': '旧名称',
          'leaflet': {'purposeSummary': '人工保留'},
          'photos': [
            {
              'path': file.path,
              'purpose': 'box_front',
              'state': 'ready',
              'clientPhotoId': 'a',
              'sequence': 1,
              'recognitionStatus': 'recognized',
              'recognitionFields': {'name': '旧名称', 'purposeSummary': '旧识别用途'},
              'recognitionWarnings': ['旧提醒'],
            },
          ],
          'recognitionSources': {
            'name': {
              'source': 'recognized',
              'photoIds': ['a'],
              'reviewed': true,
            },
            'purposeSummary': {
              'source': 'manual',
              'photoIds': [],
              'reviewed': true,
            },
          },
        });
        final api = ApiClient(
          baseUrl: 'https://synthetic.invalid',
          tokenProvider: () async => 'synthetic',
          client: MockClient(
            (request) async => http.Response.bytes(
              utf8.encode(
                jsonEncode({
                  'draft': {
                    'name': '新名称',
                    'leaflet': {'purposeSummary': '新识别用途'},
                  },
                  'warnings': ['新提醒'],
                }),
              ),
              200,
            ),
          ),
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
        await tester.tap(find.byTooltip('导入草稿'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('旧名称'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('逐图核对与来源'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('图1 · 药盒'));
        await tester.pumpAndSettle();
        final retry = find.text('重试此图');
        await Scrollable.ensureVisible(tester.element(retry), alignment: 0.3);
        await tester.pumpAndSettle();
        await tester.tap(retry);
        await tester.pumpAndSettle();
        await tester.tap(find.text('AI 识别'));
        for (
          var i = 0;
          i < 60 && find.textContaining('使用本次药名：新名称').evaluate().isEmpty;
          i++
        ) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
          await tester.pump();
        }
        final dynamic state = tester.state(find.byType(MedicineEntryApiPage));
        expect(state.nameController.text, '旧名称');
        expect(state.leafletControllers['purposeSummary'].text, '人工保留');
        await tester.tap(find.widgetWithText(FilledButton, '核对后保存'));
        await tester.pump(const Duration(milliseconds: 200));
        expect(find.text('请先完成照片的重识别核对，原结果已保留。'), findsOneWidget);
        final accept = find.textContaining('使用本次药名：新名称');
        await Scrollable.ensureVisible(tester.element(accept), alignment: 0.3);
        await tester.pump(const Duration(milliseconds: 200));
        await tester.tap(accept);
        expect(state.photoDrafts.single['retryAccepted'], true);
        expect(state.photoDrafts.single['retryWarnings'], ['新提醒']);
        final done = find.text('完成重识别核对');
        await Scrollable.ensureVisible(tester.element(done), alignment: 0.3);
        await tester.pump(const Duration(milliseconds: 200));
        await tester.tap(done);
        await tester.pump(const Duration(milliseconds: 250));
        await Future<void>.delayed(const Duration(milliseconds: 260));
        await tester.pumpAndSettle();
        expect(state.photoDrafts.single['recognitionWarnings'], ['旧提醒', '新提醒']);
        expect(state.nameController.text, '新名称');
        expect(state.leafletControllers['purposeSummary'].text, '人工保留');
        final draft = (await MedicineDraftQueue(store).list()).single;
        expect(draft['photos'].single['recognitionWarnings'], ['旧提醒', '新提醒']);
        expect(draft['recognitionSources']['name']['reviewed'], true);
      });
    },
  );

  testWidgets(
    'manual clear during recognition and cancelling all populations survive the late result',
    (tester) async {
      await tester.runAsync(() async {
        final root = await Directory.systemTemp.createTemp(
          'medicine-review-test-',
        );
        final oldPicker = ImagePickerPlatform.instance;
        final oldPaths = PathProviderPlatform.instance;
        addTearDown(() async {
          ImagePickerPlatform.instance = oldPicker;
          PathProviderPlatform.instance = oldPaths;
          await root.delete(recursive: true);
        });
        final bytes = List<int>.filled(128, 0)
          ..setRange(0, 8, [137, 80, 78, 71, 13, 10, 26, 10])
          ..setRange(120, 128, [73, 69, 78, 68, 174, 66, 96, 130]);
        final file = await File('${root.path}/synthetic.png')
            .writeAsBytes(bytes);
        ImagePickerPlatform.instance = _Picker(file.path);
        PathProviderPlatform.instance = _Paths(root.path);
        final entered = Completer<void>();
        final result = Completer<http.Response>();
        final store = MemoryInventoryLocalStore();
        final api = ApiClient(
          baseUrl: 'https://synthetic.invalid',
          tokenProvider: () async => 'synthetic',
          client: MockClient((request) {
            entered.complete();
            return result.future;
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
        await tester.tap(find.text('拍药盒'));
        for (var i = 0; i < 100 && find.text('AI 识别').evaluate().isEmpty; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
          await tester.pump();
        }
        await tester.tap(find.text('AI 识别').last);
        await tester.pump();
        await entered.future;
        final name = find.byWidgetPredicate(
          (widget) =>
              widget is TextField &&
              widget.decoration?.hintText == '例如：布洛芬缓释胶囊',
        );
        await Scrollable.ensureVisible(tester.element(name), alignment: 0.3);
        await tester.pump(const Duration(milliseconds: 200));
        await tester.enterText(name, '人工临时值');
        await tester.enterText(name, '');
        final category = find.text('用途与人群（请核对）');
        for (var i = 0; i < 20 && category.evaluate().isEmpty; i++) {
          await tester.drag(find.byType(ListView).first, const Offset(0, -300));
          await tester.pump(const Duration(milliseconds: 100));
        }
        await Scrollable.ensureVisible(
          tester.element(category),
          alignment: 0.3,
        );
        await tester.pump(const Duration(milliseconds: 200));
        await tester.tap(category);
        await tester.pump(const Duration(milliseconds: 200));
        final adult = find.widgetWithText(FilterChip, '成人');
        await Scrollable.ensureVisible(tester.element(adult), alignment: 0.4);
        await tester.pump(const Duration(milliseconds: 200));
        await tester.tap(adult);
        await tester.pump(const Duration(milliseconds: 200));
        await tester.tap(adult);
        await tester.pump(const Duration(milliseconds: 200));
        result.complete(
          http.Response.bytes(
            utf8.encode(
              jsonEncode({
                'draft': {
                  'name': '机器建议',
                  'populationTags': ['adult'],
                },
                'warnings': [],
              }),
            ),
            200,
          ),
        );
        for (var i = 0; i < 40; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
          await tester.pump();
        }
        final dynamic state = tester.state(find.byType(MedicineEntryApiPage));
        expect(state.nameController.text, '');
        expect(state.populationTags, isEmpty);
        final draft = (await MedicineDraftQueue(store).list()).single;
        expect(draft['recognitionSources']['name']['source'], 'manual');
        expect(
          draft['recognitionSources']['populationTags']['source'],
          'manual',
        );
        expect(draft['photos'].single['recognitionFields']['name'], '机器建议');
      });
    },
  );
}
