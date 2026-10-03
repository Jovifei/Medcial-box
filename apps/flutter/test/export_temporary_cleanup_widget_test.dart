// Production export lifecycle regressions; all adapters and data are synthetic.
// ignore_for_file: depend_on_referenced_packages
// Synthetic fixtures only; platform share, clipboard and notifications are fake.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';
import 'package:share_plus/share_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:home_medicine_flutter/core/widgets/app_surfaces.dart';
import 'package:home_medicine_flutter/data/api_auth_repository.dart';
import 'package:home_medicine_flutter/data/app_services.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/features/export/export_api_page.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';

const fixture = 'SYNTHETIC_ACCOUNT_A_PRIVATE_EXPORT';

class FakePaths extends PathProviderPlatform {
  late Directory directory;
  Completer<void>? entered;
  Completer<void>? gate;
  @override
  Future<String?> getTemporaryPath() async {
    entered?.complete();
    await gate?.future;
    return directory.path;
  }
}

class FakeShare {
  final calls = <ShareParams>[];
  final contents = <String>[];
  Completer<void>? entered;
  Completer<void>? gate;
  ShareResultStatus status = ShareResultStatus.success;
  bool throws = false;
  Future<String> handle(MethodCall call) async {
    expect(call.method, 'share');
    final args = call.arguments as Map;
    final params = ShareParams(
      files: [
        XFile(
          (args['paths'] as List).single as String,
          mimeType: (args['mimeTypes'] as List).single as String,
        ),
      ],
      subject: args['subject'] as String?,
      text: args['text'] as String?,
    );
    calls.add(params);
    expect(await File(params.files!.single.path).exists(), true);
    contents.add(await File(params.files!.single.path).readAsString());
    entered?.complete();
    await gate?.future;
    if (throws) throw PlatformException(code: 'synthetic-share-failure');
    return switch (status) {
      ShareResultStatus.success => 'synthetic-target',
      ShareResultStatus.dismissed => '',
      ShareResultStatus.unavailable =>
        'dev.fluttercommunity.plus/share/unavailable',
    };
  }
}

final class SyntheticBackupFile extends PlatformFile {
  final Uint8List bytes = Uint8List.fromList(
    utf8.encode('{"schemaVersion":2,"backupId":"synthetic-a","medicines":[]}'),
  );
  Completer<void>? entered;
  Completer<void>? gate;
  int readCalls = 0;
  @override
  String get name => 'synthetic-backup.json';
  @override
  Uri get uri => Uri.parse('memory:synthetic-backup');
  @override
  XFile get xFile => XFile.fromData(bytes);
  @override
  int? lengthSync() => bytes.length;
  @override
  Future<int?> length() async => bytes.length;
  @override
  Stream<Uint8List> readAsByteStream() => Stream.value(bytes);
  @override
  Future<Uint8List> readAsBytes() async {
    readCalls++;
    entered?.complete();
    await gate?.future;
    return bytes;
  }
}

class SyntheticFilePicker extends FilePickerPlatform {
  late SyntheticBackupFile file;
  Completer<void>? entered;
  Completer<void>? gate;
  int calls = 0;
  @override
  Future<PlatformFile?> pickFile({
    String? dialogTitle,
    String? initialDirectory,
    FileType type = FileType.any,
    List<String>? allowedExtensions,
    Function(FilePickerStatus)? onFileLoading,
    int compressionQuality = 0,
    AndroidOptions androidOptions = const AndroidOptions(),
    DarwinOptions darwinOptions = const DarwinOptions(),
    WindowsOptions windowsOptions = const WindowsOptions(),
    LinuxOptions linuxOptions = const LinuxOptions(),
    WebOptions webOptions = const WebOptions(),
  }) async {
    calls++;
    entered?.complete();
    await gate?.future;
    return file;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final paths = FakePaths();
  final share = FakeShare();
  final picker = SyntheticFilePicker();
  FilePickerPlatform.instance = picker;
  PathProviderPlatform.instance = paths;

  late AppServices services;
  late MemorySecretStore secrets;
  late MemoryInventoryLocalStore storage;
  final clipboardWrites = <String>[];
  Completer<void>? previewGate;
  Completer<void>? previewEntered;
  var backupId = 'synthetic-backup-a';
  var restorePreviewCalls = 0;
  final restoreRequests = <http.Request>[];
  Completer<void>? restorePreviewEntered;
  Completer<void>? restorePreviewGate;

  setUp(() async {
    FlutterLocalNotificationsPlatform.instance =
        AndroidFlutterLocalNotificationsPlugin();
    SharedPreferences.setMockInitialValues({});
    paths.directory = await Directory.systemTemp.createTemp(
      'medbox-export-audit-',
    );
    paths.entered = null;
    paths.gate = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('dev.fluttercommunity.plus/share'),
          share.handle,
        );
    share.calls.clear();
    share.contents.clear();
    share.entered = null;
    share.gate = null;
    share.throws = false;
    share.status = ShareResultStatus.success;
    clipboardWrites.clear();
    previewGate = null;
    previewEntered = null;
    backupId = 'synthetic-backup-a';
    restorePreviewCalls = 0;
    restoreRequests.clear();
    restorePreviewEntered = null;
    restorePreviewGate = null;
    picker.file = SyntheticBackupFile();
    picker.entered = null;
    picker.gate = null;
    picker.calls = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('dexterous.com/flutter/local_notifications'),
          (call) async {
            if (call.method == 'initialize') return true;
            if (call.method == 'getNotificationAppLaunchDetails') {
              return {'notificationLaunchedApp': false};
            }
            return null;
          },
        );
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'Clipboard.setData') {
            clipboardWrites.add((call.arguments as Map)['text'] as String);
          }
          return null;
        });
    secrets = MemorySecretStore();
    await secrets.write(
      ApiAuthRepository.accessTokenKey,
      'synthetic-account-a',
    );
    storage = MemoryInventoryLocalStore();
    await storage.saveFamily(
      FamilyRecord(
        id: 'synthetic-family-a',
        name: 'Synthetic A',
        role: 'owner',
      ),
    );
    services = await http.runWithClient(
      () => AppServices.create(
        apiBaseUrl: 'https://medicine.example',
        secretStore: secrets,
        localStore: storage,
      ),
      () => MockClient((request) async {
        final path = request.url.path;
        Object json = {};
        if (path.endsWith('/snapshot')) {
          json = {'snapshotId': 'synthetic-snapshot-a'};
        }
        if (path.endsWith('/markdown')) {
          if (previewEntered != null && !previewEntered!.isCompleted) {
            previewEntered!.complete();
          }
          await previewGate?.future;
          json = {'markdown': fixture};
        }
        if (path.endsWith('/csv')) json = {'content': 'name\n$fixture'};
        if (path.endsWith('/pdf')) {
          json = {
            'contentBase64': base64Encode(utf8.encode('%PDF-1.7 $fixture')),
          };
        }
        if (path.endsWith('/backups/json')) {
          json = {
            'backupId': backupId,
            'schemaVersion': 2,
            'medicines': [
              {'name': fixture},
            ],
          };
        }
        if (path.endsWith('/backups/preview')) {
          restorePreviewCalls++;
          restorePreviewEntered?.complete();
          await restorePreviewGate?.future;
          json = {
            'valid': true,
            'confirmationToken': 'synthetic-confirmation-a',
            'medicineCount': 0,
          };
        }
        if (path.endsWith('/backups/restore')) {
          restoreRequests.add(request);
          json = {'restoredCount': 1};
        }
        if (path.endsWith('/medicines')) {
          json = {'medicines': []};
        }
        return http.Response(
          jsonEncode(json),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      }),
    );
  });
  tearDown(() async {
    services.api?.close();
    await paths.directory.delete(
      recursive: true,
    ); // Only this probe's private synthetic directory.
  });

  Future<void> mount(
    WidgetTester tester, {
    ExportKind kind = ExportKind.markdown,
    bool wait = true,
  }) async {
    tester.view.physicalSize = const Size(1400, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: ExportApiPage(
          repository: services.medicines!,
          workflow: services.workflow!,
        ),
      ),
    );
    if (wait) await tester.pumpAndSettle();
    if (kind != ExportKind.markdown) {
      tester
          .widget<SegmentedButton<ExportKind>>(
            find.byType(SegmentedButton<ExportKind>),
          )
          .onSelectionChanged!({kind});
      await tester.pumpAndSettle();
    }
  }

  Future<void> invoke(WidgetTester tester, bool backup) async {
    final button = tester
        .widgetList<PrimaryButton>(find.byType(PrimaryButton))
        .firstWhere(
          (b) => backup ? b.label.contains('备份') : b.label.contains('文件'),
        );
    await (button.onPressed as dynamic)();
  }

  for (final item in ['md', 'csv', 'pdf', 'json']) {
    for (final outcome in ['success', 'dismissed', 'unavailable', 'throw']) {
      testWidgets(
        '$item $outcome: original is removed after share, identity reset, logout and dispose',
        (tester) async {
          await mount(
            tester,
            kind: item == 'csv'
                ? ExportKind.csv
                : item == 'pdf'
                ? ExportKind.pdf
                : ExportKind.markdown,
          );
          share.throws = outcome == 'throw';
          share.status = outcome == 'dismissed'
              ? ShareResultStatus.dismissed
              : outcome == 'unavailable'
              ? ShareResultStatus.unavailable
              : ShareResultStatus.success;
          await tester.runAsync(() => invoke(tester, item == 'json'));
          await tester.pump();
          final file = File(share.calls.single.files!.single.path);
          expect(file.path.endsWith('.$item'), true);
          expect(
            share.calls.single.files!.single.mimeType,
            {
              'md': 'text/markdown',
              'csv': 'text/csv',
              'pdf': 'application/pdf',
              'json': 'application/json',
            }[item],
          );
          expect(share.contents.single, contains(fixture));
          expect(await tester.runAsync(file.exists), false);
          final beforeEpoch = services.api!.identityEpoch;
          await tester.runAsync(services.auth!.onIdentitySwitch!);
          expect(services.api!.identityEpoch, beforeEpoch + 1);
          expect(storage.family, isNull);
          expect(await tester.runAsync(file.exists), false);
          await tester.runAsync(services.auth!.logout);
          expect(await secrets.read(ApiAuthRepository.accessTokenKey), isNull);
          expect(await tester.runAsync(file.exists), false);
          if (outcome == 'throw') {
            expect(find.text('未能打开分享，请稍后重试。'), findsOneWidget);
          }
          if (outcome == 'unavailable') {
            expect(find.text('分享结果无法确认，请在目标应用核对。'), findsOneWidget);
          }
          if (outcome == 'dismissed') {
            expect(find.text('已取消分享。'), findsOneWidget);
          }
          await tester.pumpWidget(const SizedBox.shrink());
          expect(await tester.runAsync(file.exists), false);
        },
      );
    }
  }

  for (final backup in [false, true]) {
    testWidgets(
      '${backup ? 'JSON' : 'MD'}: disposed during temp lookup leaves no abandoned file',
      (tester) async {
        await mount(tester);
        paths.entered = Completer<void>.sync();
        paths.gate = Completer<void>.sync();
        late Future<void> action;
        await tester.runAsync(() async {
          action = invoke(tester, backup);
          await paths.entered!.future.timeout(const Duration(seconds: 3));
        });
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.runAsync(() async {
          paths.gate!.complete();
          await action;
        });
        expect(paths.directory.listSync(), isEmpty);
        expect(share.calls, isEmpty);
      },
    );
    testWidgets(
      '${backup ? 'JSON' : 'MD'}: completed logout during temp lookup prevents dispatch while mounted',
      (tester) async {
        await mount(tester);
        paths.entered = Completer<void>.sync();
        paths.gate = Completer<void>.sync();
        late Future<void> action;
        await tester.runAsync(() async {
          action = invoke(tester, backup);
          await paths.entered!.future.timeout(const Duration(seconds: 3));
          await services.auth!.logout();
        });
        expect(await secrets.read(ApiAuthRepository.accessTokenKey), isNull);
        await tester.runAsync(() async {
          paths.gate!.complete();
          await action;
        });
        expect(share.calls, isEmpty);
        expect(paths.directory.listSync(), isEmpty);
      },
    );
  }

  testWidgets(
    'copy begun while preview pending does not write clipboard after disposal',
    (tester) async {
      previewGate = Completer<void>.sync();
      previewEntered = Completer<void>.sync();
      await mount(tester, wait: false);
      await tester.pump();
      final button = tester
          .widgetList<SoftButton>(find.byType(SoftButton))
          .firstWhere((b) => b.label == '复制内容');
      late Future<void> action;
      await tester.runAsync(() async {
        action = (button.onPressed as dynamic)();
        await previewEntered!.future.timeout(const Duration(seconds: 3));
      });
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.runAsync(() async {
        previewGate!.complete();
        await action;
      });
      expect(clipboardWrites, isEmpty);
    },
  );

  testWidgets(
    'copy of ready preview stops at synchronous production identity invalidation',
    (tester) async {
      await mount(tester);
      final button = tester
          .widgetList<SoftButton>(find.byType(SoftButton))
          .firstWhere((b) => b.label == '复制内容');
      await tester.runAsync(() async {
        final Future<void> action = (button.onPressed as dynamic)();
        final clearing = services.auth!.onIdentitySwitch!();
        await Future.wait([action, clearing]);
      });
      expect(clipboardWrites, isEmpty);
    },
  );

  testWidgets(
    'server backupId is data and cannot control the generated filename',
    (tester) async {
      backupId = '../../outside/unsafe-name';
      await mount(tester);
      await tester.runAsync(() => invoke(tester, true));
      expect(
        share.calls.single.files!.single.path.split('/').last,
        matches(RegExp(r'^medicine-cabinet-backup-[0-9a-f]{32}\.json$')),
      );
      expect(share.contents.single, contains(backupId));
      expect(paths.directory.listSync(), isEmpty);
    },
  );

  for (final logout in [true, false]) {
    testWidgets(
      'active native handoff keeps original through ${logout ? "logout" : "navigation"} until return',
      (tester) async {
        await mount(tester);
        share.entered = Completer<void>.sync();
        share.gate = Completer<void>.sync();
        late Future<void> action;
        await tester.runAsync(() async {
          action = invoke(tester, false);
          await share.entered!.future.timeout(const Duration(seconds: 3));
        });
        final file = File(share.calls.single.files!.single.path);
        if (logout) {
          await tester.runAsync(
            () => services.auth!.logout().timeout(const Duration(seconds: 3)),
          );
        } else {
          await tester.pumpWidget(const SizedBox.shrink());
        }
        expect(await tester.runAsync(file.readAsString), contains(fixture));
        await tester.runAsync(() async {
          share.gate!.complete();
          await action;
        });
        expect(await tester.runAsync(file.exists), false);
        expect(paths.directory.listSync(), isEmpty);
      },
    );
  }

  testWidgets(
    'rapid repeated share callback dispatches once and later actions have distinct owned paths',
    (tester) async {
      await mount(tester);
      final button = tester
          .widgetList<PrimaryButton>(find.byType(PrimaryButton))
          .firstWhere((b) => b.label.contains('文件'));
      await tester.runAsync(() async {
        await Future.wait<void>([
          (button.onPressed as dynamic)(),
          (button.onPressed as dynamic)(),
        ]);
      });
      expect(share.calls, hasLength(1));
      await tester.pump();
      for (var i = 0; i < 3; i++) {
        await tester.runAsync(() => invoke(tester, false));
        await tester.pump();
      }
      expect(share.calls, hasLength(4));
      expect(
        share.calls.map((c) => c.files!.single.path.split('/').last).toSet(),
        hasLength(4),
      );
      expect(
        share.calls.map((c) => c.files!.single.path).toSet(),
        hasLength(4),
      );
      expect(paths.directory.listSync(), isEmpty);
    },
  );

  testWidgets(
    'control: ApiClient rejects in-flight preview response after identity invalidation',
    (tester) async {
      previewGate = Completer<void>.sync();
      previewEntered = Completer<void>.sync();
      await mount(tester, wait: false);
      await tester.pump();
      final button = tester
          .widgetList<SoftButton>(find.byType(SoftButton))
          .firstWhere((b) => b.label == '复制内容');
      late Future<void> action;
      await tester.runAsync(() async {
        action = (button.onPressed as dynamic)();
        await previewEntered!.future.timeout(const Duration(seconds: 3));
        await services.auth!.logout();
        previewGate!.complete();
      });
      await tester.pump();
      await tester.runAsync(() => action.timeout(const Duration(seconds: 3)));
      expect(clipboardWrites, isEmpty);
      expect(share.calls, isEmpty);
    },
  );
  Future<void> invokeRestore(WidgetTester tester) async {
    final button = tester
        .widgetList<SoftButton>(find.byType(SoftButton))
        .firstWhere((b) => b.label == '选择 JSON 文件并恢复');
    await (button.onPressed as dynamic)();
  }

  Future<void> cancelRestoreDialog(WidgetTester tester) async {
    await tester.pumpAndSettle();
    if (find.text('检查恢复内容').evaluate().isNotEmpty) {
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
    }
  }

  Future<void> rotateIdentity() async {
    await services.auth!.onIdentitySwitch!();
    await secrets.write(
      ApiAuthRepository.accessTokenKey,
      'synthetic-account-b',
    );
  }

  testWidgets('restore entry on a stale mounted page cannot open picker', (
    tester,
  ) async {
    await mount(tester);
    await tester.runAsync(rotateIdentity);
    late Future<void> action;
    await tester.runAsync(() async {
      action = invokeRestore(tester);
      await Future<void>.delayed(Duration.zero);
    });
    await cancelRestoreDialog(tester);
    await tester.runAsync(() => action);
    expect(picker.calls, 0);
    expect(restoreRequests, isEmpty);
  });
  for (final boundary in ['picker', 'file read']) {
    testWidgets(
      'restore ignores a stale $boundary result after identity rotation',
      (tester) async {
        await mount(tester);
        final entered = Completer<void>.sync();
        final gate = Completer<void>.sync();
        if (boundary == 'picker') {
          picker.entered = entered;
          picker.gate = gate;
        } else {
          picker.file.entered = entered;
          picker.file.gate = gate;
        }
        late Future<void> action;
        await tester.runAsync(() async {
          action = invokeRestore(tester);
          await entered.future;
          await rotateIdentity();
          gate.complete();
          await Future<void>.delayed(Duration.zero);
        });
        await cancelRestoreDialog(tester);
        await tester.runAsync(() => action);
        expect(restorePreviewCalls, 0);
        expect(restoreRequests, isEmpty);
        if (boundary == 'picker') expect(picker.file.readCalls, 0);
      },
    );
  }
  testWidgets(
    'stale restore confirmation cannot write into replacement identity',
    (tester) async {
      await mount(tester);
      late Future<void> action;
      await tester.runAsync(() async {
        action = invokeRestore(tester);
        await Future<void>.delayed(Duration.zero);
      });
      await tester.pumpAndSettle();
      expect(find.text('检查恢复内容'), findsOneWidget);
      await tester.runAsync(rotateIdentity);
      await tester.tap(find.text('新增到当前家庭'));
      await tester.pumpAndSettle();
      await tester.runAsync(() => action);
      expect(restoreRequests, isEmpty);
    },
  );
  testWidgets(
    'in-flight restore preview cannot open confirmation after identity rotation',
    (tester) async {
      await mount(tester);
      restorePreviewEntered = Completer<void>.sync();
      restorePreviewGate = Completer<void>.sync();
      late Future<void> action;
      await tester.runAsync(() async {
        action = invokeRestore(tester);
        await restorePreviewEntered!.future;
        await rotateIdentity();
        restorePreviewGate!.complete();
      });
      await tester.pumpAndSettle();
      await tester.runAsync(() => action);
      expect(find.text('检查恢复内容'), findsNothing);
      expect(restoreRequests, isEmpty);
    },
  );
  for (final confirm in [true, false]) {
    testWidgets(
      'current identity restore ${confirm ? "requires explicit confirmation" : "cancel does not write"}',
      (tester) async {
        await mount(tester);
        late Future<void> action;
        await tester.runAsync(() async {
          action = invokeRestore(tester);
          await Future<void>.delayed(Duration.zero);
        });
        await tester.pumpAndSettle();
        expect(restoreRequests, isEmpty);
        await tester.tap(find.text(confirm ? '新增到当前家庭' : '取消'));
        await tester.pumpAndSettle();
        await tester.runAsync(() => action);
        expect(restoreRequests, hasLength(confirm ? 1 : 0));
        if (confirm) {
          expect(
            restoreRequests.single.headers['authorization'],
            'Bearer synthetic-account-a',
          );
        }
      },
    );
  }
}
