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
  for (final phase in ['send', 'body']) {
    testWidgets('leaflet $phase uses the configured 70 second timeout', (
      tester,
    ) async {
      final fixture = await tester.runAsync(() async {
        final root = await Directory.systemTemp.createTemp('leaflet-timeout-');
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
        final file = await File('${root.path}/synthetic.png')
            .writeAsBytes(bytes);
        return (root: root, file: file, bytes: bytes);
      });
      expect(fixture, isNotNull);
      final root = fixture!.root;
      final file = fixture.file;
      final bytes = fixture.bytes;
      expect(bytes.length, greaterThanOrEqualTo(128));
      tester.view.physicalSize = const Size(500, 1200);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      final store = _InventorySpy();
      final queue = MedicineDraftQueue(store);
      await queue.save('leaflet-timeout', {
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
      final neverSend = Completer<http.StreamedResponse>();
      var bodyListening = false;
      final neverBody = StreamController<List<int>>(
        onListen: () => bodyListening = true,
      );
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => 'synthetic',
        client: MockClient.streaming((request, requestBody) async {
          requests.add('${request.method} ${request.url.path}');
          expect(request.method, 'POST');
          expect(request.url.path, '/api/v1/recognitions/medicine');
          final payload =
              jsonDecode(utf8.decode(await requestBody.toBytes())) as Map;
          expect(payload['purpose'], 'leaflet');
          expect(payload['mimeType'], 'image/png');
          expect(base64Decode(payload['imageBase64'] as String), bytes);
          if (phase == 'send') return neverSend.future;
          return http.StreamedResponse(
            neverBody.stream,
            200,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
        }),
      );

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
          expect(file.existsSync(), true);
          expect(store.writes, 0);
          expect(await store.readInventory(), isNull);
          expect(requests, ['POST /api/v1/recognitions/medicine']);
        }

        final retry = find.text('重试此图');
        for (var i = 0; i < 20 && retry.evaluate().isEmpty; i++) {
          await tester.drag(find.byType(ListView).first, const Offset(0, 350));
          await tester.pump(const Duration(milliseconds: 100));
        }
        expect(retry, findsOneWidget);
        await Scrollable.ensureVisible(tester.element(retry), alignment: 0.3);
        await tester.pumpAndSettle();
        await tester.tap(retry);
        await tester.pumpAndSettle();
        expect(find.text('重新识别这张照片？'), findsOneWidget);
        await tester.tap(find.text('AI 识别'));

        for (
          var i = 0;
          i < 200 && (requests.isEmpty || (phase == 'body' && !bodyListening));
          i++
        ) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 5)),
          );
          await tester.pump();
        }
        expect(requests.length, 1);
        if (phase == 'body') expect(bodyListening, true);
        expect(state.recognizing, true);
        expect(state.recognitionFailure, isNull);
        expect(state.photoDrafts.single['retryStatus'], 'pending');
        await expectPreserved();

        final startedAt = tester.binding.clock.now();
        await tester.pump(const Duration(milliseconds: 69999));
        expect(state.recognizing, true);
        expect(state.recognitionFailure, isNull);
        expect(state.photoDrafts.single['retryStatus'], 'pending');
        await expectPreserved();
        final beforeTimeout = tester.binding.clock
            .now()
            .difference(startedAt)
            .inMilliseconds;
        expect(beforeTimeout, 69999);
        debugPrint(
          'PRODUCT_TIMEOUT phase=$phase elapsed_ms=$beforeTimeout pending=true requests=${requests.length} inventory_writes=${store.writes}',
        );

        await tester.pump(const Duration(milliseconds: 1));
        await tester.pump();
        expect(state.recognizing, false);
        expect(state.recognitionFailure, isA<ApiNetworkException>());
        expect(
          (state.recognitionFailure as ApiNetworkException).message,
          '连接超时，请检查网络后重试。',
        );
        expect(state.photoDrafts.single['retryStatus'], 'failed');
        await expectPreserved();
        final saved = (await queue.list()).single;
        expect(saved['leaflet']['purposeSummary'], '人工保留');
        expect(
          saved['recognitionSources']['packageUsageSummary']['reviewed'],
          false,
        );
        final afterTimeout = tester.binding.clock
            .now()
            .difference(startedAt)
            .inMilliseconds;
        expect(afterTimeout, 70000);
        debugPrint(
          'PRODUCT_TIMEOUT phase=$phase elapsed_ms=$afterTimeout failed=true requests=${requests.length} inventory_writes=${store.writes}',
        );
        const failureText = '识别失败，可继续手动保存：连接超时，请检查网络后重试。';
        final failure = find.text(failureText, skipOffstage: false);
        expect(failure, findsOneWidget);
        await Scrollable.ensureVisible(tester.element(failure), alignment: 0.3);
        await tester.pumpAndSettle();
        expect(find.text(failureText), findsOneWidget);
      } finally {
        api.close();
        unawaited(neverBody.close());
        await tester.pumpWidget(const SizedBox());
        await tester.pumpAndSettle();
        await tester.runAsync(() => root.delete(recursive: true));
      }
    });
  }
}
