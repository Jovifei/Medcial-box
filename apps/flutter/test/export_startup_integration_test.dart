import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/app_services.dart';
import 'package:home_medicine_flutter/data/api_auth_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/export_ownership_journal.dart';
import 'package:home_medicine_flutter/data/export_temporary_store.dart';
import 'package:home_medicine_flutter/data/private_atomic_state.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/identity_fixture.dart';

class StartupJournalState implements PrivateAtomicState {
  final MemoryPrivateAtomicState memory = MemoryPrivateAtomicState();
  Completer<void>? readGate;
  bool readFails = false;
  int reads = 0;
  @override
  Future<String?> read() async {
    reads++;
    await readGate?.future;
    if (readFails) {
      throw const FileSystemException('synthetic journal read failure');
    }
    return memory.read();
  }

  @override
  Future<void> write(String value) => memory.write(value);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory root;
  late StartupJournalState state;
  late MemorySecretStore secrets;
  late MemoryInventoryLocalStore local;
  late PrivateAtomicState identity;
  ExportOwnershipJournal journal() => ExportOwnershipJournal(state: state);
  ExportProcessCoordinator coordinator({
    Future<Directory> Function()? directory,
    Future<void> Function(File)? deleteFile,
  }) => ExportProcessCoordinator(
    temporaryDirectory: directory ?? () async => root,
    journal: journal(),
    deleteFile: deleteFile,
  );
  Future<AppServices> services(
    ExportTemporaryStore files, {
    String base = 'https://medicine.example',
  }) => http.runWithClient(
    () => AppServices.create(
      apiBaseUrl: base,
      secretStore: secrets,
      localStore: local,
      identityStore: identity,
      exportFiles: files,
    ),
    () => MockClient((request) async {
      expect(
        request.headers['Authorization'],
        'Bearer synthetic-startup-token',
      );
      return http.Response(
        '{"ok":true}',
        200,
        headers: {'content-type': 'application/json'},
      );
    }),
  );
  Future<OwnedExportFile> create(ExportTemporaryStore files) => files.create(
    bytes: [1, 2, 3],
    extension: 'md',
    identityEpoch: files.identityEpoch,
  );
  setUp(() async {
    AndroidFlutterLocalNotificationsPlugin.registerWith();
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    root = await Directory.systemTemp.createTemp('medbox-startup-synthetic-');
    state = StartupJournalState();
    secrets = MemorySecretStore()
      ..values[ApiAuthRepository.accessTokenKey] = 'synthetic-startup-token';
    local = MemoryInventoryLocalStore();
    SharedPreferences.setMockInitialValues({});
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
    identity = await identityFixture(secrets, localStore: local);
  });
  tearDown(() async {
    debugDefaultTargetPlatformOverride = null;
    await root.delete(recursive: true);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('dexterous.com/flutter/local_notifications'),
          null,
        );
  });

  test('slow export root does not hold login or ordinary API work', () async {
    final gate = Completer<Directory>();
    var wrote = false;
    final files = ExportTemporaryStore(
      process: coordinator(directory: () => gate.future),
      writeBytes: (file, bytes) async {
        wrote = true;
        await file.writeAsBytes(bytes, flush: true);
      },
    );
    final app = await services(files).timeout(const Duration(seconds: 2));
    expect(app.isConfigured, true);
    expect(await app.auth!.readAccessToken(), 'synthetic-startup-token');
    expect(await app.api!.get('/synthetic-non-export'), {'ok': true});
    var settled = false;
    app.exportRecovery.then((_) => settled = true);
    final pending = create(files);
    await Future<void>.delayed(Duration.zero);
    expect(settled, false);
    expect(wrote, false);
    gate.complete(root);
    final owned = await pending;
    await app.exportRecovery;
    expect(app.exportRecoveryIssues, isEmpty);
    await owned.release();
  });

  test('service/store recreation joins one slow startup attempt', () async {
    state.readGate = Completer<void>();
    var rootCalls = 0;
    final process = coordinator(
      directory: () async {
        rootCalls++;
        return root;
      },
    );
    final first = await services(ExportTemporaryStore(process: process));
    final second = await services(ExportTemporaryStore(process: process));
    expect(identical(first.exportRecovery, second.exportRecovery), true);
    await Future<void>.delayed(const Duration(milliseconds: 10));
    expect(rootCalls, 1);
    expect(state.reads, 1);
    expect(await first.auth!.readAccessToken(), 'synthetic-startup-token');
    expect(await second.api!.get('/synthetic-non-export'), {'ok': true});
    state.readGate!.complete();
    await Future.wait([first.exportRecovery, second.exportRecovery]);
    expect(first.exportRecoveryIssues, isEmpty);
    expect(second.exportRecoveryIssues, isEmpty);
  });

  test(
    'ambiguous old artifact remains visible as export-only failure',
    () async {
      final old = await create(ExportTemporaryStore(process: coordinator()));
      await old.file.writeAsString('synthetic ambiguous replacement');
      final files = ExportTemporaryStore(process: coordinator());
      final app = await services(files);
      await app.exportRecovery;
      expect(app.configurationError, isNull);
      expect(app.sessionInvalidated.value, false);
      expect(
        app.exportRecoveryIssues.single.kind,
        ExportRecoveryIssueKind.ambiguousOwnership,
      );
      expect(await app.auth!.readAccessToken(), 'synthetic-startup-token');
      expect(await app.api!.get('/synthetic-non-export'), {'ok': true});
      await expectLater(create(files), throwsA(isA<ExportRecoveryException>()));
      await app.auth!.onIdentitySwitch!();
      expect(await old.file.readAsString(), 'synthetic ambiguous replacement');
      expect(await journal().read(), hasLength(1));
      expect(
        app.exportRecoveryIssues.single.kind,
        ExportRecoveryIssueKind.ambiguousOwnership,
      );
    },
  );

  for (final corrupt in [false, true]) {
    test(
      '${corrupt ? 'corrupt' : 'unreadable'} journal is caught and retryable without blocking auth',
      () async {
        state.readFails = !corrupt;
        state.memory.value = corrupt ? '{broken' : null;
        final files = ExportTemporaryStore(process: coordinator());
        final app = await services(files);
        await app.exportRecovery; // Deliberately successful Future, typed issue retained.
        expect(
          app.exportRecoveryIssues.single.kind,
          ExportRecoveryIssueKind.journalUnavailable,
        );
        expect(app.isConfigured, true);
        expect(await app.auth!.readAccessToken(), 'synthetic-startup-token');
        await expectLater(
          create(files),
          throwsA(isA<ExportRecoveryException>()),
        );
        expect(await root.list().toList(), isEmpty);
        state.readFails = false;
        state.memory.value = null;
        await (await create(files)).release();
        expect(app.exportRecoveryIssues, isEmpty);
      },
    );
  }

  test('root failure remains export-only and storage recovery enables explicit retry', () async {
    var failing = true;
    final files = ExportTemporaryStore(
      process: coordinator(
        directory: () async {
          if (failing) {
            throw const FileSystemException('synthetic unavailable root');
          }
          return root;
        },
      ),
    );
    final app = await services(files);
    await app.exportRecovery;
    expect(
      app.exportRecoveryIssues.single.kind,
      ExportRecoveryIssueKind.rootUnavailable,
    );
    expect(await app.api!.get('/synthetic-non-export'), {'ok': true});
    failing = false;
    await (await create(files)).release();
    expect(app.exportRecoveryIssues, isEmpty);
  });

  test(
    'ready original is recovered in background without an export request',
    () async {
      final old = await create(ExportTemporaryStore(process: coordinator()));
      final app = await services(ExportTemporaryStore(process: coordinator()));
      expect(await app.auth!.readAccessToken(), 'synthetic-startup-token');
      await app.exportRecovery;
      expect(await old.file.exists(), false);
      expect(await journal().read(), isEmpty);
      expect(app.exportRecoveryIssues, isEmpty);
    },
  );

  test('known-live deletion failure still fails identity cleanup and keeps its barrier', () async {
    var failing = true;
    final files = ExportTemporaryStore(
      process: coordinator(
        deleteFile: (file) async {
          if (failing) {
            throw const FileSystemException(
              'synthetic failed original deletion',
            );
          }
          await file.delete();
        },
      ),
    );
    final app = await services(files);
    await app.exportRecovery;
    final owned = await create(files);
    await expectLater(
      app.auth!.onIdentitySwitch!(),
      throwsA(isA<ExportTemporaryException>()),
    );
    expect(app.familyInvalidated.value, true);
    expect(await owned.file.exists(), true);
    expect(await journal().read(), hasLength(1));
    failing = false;
    await app.auth!.onIdentitySwitch!();
    expect(app.familyInvalidated.value, false);
    expect(await owned.file.exists(), false);
    expect(await journal().read(), isEmpty);
  });

  test(
    'recreated service cannot retire or overlap a live native lease',
    () async {
      final process = coordinator();
      final first = await services(ExportTemporaryStore(process: process));
      final owned = await create(first.exportFiles);
      final entered = Completer<void>();
      final gate = Completer<void>();
      final pending = first.exportFiles.handoff(
        owned,
        isCurrent: () => true,
        send: (_) async {
          entered.complete();
          await gate.future;
        },
      );
      await entered.future;
      final second = await services(ExportTemporaryStore(process: process));
      await second.exportRecovery;
      expect(await owned.file.exists(), true);
      final next = await create(second.exportFiles);
      await expectLater(
        second.exportFiles.handoff(
          next,
          isCurrent: () => true,
          send: (_) async {},
        ),
        throwsA(isA<ExportTemporaryException>()),
      );
      await second.auth!.logout();
      expect(await owned.file.exists(), true);
      gate.complete();
      await pending;
      expect(await owned.file.exists(), false);
      expect(await next.file.exists(), false);
    },
  );

  for (final base in ['', 'invalid-url']) {
    test('unconfigured API ($base) does not disable export recovery', () async {
      final old = await create(ExportTemporaryStore(process: coordinator()));
      final app = await services(
        ExportTemporaryStore(process: coordinator()),
        base: base,
      );
      expect(app.isConfigured, false);
      await app.exportRecovery;
      expect(await old.file.exists(), false);
      expect(app.exportRecoveryIssues, isEmpty);
    });
  }
  test(
    'logout drains a current write without an export cleanup cycle',
    () async {
      final entered = Completer<void>();
      final gate = Completer<void>();
      final files = ExportTemporaryStore(
        process: coordinator(),
        writeBytes: (file, bytes) async {
          entered.complete();
          await gate.future;
          await file.writeAsBytes(bytes, flush: true);
        },
      );
      final app = await services(files);
      final pending = create(files);
      final rejected = expectLater(
        pending,
        throwsA(isA<ExportTemporaryException>()),
      );
      await entered.future;
      final logout = app.auth!.logout();
      gate.complete();
      await Future.wait([rejected, logout]).timeout(const Duration(seconds: 3));
      expect(await root.list().toList(), isEmpty);
      expect(await app.auth!.readAccessToken(), isNull);
    },
  );
}
