import 'dart:convert';
import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
// Test adapter for the interface provided by the existing image_picker dependency.
// ignore: depend_on_referenced_packages
import 'package:image_picker_platform_interface/image_picker_platform_interface.dart';
// Test adapter for the interface provided by the existing path_provider dependency.
// ignore: depend_on_referenced_packages
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/features/medicine/medicine_entry_api_page.dart';

class _Picker extends ImagePickerPlatform {
  _Picker(this.files);
  final List<File> files;
  int calls = 0;
  @override
  Future<XFile?> getImageFromSource({
    required ImageSource source,
    ImagePickerOptions options = const ImagePickerOptions(),
  }) async {
    calls++;
    return XFile(files.removeAt(0).path);
  }
}

class _Paths extends PathProviderPlatform {
  _Paths(this.root);
  final Directory root;
  @override
  Future<String?> getApplicationSupportPath() async => root.path;
}

class _CopyFile implements File {
  _CopyFile(this.delegate, this.afterCopy, {this.beforeCopy});
  final void Function(String)? beforeCopy;
  final File delegate;
  final Future<void> Function() afterCopy;
  @override
  String get path => delegate.path;
  @override
  Future<Uint8List> readAsBytes() => delegate.readAsBytes();
  @override
  Future<int> length() => delegate.length();
  @override
  Future<File> copy(String target) async {
    beforeCopy?.call(target);
    final copied = await delegate.copy(target);
    await afterCopy();
    return copied;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _AckStore extends MemoryInventoryLocalStore {
  bool drop = false;
  int queueWrites = 0;
  int? failFrom;
  bool throwOnFailure = false;
  @override
  Future<void> saveDraft(String key, String json) async {
    if (key.startsWith('medicine-entry-queue.v1')) {
      queueWrites++;
      if (failFrom != null && queueWrites >= failFrom!) {
        if (throwOnFailure) throw StateError('synthetic ACK write failure');
        return;
      }
    }
    if (!drop) await super.saveDraft(key, json);
  }
}

void main() {
  for (final mode in [
    'cover',
    'no-cover',
    'lost-ack',
    'legacy',
    'lost-ack-restart',
    'partial-restart',
    'inventory-restart',
    'reserved-restart',
    'picker-gone',
    'delete',
    'discard',
    'cleanup-blocked',
    'ACK-capture-later-false',
    'ACK-capture-later-throw',
    'ACK-capture-status-false',
    'ACK-capture-status-throw',
  ]) {
    testWidgets(
      '$mode: same-format retake preserves originals, receipts and cover choice',
      (tester) async {
        await tester.runAsync(() async {
          final root = await Directory.systemTemp.createTemp(
            'medbox-photo-retention-',
          );
          final picker = ImagePickerPlatform.instance;
          final paths = PathProviderPlatform.instance;
          addTearDown(() async {
            ImagePickerPlatform.instance = picker;
            PathProviderPlatform.instance = paths;
            await root.delete(recursive: true);
          });
          Future<List<int>> png(Color color) async {
            final recorder = ui.PictureRecorder();
            Canvas(recorder).drawColor(color, BlendMode.src);
            final picture = recorder.endRecording();
            final image = await picture.toImage(32, 32);
            final data = await image.toByteData(format: ui.ImageByteFormat.png);
            image.dispose();
            picture.dispose();
            return data!.buffer.asUint8List();
          }

          final bytes = await png(Colors.red);
          final nextBytes = await png(Colors.blue);
          final first = await File('${root.path}/picker-a.png')
              .writeAsBytes(bytes);
          final second = await File('${root.path}/picker-b.png')
              .writeAsBytes(nextBytes);
          ImagePickerPlatform.instance = _Picker([first, second]);
          PathProviderPlatform.instance = _Paths(root);
          final store = _AckStore();
          final uploads = <Map<String, dynamic>>[];
          final recognitionRequests = <String>[];
          final remote = <String, String>{};
          final covers = <String>[];
          var creates = 0;
          var lost = false;
          var medicineVersion = 1;
          String? coverPhotoId;
          if (mode == 'legacy') {
            await store.saveDraft(
              'medicine-entry',
              jsonEncode({
                'id': 'legacy-photo',
                'name': 'Synthetic medicine',
                'imagePath': first.path,
                'frontPhotoId': 'legacy-uploaded',
              }),
            );
          }
          if (mode == 'inventory-restart') {
            await store.saveDraft(
              'medicine-entry',
              jsonEncode({
                'id': 'prior-unselected',
                'name': 'Prior draft',
                'imagePath': first.path,
              }),
            );
          }
          http.Response json(Object body, [int status = 200]) => http.Response(
            jsonEncode(body),
            status,
            headers: {'content-type': 'application/json'},
          );
          final api = ApiClient(
            baseUrl: 'https://synthetic.invalid',
            tokenProvider: () async => 'synthetic',
            client: MockClient((request) async {
              if (request.url.path == '/api/v1/recognitions/medicine') {
                recognitionRequests.add(
                  (jsonDecode(request.body) as Map)['imageBase64'] as String,
                );
                return json({
                  'error': {
                    'code': 'RECOGNITION_UNAVAILABLE',
                    'message': 'synthetic outage',
                  },
                }, 503);
              }
              if (request.url.path == '/api/v1/medicines' &&
                  request.method == 'POST') {
                creates++;
                return json({
                  'id': 'created',
                  'name': 'Synthetic medicine',
                  'version': medicineVersion,
                  'coverPhotoId': coverPhotoId,
                  'batches': [],
                }, 201);
              }
              if (request.url.path == '/api/v1/medicines/created') {
                return json({
                  'id': 'created',
                  'name': 'Synthetic medicine',
                  'version': medicineVersion,
                  'coverPhotoId': coverPhotoId,
                  'batches': [],
                });
              }
              if (request.url.path.endsWith('/recognition-evidence')) {
                if (request.method == 'GET') {
                  return json({
                    'evidence': null,
                    'capabilities': {'coverPhotoVersionGuard': true},
                  });
                }
                final body = jsonDecode(request.body) as Map<String, dynamic>;
                return json({
                  'evidence': {
                    'schemaVersion': 1,
                    'revision': 1,
                    'medicineVersion': body['medicineVersion'],
                    'currentMedicineVersion': medicineVersion,
                    'stale': false,
                    'photos': [
                      for (final item in body['photos'] as List)
                        {...item as Map<String, dynamic>, 'available': true},
                    ],
                    'fieldSources': body['fieldSources'],
                  },
                });
              }
              if (request.url.path.endsWith('/leaflet-photos')) {
                final body = jsonDecode(request.body) as Map<String, dynamic>;
                uploads.add(body);
                final key = body['uploadIntentKey'] as String;
                final id = remote.putIfAbsent(
                  key,
                  () => 'photo-${remote.length + 1}',
                );
                if (((mode.startsWith('lost-ack')) ||
                        (mode == 'partial-restart' && uploads.length == 2)) &&
                    !lost) {
                  lost = true;
                  throw http.ClientException('synthetic ACK lost');
                }
                return json({
                  'photo': {
                    'id': id,
                    'medicineId': 'created',
                    'contentType': 'image/png',
                    'sizeBytes': base64Decode(body['imageBase64'] as String)
                        .length,
                    'createdAt': '2026-10-14',
                    'url': '/synthetic',
                  },
                }, 201);
              }
              if (request.url.path.endsWith('/cover-photo')) {
                final body = jsonDecode(request.body) as Map;
                expect(body['version'], medicineVersion);
                coverPhotoId = body['photoId'] as String;
                covers.add(coverPhotoId!);
                medicineVersion++;
                return json({
                  'coverPhotoId': coverPhotoId,
                  'version': medicineVersion,
                });
              }
              throw StateError('Unexpected synthetic request ${request.url}');
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
          dynamic state = tester.state(find.byType(MedicineEntryApiPage));
          Future<void> importDraft() async {
            expect(state.nameController.text, '');
            expect(state.image, isNull);
            await tester.tap(find.byTooltip('导入草稿'));
            await tester.pumpAndSettle();
            await tester.tap(find.text('Synthetic medicine').last);
            await tester.pumpAndSettle();
          }

          if (mode == 'legacy') await importDraft();
          Future<void> reopenDraft() async {
            await tester.pumpWidget(const SizedBox());
            await tester.pumpAndSettle();
            await tester.pumpWidget(
              MaterialApp(
                home: MedicineEntryApiPage(
                  repository: ApiMedicineRepository(
                    api: api,
                    localStore: store,
                  ),
                  workflow: ApiWorkflowRepository(api: api),
                  localStore: store,
                ),
              ),
            );
            await tester.pumpAndSettle();
            state = tester.state(find.byType(MedicineEntryApiPage));
            await importDraft();
          }

          var captures = 0;
          Future<void> capture({bool ackFailure = false}) async {
            captures++;
            final entry = find.text('扫码 / 相册').evaluate().isNotEmpty
                ? find.text('扫码 / 相册')
                : find.text('继续补拍');
            await Scrollable.ensureVisible(
              tester.element(entry),
              alignment: 0.35,
            );
            await tester.pumpAndSettle();
            await tester.tap(entry);
            await tester.pumpAndSettle();
            await Scrollable.ensureVisible(
              tester.element(find.text('从相册选择')),
              alignment: 0.5,
            );
            await tester.pumpAndSettle();
            await tester.tap(find.text('从相册选择'));
            for (
              var i = 0;
              i < 100 && find.text('AI 识别').evaluate().isEmpty;
              i++
            ) {
              await Future<void>.delayed(const Duration(milliseconds: 10));
              await tester.pump();
            }
            if (ackFailure) {
              for (var i = 0; i < 40; i++) {
                await Future<void>.delayed(const Duration(milliseconds: 10));
                await tester.pump();
              }
              return;
            }
            await tester.pump(const Duration(milliseconds: 500));
            if (mode == 'picker-gone') {
              await (captures == 1 ? first : second).delete();
            }
            await tester.tap(find.text('AI 识别').last);
            for (var i = 0; i < 20; i++) {
              await Future<void>.delayed(const Duration(milliseconds: 10));
              await tester.pump();
            }
            await tester.pumpAndSettle();
          }

          if (mode != 'legacy') await capture();
          final String originalPath = state.image.path as String;
          final originalBytes = await File(originalPath).readAsBytes();
          if (mode == 'reserved-restart') {
            final queue =
                jsonDecode(store.drafts['medicine-entry-queue.v1']!) as List;
            queue.single['name'] = 'Synthetic medicine';
            queue.single['photos'][0]['state'] = 'reserved';
            queue.single['imagePath'] = null;
            store.drafts['medicine-entry-queue.v1'] = jsonEncode(queue);
            await reopenDraft();
          }

          if (mode == 'legacy') {
            ImagePickerPlatform.instance = _Picker([second]);
          }
          if (mode.startsWith('ACK-capture')) {
            store.queueWrites = 0;
            store.failFrom = mode.contains('later') ? 3 : 4;
            store.throwOnFailure = mode.endsWith('throw');
            final callsBefore = recognitionRequests.length;
            await capture(ackFailure: true);
            final unexpectedDialog = find.text('AI 识别').evaluate().isNotEmpty;
            if (unexpectedDialog) {
              await tester.pumpWidget(const SizedBox());
              await tester.pumpAndSettle();
            }
            expect(
              unexpectedDialog,
              false,
              reason: 'failed draft ACK cannot begin recognition',
            );
            expect(recognitionRequests.length, callsBefore);
            expect(find.text('草稿保存失败，内容仍在当前页面。请重试。'), findsOneWidget);
            expect(state.recognizing, false);
            if (mode.contains('later')) expect(state.image.path, originalPath);
            final retained = (jsonDecode(
              store.drafts['medicine-entry-queue.v1']!,
            ) as List).single;
            expect(retained['photos'].length, 2);
            for (final photo in retained['photos']) {
              expect(await File(photo['path'] as String).exists(), true);
            }
            expect(await File(originalPath).readAsBytes(), originalBytes);
            store.failFrom = null;
            store.queueWrites = 0;
            ImagePickerPlatform.instance = _Picker([second]);
            ScaffoldMessenger.of(
              tester.element(find.byType(MedicineEntryApiPage)),
            ).clearSnackBars();
            await tester.pumpAndSettle();
            await capture();
            expect(recognitionRequests.length, callsBefore + 1);
            expect(state.photoDrafts.length, 3);
            expect(await File(originalPath).readAsBytes(), originalBytes);
            await tester.pumpWidget(const SizedBox());
            await tester.pumpAndSettle();
            return;
          }
          await capture();
          final String retakePath = state.image.path as String;
          expect(retakePath, isNot(originalPath));
          expect(await File(originalPath).readAsBytes(), originalBytes);
          expect(await File(retakePath).readAsBytes(), nextBytes);
          expect(state.photoDrafts.length, 2);
          state.nameController.text = 'Synthetic medicine';
          state.usePhotoAsCover = mode != 'no-cover';
          File? sibling;
          if (mode == 'cleanup-blocked') {
            sibling = await File('${File(retakePath).parent.path}/unknown.txt')
                .writeAsString('keep');
          }

          if (mode == 'delete' || mode == 'discard') {
            if (mode == 'delete') {
              await tester.tap(find.byTooltip('导入草稿'));
              await tester.pumpAndSettle();
              await tester.tap(find.byTooltip('删除草稿'));
              for (var i = 0; i < 100 && state.nameController.text != ''; i++) {
                await Future<void>.delayed(const Duration(milliseconds: 10));
                await tester.pump();
              }
              await tester.pumpAndSettle();
              expect(state.nameController.text, '');
              expect(state.photoDrafts, isEmpty);
            } else {
              await tester.binding.handlePopRoute();
              await tester.pumpAndSettle();
              expect(find.text('保留这次录入？'), findsOneWidget);
              await tester.tap(find.text('放弃修改'));
              for (
                var i = 0;
                i < 100 &&
                    (jsonDecode(
                      store.drafts['medicine-entry-queue.v1'] ?? '[]',
                    ) as List).isNotEmpty;
                i++
              ) {
                await Future<void>.delayed(const Duration(milliseconds: 10));
                await tester.pump();
              }
              await tester.pumpAndSettle();
            }
            expect(await File(originalPath).exists(), false);
            expect(await File(retakePath).exists(), false);
            expect(
              jsonDecode(store.drafts['medicine-entry-queue.v1']!),
              isEmpty,
            );
            expect(uploads, isEmpty);
            await tester.pumpWidget(const SizedBox());
            await tester.pumpAndSettle();
            return;
          }

          var inventoryOnly = mode == "inventory-restart";
          Future<void> save() async {
            final label = state.attemptedPayload == null ? '核对后保存' : '重试原提交';
            await tester.ensureVisible(
              find.widgetWithText(FilledButton, label),
            );
            await tester.tap(find.widgetWithText(FilledButton, label));
            await tester.pump(const Duration(milliseconds: 500));
            await tester.tap(find.text(inventoryOnly ? '只保存库存' : '确认上传照片'));
            for (var i = 0; i < 40; i++) {
              await Future<void>.delayed(const Duration(milliseconds: 10));
              await tester.pump();
            }
          }

          Future<void> blockedSave() async {
            final before = [creates, uploads.length, covers.length];
            ScaffoldMessenger.of(
              tester.element(find.byType(MedicineEntryApiPage)),
            ).clearSnackBars();
            await tester.pumpAndSettle();
            await tester.ensureVisible(
              find.widgetWithText(FilledButton, '重试原提交'),
            );
            await tester.tap(find.widgetWithText(FilledButton, '重试原提交'));
            await tester.pumpAndSettle();
            expect([creates, uploads.length, covers.length], before);
            expect(
              find.text('此草稿仅待本机清理，请从“导入草稿”的删除入口重试；不会再次入库或上传。'),
              findsOneWidget,
            );
          }

          await save();
          if (mode == 'cleanup-blocked') {
            expect(await sibling!.readAsString(), 'keep');
            final pending = (jsonDecode(
              store.drafts['medicine-entry-queue.v1']!,
            ) as List).single;
            expect(pending['photos'][0]['cleanupState'], 'done');
            expect(pending['photos'][1]['cleanupState'], 'pending');
            await blockedSave();
            await sibling.delete();
            await tester.tap(find.byTooltip('导入草稿'));
            await tester.pumpAndSettle();
            await tester.tap(find.byTooltip('删除草稿'));
            for (var i = 0; i < 100 && state.nameController.text != ''; i++) {
              await Future<void>.delayed(const Duration(milliseconds: 10));
              await tester.pump();
            }
            await tester.pumpAndSettle();
          }
          if (mode == 'legacy') {
            final pending = (jsonDecode(
              store.drafts['medicine-entry-queue.v1']!,
            ) as List).single;
            expect(pending['photos'][0]['cleanupState'], 'unknown');
            expect(pending['photos'][1]['cleanupState'], 'done');
            await blockedSave();
          }
          if (mode == 'inventory-restart') {
            expect(uploads, isEmpty);
            expect(
              jsonDecode(store.drafts['medicine-entry']!)['id'],
              'prior-unselected',
            );
            inventoryOnly = false;
          }
          if (mode.endsWith('-restart') && mode != 'reserved-restart') {
            await reopenDraft();
            await save();
          } else if (mode == 'lost-ack') {
            await save();
          }
          expect(creates, 1);
          if (mode == 'reserved-restart') {
            final retained = (jsonDecode(
              store.drafts['medicine-entry-queue.v1']!,
            ) as List).single;
            expect(retained['photos'][0]['state'], 'reserved');
            expect(retained['photos'][0]['uploadedId'], isNull);
            expect(retained['savedMedicineId'], 'created');
            expect(retained['photos'][1]['uploadedId'], 'photo-1');
          }

          expect(
            uploads.length,
            (mode == 'legacy' || mode == 'reserved-restart')
                ? 1
                : (mode.startsWith('lost-ack') || mode == 'partial-restart')
                ? 3
                : 2,
          );
          expect(
            remote.length,
            (mode == 'legacy' || mode == 'reserved-restart') ? 1 : 2,
          );
          if (mode.startsWith('lost-ack')) {
            expect(
              uploads[0]['uploadIntentKey'],
              uploads[1]['uploadIntentKey'],
            );
          }
          expect(
            covers,
            mode == 'no-cover' || mode == 'reserved-restart'
                ? isEmpty
                : mode == 'legacy'
                ? ['photo-1']
                : mode == 'cleanup-blocked'
                ? ['photo-2']
                : [mode == 'reserved-restart' ? 'photo-1' : 'photo-2'],
          );
          if (mode == 'legacy' || mode == 'reserved-restart') {
            expect(await File(originalPath).readAsBytes(), originalBytes);
          } else {
            expect(await File(originalPath).exists(), false);
          }
          if (mode == 'reserved-restart') {
            expect(await File(retakePath).readAsBytes(), nextBytes);
          } else {
            expect(await File(retakePath).exists(), false);
          }
          if (mode == 'picker-gone') {
            expect(recognitionRequests, [
              base64Encode(bytes),
              base64Encode(nextBytes),
            ]);
          }
          await tester.pumpWidget(const SizedBox());
          await tester.pumpAndSettle();
        });
      },
    );
  }
  for (final mode in [
    'switch',
    'dispose',
    'copy-error',
    'no-ack',
    'ready-no-ack',
  ]) {
    testWidgets(
      'reserved $mode copy retains its durable owner and never deletes prior originals',
      (tester) async {
        await tester.runAsync(() async {
          final root = await Directory.systemTemp.createTemp(
            'medbox-copy-lease-',
          );
          final oldPicker = ImagePickerPlatform.instance;
          final oldPaths = PathProviderPlatform.instance;
          addTearDown(() async {
            ImagePickerPlatform.instance = oldPicker;
            PathProviderPlatform.instance = oldPaths;
            await root.delete(recursive: true);
          });
          final input = await File('${root.path}/source.png')
              .writeAsBytes([137, 80, 78, 71, 1, 2, 3, 4]);
          final ownerDirectory = await Directory(
            '${root.path}/medicine-draft-images/older-owned',
          ).create(recursive: true);
          final ownerFile = await File('${ownerDirectory.path}/original.png')
              .writeAsBytes([5, 6, 7]);
          ImagePickerPlatform.instance = _Picker([input]);
          PathProviderPlatform.instance = _Paths(root);
          final api = ApiClient(
            baseUrl: 'https://synthetic.invalid',
            tokenProvider: () async => 'synthetic',
            client: MockClient((request) async {
              fail('No request may follow a reserved interrupted copy');
            }),
          );
          addTearDown(api.close);
          final store = _AckStore()..drop = mode == 'no-ack';
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
          final zone = Zone.current;
          var copied = false;
          await IOOverrides.runZoned(
            () async {
              await tester.ensureVisible(find.text('扫码 / 相册'));
              await tester.tap(find.text('扫码 / 相册'));
              await tester.pumpAndSettle();
              await tester.ensureVisible(find.text('从相册选择'));
              await tester.tap(find.text('从相册选择'));
              for (var i = 0; i < 100; i++) {
                await Future<void>.delayed(const Duration(milliseconds: 10));
                await tester.pump();
              }
            },
            createFile: (path) => _CopyFile(
              zone.run(() => File(path)),
              () async {
                copied = true;
                if (mode == 'ready-no-ack') store.drop = true;
                if (mode == 'switch') api.invalidateIdentity();
                if (mode == 'dispose') {
                  await tester.pumpWidget(const SizedBox());
                }
                if (mode == 'copy-error') {
                  throw const FileSystemException(
                    'synthetic copy failure after partial bytes',
                  );
                }
              },
              beforeCopy: (target) {
                final queue = jsonDecode(
                  store.drafts['medicine-entry-queue.v1']!,
                ) as List;
                final photo = queue.single['photos'].single;
                expect(photo['path'], target);
                expect(photo['state'], 'reserved');
              },
            ),
          );
          expect(copied, mode != 'no-ack');
          final retained = await Directory('${root.path}/medicine-draft-images')
              .list()
              .toList();
          expect(retained, hasLength(mode == 'no-ack' ? 1 : 2));
          expect(await ownerDirectory.exists(), true);
          if (mode == 'no-ack') {
            expect(store.drafts['medicine-entry-queue.v1'], isNull);
            expect(find.text('本机照片草稿保存失败，未复制或发送照片，请重试。'), findsOneWidget);
          } else {
            final queue =
                jsonDecode(store.drafts['medicine-entry-queue.v1']!) as List;
            expect(queue.single['photos'].single['state'], 'reserved');
            expect(queue.single['photos'].single['uploadedId'], isNull);
          }
          expect(await ownerFile.readAsBytes(), [5, 6, 7]);
          expect(await input.readAsBytes(), [137, 80, 78, 71, 1, 2, 3, 4]);
          await tester.pumpWidget(const SizedBox());
          await tester.pumpAndSettle();
        });
      },
    );
  }
  testWidgets(
    'explicit draft deletion removes the matching legacy row without importing it',
    (tester) async {
      final store = MemoryInventoryLocalStore();
      await store.saveDraft(
        'medicine-entry',
        jsonEncode({
          'id': 'selected-legacy',
          'name': 'Old explicit draft',
          'photos': [],
        }),
      );
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => 'synthetic',
        client: MockClient((request) async {
          fail('No network request for draft deletion');
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
      expect(
        tester.widget<TextField>(find.byType(TextField).first).controller!.text,
        '',
      );
      await tester.tap(find.byTooltip('导入草稿'));
      await tester.pumpAndSettle();
      expect(find.text('Old explicit draft'), findsOneWidget);
      await tester.tap(find.byTooltip('删除草稿'));
      await tester.pumpAndSettle();
      expect(await store.readDraft('medicine-entry'), isNull);
      await tester.tap(find.byTooltip('导入草稿'));
      await tester.pumpAndSettle();
      expect(find.text('Old explicit draft'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
    },
  );
  for (final saved in [false, true]) {
    testWidgets(
      'cleanup pending saved=$saved cannot create inventory or upload',
      (tester) async {
        final previousPicker = ImagePickerPlatform.instance;
        final picker = _Picker([]);
        ImagePickerPlatform.instance = picker;
        addTearDown(() {
          ImagePickerPlatform.instance = previousPicker;
        });
        final store = MemoryInventoryLocalStore();
        await store.saveDraft(
          'medicine-entry',
          jsonEncode({
            'id': 'pending-draft',
            'name': 'Cleanup record',
            'cleanupPending': true,
            'savedMedicineId': saved ? 'created' : null,
            'photos': [
              {
                'path': 'unverified-old-file',
                'purpose': 'box_front',
                'cleanupState': 'pending',
              },
            ],
          }),
        );
        var requests = 0;
        final api = ApiClient(
          baseUrl: 'https://synthetic.invalid',
          tokenProvider: () async => 'synthetic',
          client: MockClient((request) async {
            requests++;
            return http.Response('{}', 500);
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
        await tester.tap(find.text('Cleanup record'));
        await tester.pumpAndSettle();
        final queueBefore = store.drafts['medicine-entry-queue.v1'];
        tester
            .widget<TextButton>(find.widgetWithText(TextButton, '继续补拍'))
            .onPressed
            ?.call();
        await tester.pumpAndSettle();
        expect(picker.calls, 0);
        expect(store.drafts['medicine-entry-queue.v1'], queueBefore);
        await tester.ensureVisible(find.widgetWithText(FilledButton, '核对后保存'));
        await tester.tap(find.widgetWithText(FilledButton, '核对后保存'));
        await tester.pumpAndSettle();
        expect(requests, 0);
        expect(
          find.text('此草稿仅待本机清理，请从“导入草稿”的删除入口重试；不会再次入库或上传。'),
          findsOneWidget,
        );
        expect(
          (jsonDecode(
            store.drafts['medicine-entry-queue.v1']!,
          ) as List).single['photos'].single['path'],
          'unverified-old-file',
        );
        await tester.pumpWidget(const SizedBox());
        await tester.pumpAndSettle();
      },
    );
  }
}
