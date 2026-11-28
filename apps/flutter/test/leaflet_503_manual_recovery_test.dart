import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/medicine_draft_queue.dart';
import 'package:home_medicine_flutter/features/medicine/medicine_entry_api_page.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class _InventorySpy extends MemoryInventoryLocalStore {
  int writes = 0;

  @override
  Future<void> saveInventory(List<MedicineRecord> medicines) {
    writes++;
    return super.saveInventory(medicines);
  }
}

void main() {
  testWidgets('leaflet 503 preserves manual and pending review through retry', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final root = await Directory.systemTemp.createTemp('leaflet-503-');
      addTearDown(() => root.delete(recursive: true));
      final recorder = ui.PictureRecorder();
      final canvas = Canvas(recorder)..drawColor(Colors.white, BlendMode.src);
      final ink = Paint()..color = Colors.black;
      for (var i = 0; i < 8; i++) {
        canvas.drawRect(
          Rect.fromLTWH(8, 10.0 + i * 10, 20.0 + (i % 3) * 12, 2),
          ink,
        );
      }
      final picture = recorder.endRecording();
      final image = await picture.toImage(96, 96);
      final encoded = await image.toByteData(format: ui.ImageByteFormat.png);
      image.dispose();
      picture.dispose();
      final bytes = encoded!.buffer.asUint8List();
      expect(bytes.length, greaterThanOrEqualTo(128));
      final file = await File('${root.path}/synthetic.png').writeAsBytes(bytes);
      final store = _InventorySpy();
      final queue = MedicineDraftQueue(store);
      await queue.save('leaflet-503', {
        'name': '合成药品',
        'leaflet': {'purposeSummary': '初始手填', 'packageUsageSummary': '旧建议用法'},
        'photos': [
          {
            'path': file.path,
            'purpose': 'leaflet',
            'state': 'ready',
            'clientPhotoId': 'a',
            'sequence': 1,
            'recognitionStatus': 'recognized',
            'recognitionFields': {
              'leafletText': '旧合成原文',
              'packageUsageSummary': '旧建议用法',
            },
            'recognitionWarnings': ['旧提醒'],
          },
        ],
        'recognitionSources': {
          'purposeSummary': {
            'source': 'manual',
            'photoIds': [],
            'reviewed': true,
          },
          'packageUsageSummary': {
            'source': 'recognized',
            'photoIds': ['a'],
            'reviewed': false,
          },
        },
      });
      final requests = <String>[];
      var recognitionCalls = 0;
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => 'synthetic',
        client: MockClient((request) async {
          requests.add('${request.method} ${request.url.path}');
          if (request.method == 'POST' &&
              request.url.path == '/api/v1/recognitions/medicine') {
            recognitionCalls++;
            final payload = jsonDecode(request.body) as Map;
            expect(payload['purpose'], 'leaflet');
            expect(payload['mimeType'], 'image/png');
            expect(base64Decode(payload['imageBase64'] as String), bytes);
            final body = recognitionCalls == 1
                ? {
                    'error': {
                      'code': 'RECOGNITION_UNAVAILABLE',
                      'message': '识别服务暂时无法连接，请稍后重试，或先手动录入。',
                    },
                  }
                : {
                    'draft': {
                      'leaflet': {
                        'text': '重试合成原文',
                        'packageUsageSummary': '重试建议用法',
                      },
                    },
                    'warnings': ['请核对新建议'],
                    'requiresConfirmation': true,
                  };
            return http.Response.bytes(
              utf8.encode(jsonEncode(body)),
              recognitionCalls == 1 ? 503 : 200,
              headers: {'content-type': 'application/json; charset=utf-8'},
            );
          }
          throw StateError(
            'Unexpected synthetic request: ${request.method} ${request.url.path}',
          );
        }),
      );
      addTearDown(api.close);
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
      await tester.tap(find.byTooltip('导入草稿'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('合成药品'));
      await tester.pumpAndSettle();
      final leaflet = find.text('说明书（选填，识别后请核对）');
      for (var i = 0; i < 20 && leaflet.evaluate().isEmpty; i++) {
        await tester.drag(find.byType(ListView).first, const Offset(0, -350));
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(leaflet, findsOneWidget);
      await Scrollable.ensureVisible(tester.element(leaflet), alignment: 0.2);
      await tester.pumpAndSettle();
      await tester.tap(leaflet);
      await tester.pumpAndSettle();
      final purpose = find.byWidgetPredicate(
        (widget) =>
            widget is TextField && widget.decoration?.labelText == '功能与用途',
      );
      await Scrollable.ensureVisible(tester.element(purpose), alignment: 0.2);
      await tester.pumpAndSettle();
      await tester.enterText(purpose, '人工保留');
      await tester.pumpAndSettle();
      final review = find.text('逐图核对与来源');
      for (var i = 0; i < 20 && review.evaluate().isEmpty; i++) {
        await tester.drag(find.byType(ListView).first, const Offset(0, 350));
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(review, findsOneWidget);
      await Scrollable.ensureVisible(tester.element(review), alignment: 0.2);
      await tester.pumpAndSettle();
      await tester.tap(review);
      await tester.pumpAndSettle();
      await tester.tap(find.text('图1 · 说明书'));
      await tester.pumpAndSettle();
      final dynamic state = tester.state(find.byType(MedicineEntryApiPage));

      Future<void> retry(int expectedCalls) async {
        final button = find.text('重试此图');
        for (var i = 0; i < 20 && button.evaluate().isEmpty; i++) {
          await tester.drag(find.byType(ListView).first, const Offset(0, 350));
          await tester.pump(const Duration(milliseconds: 100));
        }
        expect(button, findsOneWidget);
        await Scrollable.ensureVisible(tester.element(button), alignment: 0.3);
        await tester.pumpAndSettle();
        await tester.tap(button);
        await tester.pumpAndSettle();
        expect(find.text('重新识别这张照片？'), findsOneWidget);
        await tester.tap(find.text('AI 识别'));
        for (
          var i = 0;
          i < 200 &&
              (recognitionCalls < expectedCalls || state.recognizing == true);
          i++
        ) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
          await tester.pump();
        }
        await tester.pumpAndSettle();
        expect(recognitionCalls, expectedCalls);
        expect(state.recognizing, false);
      }

      Future<void> expectPreserved() async {
        final photo = state.photoDrafts.single as Map;
        expect(photo['recognitionStatus'], 'recognized');
        expect(photo['recognitionFields']['leafletText'], '旧合成原文');
        expect(photo['recognitionFields']['packageUsageSummary'], '旧建议用法');
        expect(state.leafletControllers['purposeSummary'].text, '人工保留');
        expect(state.review.toJson()['purposeSummary']['reviewed'], true);
        expect(state.review.toJson()['packageUsageSummary']['reviewed'], false);
        expect(await file.exists(), true);
        expect(store.writes, 0);
        expect(await store.readInventory(), isNull);
        expect(
          requests.where(
            (value) => RegExp(
              r'^(POST|PUT|PATCH|DELETE) /api/v1/(medicines|medication-batches)(/|$)',
            ).hasMatch(value),
          ),
          isEmpty,
        );
      }

      await expectPreserved();
      await retry(1);
      await expectPreserved();
      expect(state.photoDrafts.single['retryStatus'], 'failed');
      expect(state.recognitionFailure, isA<ApiException>());
      expect((state.recognitionFailure as ApiException).statusCode, 503);
      const failureText = '识别失败，可继续手动保存：识别服务暂时无法连接，请稍后重试，或先手动录入。';
      final failure = find.text(failureText, skipOffstage: false);
      expect(failure, findsOneWidget);
      await Scrollable.ensureVisible(tester.element(failure), alignment: 0.3);
      await tester.pumpAndSettle();
      expect(find.text(failureText), findsOneWidget);
      expect(find.textContaining('未能识别说明书', skipOffstage: false), findsNothing);
      final saved = (await queue.list()).single;
      expect(saved['leaflet']['purposeSummary'], '人工保留');
      expect(
        saved['recognitionSources']['packageUsageSummary']['reviewed'],
        false,
      );

      await retry(2);
      await expectPreserved();
      expect(state.recognitionFailure, isNull);
      expect(state.photoDrafts.single['retryStatus'], 'review');
      expect(
        state.photoDrafts.single['retryFields']['packageUsageSummary'],
        '重试建议用法',
      );
      final pending = find.textContaining('重新识别得到不同结果', skipOffstage: false);
      expect(pending, findsOneWidget);
      await Scrollable.ensureVisible(tester.element(pending), alignment: 0.3);
      await tester.pumpAndSettle();
      expect(find.textContaining('重新识别得到不同结果'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
    });
  });
}
