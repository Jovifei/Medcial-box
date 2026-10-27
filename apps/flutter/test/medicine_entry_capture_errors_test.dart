import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/features/medicine/medicine_entry_api_page.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
// Test adapters for interfaces supplied by the existing plugins.
// ignore: depend_on_referenced_packages
import 'package:image_picker_platform_interface/image_picker_platform_interface.dart';
// ignore: depend_on_referenced_packages
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

class _Picker extends ImagePickerPlatform {
  _Picker(this.result);
  final Future<XFile?> Function() result;
  @override
  Future<XFile?> getImageFromSource({
    required ImageSource source,
    ImagePickerOptions options = const ImagePickerOptions(),
  }) => result();
}

class _Paths extends PathProviderPlatform {
  _Paths(this.path);
  final String path;
  @override
  Future<String?> getApplicationSupportPath() async => path;
}

void main() {
  final requests = <String>[];
  Future<void> open(
    WidgetTester tester, {
    int status = 200,
    TokenProvider? tokenProvider,
  }) async {
    requests.clear();
    tester.view.physicalSize = const Size(400, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final api = ApiClient(
      baseUrl: 'https://synthetic.invalid',
      tokenProvider: tokenProvider ?? () async => 'synthetic',
      client: MockClient((request) async {
        requests.add(request.url.path);
        return http.Response(
          status == 200
              ? '{"candidates":[],"warnings":[]}'
              : '{"error":{"code":"SYNTHETIC","message":"服务暂不可用，请稍后重试。"}}',
          status,
          headers: {'content-type': 'application/json'},
        );
      }),
    );
    addTearDown(api.close);
    final store = MemoryInventoryLocalStore();
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
  }

  Future<void> gallery(WidgetTester tester) async {
    final entry = find.text('扫码 / 相册').evaluate().isNotEmpty
        ? find.text('扫码 / 相册')
        : find.text('继续补拍');
    await tester.ensureVisible(entry);
    await tester.tap(entry);
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('从相册选择'));
    await tester.tap(find.text('从相册选择'));
    await tester.pumpAndSettle();
  }

  for (final mode in [
    'cancel',
    'permission',
    'device',
    'missing-file',
    'late-error',
    'late-file',
    'late-identity-error',
    'camera-cancel',
    'camera-permission',
    'camera-device',
  ]) {
    testWidgets('media $mode preserves the current entry', (tester) async {
      final originalPicker = ImagePickerPlatform.instance;
      final originalPaths = PathProviderPlatform.instance;
      final gate = Completer<XFile?>();
      final camera = mode.startsWith('camera-');
      final outcome = mode.replaceFirst('camera-', '');
      Directory? root;
      addTearDown(() async {
        ImagePickerPlatform.instance = originalPicker;
        PathProviderPlatform.instance = originalPaths;
        if (root != null) await root!.delete(recursive: true);
      });
      ImagePickerPlatform.instance = _Picker(() async {
        if (mode.startsWith('late-')) return gate.future;
        if (outcome == 'cancel') return null;
        if (mode == 'missing-file') return XFile('${root!.path}/missing.png');
        throw PlatformException(
          code: outcome == 'permission'
              ? camera
                    ? 'camera_access_denied'
                    : 'photo_access_denied'
              : 'device_error',
          message: 'synthetic permission denied text in a device error',
        );
      });
      await open(tester);
      final dynamic state = tester.state(find.byType(MedicineEntryApiPage));
      if (mode == 'missing-file' || mode == 'late-file') {
        await tester.runAsync(() async {
          root = await Directory.systemTemp.createTemp(
            'medbox-capture-errors-',
          );
        });
        PathProviderPlatform.instance = _Paths(root!.path);
      }
      if (mode == 'missing-file') {
        await tester.runAsync(() async {
          await gallery(tester);
          for (
            var i = 0;
            i < 50 && find.byType(SnackBar).evaluate().isEmpty;
            i++
          ) {
            await Future<void>.delayed(const Duration(milliseconds: 10));
            await tester.pump();
          }
        });
        await tester.pumpAndSettle();
      } else if (camera) {
        await tester.ensureVisible(find.text('拍药盒'));
        await tester.tap(find.text('拍药盒'));
        await tester.pumpAndSettle();
      } else {
        await gallery(tester);
      }
      if (mode.startsWith('late-')) {
        if (mode == 'late-identity-error') {
          state.widget.repository.api.invalidateIdentity();
        } else {
          state.draftId = 'explicitly-imported-other-draft';
        }
        state.nameController.text = '保留导入后的内容';
        if (mode == 'late-file') {
          gate.complete(XFile('${root!.path}/missing.png'));
        } else {
          gate.completeError(PlatformException(code: 'photo_access_denied'));
        }
        await tester.runAsync(
          () async => Future<void>.delayed(const Duration(milliseconds: 20)),
        );
        await tester.pumpAndSettle();
        expect(state.nameController.text, '保留导入后的内容');
        expect(find.byType(SnackBar), findsNothing);
      } else if (outcome == 'permission') {
        expect(
          find.text('${camera ? '相机' : '相册'}权限未开启，请在系统设置中允许访问。'),
          findsOneWidget,
        );
      } else if (outcome == 'device') {
        expect(
          find.text(camera ? '无法打开相机，请重试或从相册选择。' : '无法打开相册，请重试或拍照录入。'),
          findsOneWidget,
        );
      } else if (mode == 'missing-file') {
        expect(find.text('无法读取或保存所选照片，请重新选择或拍照。'), findsOneWidget);
      } else {
        expect(find.byType(SnackBar), findsNothing);
      }
      expect(state.photoDrafts, isEmpty);
      expect(state.image, isNull);
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
    });
  }

  Future<void> scan(WidgetTester tester, List<Barcode> codes) async {
    await tester.ensureVisible(find.text('扫码 / 相册'));
    await tester.tap(find.text('扫码 / 相册'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('扫码'));
    await tester.pumpAndSettle();
    tester.widget<MobileScanner>(find.byType(MobileScanner)).onDetect!(
      BarcodeCapture(barcodes: codes),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('empty and unsupported scan do not retain a code or query', (
    tester,
  ) async {
    await open(tester);
    await scan(tester, [const Barcode(rawValue: 'https://synthetic.invalid')]);
    expect(
      find.text('请扫描 8–14 位商品条码或 20 位码（可能是药品追溯码）；未保存其他内容。'),
      findsOneWidget,
    );
    final dynamic state = tester.state(
      find.byType(MedicineEntryApiPage, skipOffstage: false),
    );
    expect(state.scannedCode, isNull);
    expect(find.text('查询药品资料？'), findsNothing);
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    await scan(tester, [const Barcode(rawValue: ' ')]);
    expect(state.scannedCode, isNull);
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    expect(find.byType(SnackBar), findsNothing);
  });

  testWidgets('traceability code is retained without a product lookup claim', (
    tester,
  ) async {
    await open(tester);
    await scan(tester, [const Barcode(rawValue: '12345678901234567890')]);
    expect(find.text('查询药品资料？'), findsNothing);
    expect(
      find.text('已读取 20 位码，可能是药品追溯码；不能据此确认药名，可改扫商品条码或拍照识别。'),
      findsOneWidget,
    );
    final dynamic state = tester.state(find.byType(MedicineEntryApiPage));
    expect(state.scannedCode, '12345678901234567890');
    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
  });

  testWidgets('scanner callback after cancel cannot affect the entry', (
    tester,
  ) async {
    await open(tester);
    await scan(tester, []);
    final callback = tester
        .widget<MobileScanner>(find.byType(MobileScanner))
        .onDetect!;
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    callback(
      const BarcodeCapture(barcodes: [Barcode(rawValue: '6901234567890')]),
    );
    await tester.pumpAndSettle();
    final dynamic state = tester.state(find.byType(MedicineEntryApiPage));
    expect(state.scannedCode, isNull);
    expect(requests, isEmpty);
  });

  for (final status in [200, 401, 503]) {
    testWidgets(
      'product barcode catalog status $status keeps manual entry available',
      (tester) async {
        await open(tester, status: status);
        await scan(tester, [
          const Barcode(rawValue: ' '),
          const Barcode(rawValue: '6901234567890'),
        ]);
        expect(find.text('查询药品资料？'), findsOneWidget);
        await tester.tap(find.text('同意并查询'));
        await tester.pumpAndSettle();
        expect(
          find.textContaining(
            status == 401
                ? '登录已过期'
                : status == 503
                ? '服务暂不可用'
                : '没有查到匹配资料',
          ),
          findsOneWidget,
        );
        final dynamic state = tester.state(find.byType(MedicineEntryApiPage));
        expect(state.scannedCode, '6901234567890');
        expect(state.nameController.text, '');
        await tester.pumpWidget(const SizedBox());
        await tester.pumpAndSettle();
      },
    );
  }

  for (final mode in [
    'invalid-photo',
    'recognition-401',
    'recognition-503',
    'recognition-cancel',
    'recognition-file-missing',
    'dispatch-cancel',
    'dispatch-draft',
  ]) {
    testWidgets('photo $mode uses an accurate safe message', (tester) async {
      await tester.runAsync(() async {
        final root = await Directory.systemTemp.createTemp(
          'medbox-recognition-errors-',
        );
        final originalPicker = ImagePickerPlatform.instance;
        final originalPaths = PathProviderPlatform.instance;
        addTearDown(() async {
          ImagePickerPlatform.instance = originalPicker;
          PathProviderPlatform.instance = originalPaths;
          await root.delete(recursive: true);
        });
        final recorder = ui.PictureRecorder();
        Canvas(recorder).drawColor(Colors.red, BlendMode.src);
        final picture = recorder.endRecording();
        final image = await picture.toImage(32, 32);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        image.dispose();
        picture.dispose();
        final file = await File('${root.path}/synthetic.png').writeAsBytes(
          mode == 'invalid-photo' ? [1, 2, 3] : bytes!.buffer.asUint8List(),
        );
        ImagePickerPlatform.instance = _Picker(() async => XFile(file.path));
        PathProviderPlatform.instance = _Paths(root.path);
        final tokenEntered = Completer<void>();
        final tokenResume = Completer<String?>();
        await open(
          tester,
          status: mode == 'recognition-401' ? 401 : 503,
          tokenProvider: mode.startsWith('dispatch-')
              ? () async {
                  tokenEntered.complete();
                  return tokenResume.future;
                }
              : null,
        );
        await gallery(tester);
        for (
          var i = 0;
          i < 100 && find.text('使用 AI 识别药盒？').evaluate().isEmpty;
          i++
        ) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
          await tester.pump();
        }
        await tester.pump(const Duration(milliseconds: 500));
        expect(find.text('使用 AI 识别药盒？'), findsOneWidget);
        final dynamic state = tester.state(
          find.byType(MedicineEntryApiPage, skipOffstage: false),
        );
        if (mode == 'recognition-cancel') {
          Navigator.of(tester.element(find.byType(AlertDialog))).pop();
        } else {
          if (mode == 'recognition-file-missing') {
            await File(state.image.path as String).delete();
          }
          await tester.tap(find.text('AI 识别').last);
        }
        if (mode.startsWith('dispatch-')) {
          await tokenEntered.future;
          if (mode == 'dispatch-draft') {
            state.draftId = 'other-explicit-draft';
          } else {
            state.recognitionRequest++;
          }
          tokenResume.complete('replacement-session');
          await Future<void>.delayed(const Duration(milliseconds: 20));
          await tester.pump();
          expect(requests, isEmpty);
          expect(state.nameController.text, '');
          expect(state.photoDrafts.single['state'], 'ready');
          await tester.pumpWidget(const SizedBox());
          await tester.pumpAndSettle();
          return;
        }
        for (var i = 0; i < 100 && state.recognizing == true; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
          await tester.pump();
        }
        await tester.pumpAndSettle();
        expect(state.recognizing, isFalse);
        expect(state.nameController.text, '');
        final expected = mode == 'invalid-photo'
            ? '照片格式或大小不正确。'
            : mode == 'recognition-file-missing'
            ? '无法读取本机照片，请重新选择或拍照。'
            : mode == 'recognition-401'
            ? '登录已过期'
            : '服务暂不可用';
        if (mode == 'recognition-cancel') {
          expect(state.recognitionFailure, isNull);
        } else {
          expect(find.textContaining(expected), findsOneWidget);
        }
        expect(
          requests.length,
          mode == 'recognition-401' || mode == 'recognition-503' ? 1 : 0,
        );
        expect(state.photoDrafts.length, 1);
        expect(state.photoDrafts.single['state'], 'ready');
        await tester.pumpWidget(const SizedBox());
        await tester.pumpAndSettle();
      });
    });
  }
}
