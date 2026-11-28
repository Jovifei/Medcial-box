import 'dart:convert';
import 'dart:io';

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
// Platform adapters used by the existing image-picker and path-provider plugins.
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

void main() {
  testWidgets('empty leaflet retry preserves the previous result and review', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final root = await Directory.systemTemp.createTemp('leaflet-retry-');
      addTearDown(() async => root.delete(recursive: true));
      final bytes = List<int>.filled(128, 0)
        ..setRange(0, 8, [137, 80, 78, 71, 13, 10, 26, 10])
        ..setRange(120, 128, [73, 69, 78, 68, 174, 66, 96, 130]);
      final file = await File('${root.path}/synthetic.png').writeAsBytes(bytes);
      final store = MemoryInventoryLocalStore();
      await MedicineDraftQueue(store).save('leaflet-retry', {
        'name': '旧名称',
        'leaflet': {'purposeSummary': '人工保留'},
        'photos': [
          {
            'path': file.path,
            'purpose': 'leaflet',
            'state': 'ready',
            'clientPhotoId': 'a',
            'sequence': 1,
            'recognitionStatus': 'recognized',
            'recognitionFields': {'leafletText': '原说明书原文'},
            'recognitionWarnings': ['旧提醒'],
          },
        ],
        'recognitionSources': {
          'purposeSummary': {
            'source': 'manual',
            'photoIds': [],
            'reviewed': true,
          },
        },
      });
      final requests = <String>[];
      String? purpose;
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => 'synthetic',
        client: MockClient((request) async {
          requests.add('${request.method} ${request.url.path}');
          if (request.url.path == '/api/v1/recognitions/medicine') {
            purpose = (jsonDecode(request.body) as Map)['purpose'] as String?;
          }
          return http.Response.bytes(
            utf8.encode(
              '{"draft":{"name":"合成新名称","purposeTags":["fever"],"leaflet":{}},"warnings":["新提醒"],"requiresConfirmation":true}',
            ),
            200,
          );
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
      await tester.tap(find.byTooltip('导入草稿'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('旧名称'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('逐图核对与来源'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('图1 · 说明书'));
      await tester.pumpAndSettle();
      final retry = find.text('重试此图');
      await Scrollable.ensureVisible(tester.element(retry), alignment: 0.3);
      await tester.pumpAndSettle();
      await tester.tap(retry);
      await tester.pumpAndSettle();
      await tester.tap(find.text('AI 识别'));
      final dynamic state = tester.state(find.byType(MedicineEntryApiPage));
      for (
        var i = 0;
        i < 150 && (purpose == null || state.recognizing == true);
        i++
      ) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
        await tester.pump();
      }
      await tester.pumpAndSettle();
      expect(purpose, 'leaflet');
      final photo = state.photoDrafts.single as Map;
      expect(photo['recognitionStatus'], 'recognized');
      expect(photo['retryStatus'], 'failed');
      expect(photo['recognitionFields']['leafletText'], '原说明书原文');
      expect(photo['recognitionWarnings'], contains('旧提醒'));
      expect(photo['recognitionWarnings'], contains('新提醒'));
      expect(
        (photo['recognitionWarnings'] as List).join(' '),
        contains('说明书未提取'),
      );
      expect(state.leafletControllers['purposeSummary'].text, '人工保留');
      expect(state.nameController.text, '旧名称');
      expect(state.review.toJson()['purposeSummary']['reviewed'], true);
      expect(await file.exists(), true);
      expect(
        requests.where((call) => call.startsWith('POST /api/v1/medicines')),
        isEmpty,
      );
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
    });
  });

  for (final entry in <String, Object?>{
    'missing leaflet': {},
    'empty leaflet': {'leaflet': <String, dynamic>{}},
    'blank text': {
      'leaflet': {'text': '  '},
    },
    'metadata without leaflet text': {
      'name': '合成药',
      'brand': '合成品牌',
      'purposeTags': ['fever'],
      'leaflet': {'text': '  '},
    },
    'invalid draft': null,
    'invalid tags': {
      'populationTags': ['not-a-population'],
      'purposeTags': ['not-a-purpose'],
    },
    'visible text': {
      'leaflet': {'text': '合成说明书原文'},
    },
  }.entries) {
    testWidgets('leaflet ${entry.key} keeps manual data and waits for review', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final root = await Directory.systemTemp.createTemp(
          'leaflet-recognition-',
        );
        final originalPicker = ImagePickerPlatform.instance;
        final originalPaths = PathProviderPlatform.instance;
        addTearDown(() async {
          ImagePickerPlatform.instance = originalPicker;
          PathProviderPlatform.instance = originalPaths;
          await root.delete(recursive: true);
        });
        final bytes = List<int>.filled(128, 0)
          ..setRange(0, 8, [137, 80, 78, 71, 13, 10, 26, 10])
          ..setRange(120, 128, [73, 69, 78, 68, 174, 66, 96, 130]);
        final file = await File('${root.path}/synthetic.png')
            .writeAsBytes(bytes);
        ImagePickerPlatform.instance = _Picker(file.path);
        PathProviderPlatform.instance = _Paths(root.path);
        final requests = <String>[];
        String? purpose;
        final api = ApiClient(
          baseUrl: 'https://synthetic.invalid',
          tokenProvider: () async => 'synthetic',
          client: MockClient((request) async {
            requests.add('${request.method} ${request.url.path}');
            if (request.url.path == '/api/v1/recognitions/medicine') {
              purpose = (jsonDecode(request.body) as Map)['purpose'] as String?;
              return http.Response.bytes(
                utf8.encode(
                  jsonEncode({
                    'draft': entry.value,
                    'warnings': [
                      '模型提醒',
                      if (entry.key == 'empty leaflet')
                        '未能识别说明书文字，可重拍或手动填写。',
                    ],
                    'requiresConfirmation': true,
                  }),
                ),
                200,
              );
            }
            return http.Response('{"candidates":[],"warnings":[]}', 200);
          }),
        );
        addTearDown(api.close);
        final store = MemoryInventoryLocalStore();
        tester.view.physicalSize = const Size(500, 1200);
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
        final section = find.text('说明书（选填，识别后请核对）');
        await Scrollable.ensureVisible(tester.element(section), alignment: 0.2);
        await tester.pumpAndSettle();
        await tester.tap(section);
        await tester.pumpAndSettle();
        final usage = find.byWidgetPredicate(
          (w) => w is TextField && w.decoration?.labelText == '用法用量',
        );
        await Scrollable.ensureVisible(tester.element(usage), alignment: 0.2);
        await tester.pumpAndSettle();
        await tester.enterText(usage, '人工填写');
        await tester.pumpAndSettle();
        final button = find.text('拍说明书识别文字');
        await Scrollable.ensureVisible(tester.element(button), alignment: 0.2);
        await tester.pumpAndSettle();
        await tester.tap(button);
        for (
          var i = 0;
          i < 150 && find.text('识别说明书文字？').evaluate().isEmpty;
          i++
        ) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
          await tester.pump();
        }
        expect(find.text('识别说明书文字？'), findsOneWidget);
        await tester.tap(find.text('AI 识别').last);
        final dynamic state = tester.state(
          find.byType(MedicineEntryApiPage, skipOffstage: false),
        );
        for (
          var i = 0;
          i < 200 && (purpose == null || state.recognizing == true);
          i++
        ) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
          await tester.pump();
        }
        await tester.pumpAndSettle();
        expect(purpose, 'leaflet');
        expect(state.leafletControllers['packageUsageSummary'].text, '人工填写');
        expect(state.review.toJson()['packageUsageSummary']['reviewed'], true);
        expect(
          requests.where((call) => call.startsWith('POST /api/v1/medicines')),
          isEmpty,
        );
        final photo = state.photoDrafts.single as Map;
        if (entry.key == 'visible text') {
          expect(photo['recognitionStatus'], 'recognized');
          expect(photo['recognitionFields']['leafletText'], '合成说明书原文');
        } else {
          expect(photo['recognitionStatus'], 'failed');
          expect(photo['recognitionFields'], isNull);
          expect(state.nameController.text, isEmpty);
          if (entry.key == 'invalid draft') {
            expect(state.recognitionFailure, isNotNull);
          } else {
            expect(
              (photo['recognitionWarnings'] as List).join(' '),
              contains('说明书未提取'),
            );
            expect(photo['recognitionWarnings'], contains('模型提醒'));
            expect(
              find.textContaining('说明书未提取', skipOffstage: false),
              findsWidgets,
            );
            expect(
              find.textContaining('未能识别说明书', skipOffstage: false),
              findsNothing,
            );
            await Scrollable.ensureVisible(tester.element(usage), alignment: 0.2);
            await tester.pumpAndSettle();
            await tester.enterText(usage, '空结果后手填');
            await tester.pumpAndSettle();
            expect(state.leafletControllers['packageUsageSummary'].text, '空结果后手填');
            expect(
              requests.where((call) => call.startsWith('POST /api/v1/medicines')),
              isEmpty,
            );
          }
          expect(
            (state.review.toJson() as Map).values.where(
              (v) => (v as Map)['source'] == 'recognized',
            ),
            isEmpty,
          );
        }
        await tester.pumpWidget(const SizedBox());
        await tester.pumpAndSettle();
      });
    });
  }
}
