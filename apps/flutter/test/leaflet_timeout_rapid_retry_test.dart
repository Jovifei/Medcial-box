import 'dart:async';
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
  for (final scenario in ['timeout', 'rapid taps']) {
    testWidgets('leaflet $scenario preserves manual and pending review', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final root = await Directory.systemTemp.createTemp('leaflet-boundary-');
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
        final file = await File('${root.path}/synthetic.png')
            .writeAsBytes(bytes);
        final store = _InventorySpy();
        final queue = MedicineDraftQueue(store);
        await queue.save('leaflet-boundary', {
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
        final pending = Completer<http.Response>();
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
              if (scenario == 'timeout') {
                throw TimeoutException('synthetic transport timeout');
              }
              return pending.future;
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

        try {
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
            await tester.drag(
              find.byType(ListView).first,
              const Offset(0, -350),
            );
            await tester.pump(const Duration(milliseconds: 100));
          }
          expect(leaflet, findsOneWidget);
          await Scrollable.ensureVisible(
            tester.element(leaflet),
            alignment: 0.2,
          );
          await tester.pumpAndSettle();
          await tester.tap(leaflet);
          await tester.pumpAndSettle();
          final purpose = find.byWidgetPredicate(
            (widget) =>
                widget is TextField && widget.decoration?.labelText == '功能与用途',
          );
          await Scrollable.ensureVisible(
            tester.element(purpose),
            alignment: 0.2,
          );
          await tester.pumpAndSettle();
          await tester.enterText(purpose, '人工保留');
          await tester.pumpAndSettle();
          final review = find.text('逐图核对与来源');
          for (var i = 0; i < 20 && review.evaluate().isEmpty; i++) {
            await tester.drag(
              find.byType(ListView).first,
              const Offset(0, 350),
            );
            await tester.pump(const Duration(milliseconds: 100));
          }
          expect(review, findsOneWidget);
          await Scrollable.ensureVisible(
            tester.element(review),
            alignment: 0.2,
          );
          await tester.pumpAndSettle();
          await tester.tap(review);
          await tester.pumpAndSettle();
          await tester.tap(find.text('图1 · 说明书'));
          await tester.pumpAndSettle();
          final dynamic state = tester.state(find.byType(MedicineEntryApiPage));

          Future<void> expectPreserved() async {
            final photo = state.photoDrafts.single as Map;
            expect(photo['path'], file.path);
            expect(photo['recognitionStatus'], 'recognized');
            expect(photo['recognitionFields']['leafletText'], '旧合成原文');
            expect(photo['recognitionFields']['packageUsageSummary'], '旧建议用法');
            expect(state.leafletControllers['purposeSummary'].text, '人工保留');
            expect(state.review.toJson()['purposeSummary']['reviewed'], true);
            expect(
              state.review.toJson()['packageUsageSummary']['reviewed'],
              false,
            );
            expect(await file.exists(), true);
            expect(store.writes, 0);
            expect(await store.readInventory(), isNull);
            expect(
              requests,
              everyElement('POST /api/v1/recognitions/medicine'),
            );
          }

          final retry = find.text('重试此图');
          for (var i = 0; i < 20 && retry.evaluate().isEmpty; i++) {
            await tester.drag(
              find.byType(ListView).first,
              const Offset(0, 350),
            );
            await tester.pump(const Duration(milliseconds: 100));
          }
          expect(retry, findsOneWidget);
          await Scrollable.ensureVisible(tester.element(retry), alignment: 0.3);
          await tester.pumpAndSettle();
          await expectPreserved();

          final beforeClicks = state.recognitionRequest as int;
          final retryOffset = tester.getCenter(retry);
          final watch = Stopwatch()..start();
          await tester.tapAt(retryOffset);
          if (scenario == 'rapid taps') await tester.tapAt(retryOffset);
          watch.stop();
          await tester.pumpAndSettle();
          expect(find.text('重新识别这张照片？'), findsOneWidget);
          final prompts = find
              .text('重新识别这张照片？', skipOffstage: false)
              .evaluate()
              .length;
          expect(prompts, 1);
          expect(state.recognitionRequest - beforeClicks, 1);
          debugPrint(
            'SYNTHETIC_TAPS scenario=$scenario clicks=${scenario == 'rapid taps' ? 2 : 1} '
            'elapsed_ms=${watch.elapsedMilliseconds} request_epochs=${state.recognitionRequest - beforeClicks} prompts=$prompts',
          );
          await tester.tap(find.text('AI 识别').last);
          for (var i = 0; i < 200 && recognitionCalls == 0; i++) {
            await Future<void>.delayed(const Duration(milliseconds: 10));
            await tester.pump();
          }
          expect(recognitionCalls, 1);

          if (scenario == 'timeout') {
            for (var i = 0; i < 200 && state.recognizing == true; i++) {
              await Future<void>.delayed(const Duration(milliseconds: 10));
              await tester.pump();
            }
            await tester.pumpAndSettle();
            expect(state.recognizing, false);
            expect(state.recognitionFailure, isA<ApiNetworkException>());
            expect(
              (state.recognitionFailure as ApiNetworkException).message,
              '连接超时，请检查网络后重试。',
            );
            expect(state.photoDrafts.single['retryStatus'], 'failed');
            const failureText = '识别失败，可继续手动保存：连接超时，请检查网络后重试。';
            final failure = find.text(failureText, skipOffstage: false);
            expect(failure, findsOneWidget);
            await Scrollable.ensureVisible(
              tester.element(failure),
              alignment: 0.3,
            );
            await tester.pumpAndSettle();
            expect(find.text(failureText), findsOneWidget);
            final saved = (await queue.list()).single;
            expect(saved['leaflet']['purposeSummary'], '人工保留');
            expect(
              saved['recognitionSources']['packageUsageSummary']['reviewed'],
              false,
            );
            await expectPreserved();
          } else {
            expect(state.recognizing, true);
            await expectPreserved();
            await tester.pump(const Duration(milliseconds: 400));
            expect(find.text('重新识别这张照片？'), findsNothing);
            expect(recognitionCalls, 1);
            final retryButton = find.widgetWithText(TextButton, '重试此图');
            await Scrollable.ensureVisible(
              tester.element(retryButton),
              alignment: 0.3,
            );
            await tester.pump(const Duration(milliseconds: 100));
            expect(tester.widget<TextButton>(retryButton).onPressed, isNull);
            final disabledOffset = tester.getCenter(retryButton);
            await tester.tapAt(disabledOffset);
            await tester.tapAt(disabledOffset);
            await tester.pump(const Duration(milliseconds: 100));
            debugPrint(
              'SYNTHETIC_INFLIGHT disabled_taps=2 calls=$recognitionCalls',
            );
            expect(recognitionCalls, 1);
            await expectPreserved();
            pending.complete(
              http.Response.bytes(
                utf8.encode(
                  jsonEncode({
                    'draft': {
                      'leaflet': {
                        'text': '重试合成原文',
                        'packageUsageSummary': '重试建议用法',
                      },
                    },
                    'warnings': ['请核对新建议'],
                    'requiresConfirmation': true,
                  }),
                ),
                200,
                headers: {'content-type': 'application/json; charset=utf-8'},
              ),
            );
            for (var i = 0; i < 200 && state.recognizing == true; i++) {
              await Future<void>.delayed(const Duration(milliseconds: 10));
              await tester.pump();
            }
            await tester.pumpAndSettle();
            expect(state.recognizing, false);
            expect(recognitionCalls, 1);
            expect(state.photoDrafts.single['retryStatus'], 'review');
            expect(
              state.photoDrafts.single['retryFields']['packageUsageSummary'],
              '重试建议用法',
            );
            await expectPreserved();
          }
        } finally {
          if (!pending.isCompleted) {
            pending.complete(http.Response('{}', 500));
          }
          await tester.pumpWidget(const SizedBox());
          await tester.pumpAndSettle();
        }
      });
    });
  }
}
