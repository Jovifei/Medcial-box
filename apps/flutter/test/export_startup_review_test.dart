import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_auth_repository.dart';
import 'package:home_medicine_flutter/data/app_services.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/export_ownership_journal.dart';
import 'package:home_medicine_flutter/data/export_temporary_store.dart';
import 'package:home_medicine_flutter/data/private_atomic_state.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/identity_fixture.dart';

class _StartupReviewState implements PrivateAtomicState {
  _StartupReviewState(this.delegate);
  final PrivateAtomicState delegate;
  int reads = 0;
  bool failRead = false;
  Completer<void>? gate;
  final entered = Completer<void>();

  @override
  Future<String?> read() async {
    reads++;
    if (!entered.isCompleted) entered.complete();
    await gate?.future;
    if (failRead) {
      throw const FileSystemException('synthetic unreadable journal');
    }
    return delegate.read();
  }

  @override
  Future<void> write(String value) => delegate.write(value);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  AndroidFlutterLocalNotificationsPlugin.registerWith();
  const channel = MethodChannel('dexterous.com/flutter/local_notifications');
  late Directory fixture;
  late Directory cache;
  late _StartupReviewState state;
  final opened = <AppServices>[];

  ExportProcessCoordinator process({Future<void> Function(File)? delete}) =>
      ExportProcessCoordinator(
        temporaryDirectory: () async => cache,
        journal: ExportOwnershipJournal(state: state),
        deleteFile: delete,
      );

  Future<OwnedExportFile> create(ExportTemporaryStore files) => files.create(
    bytes: [1, 2, 3],
    extension: 'md',
    identityEpoch: files.identityEpoch,
  );

  Future<AppServices> services(
    ExportTemporaryStore exports, {
    bool accepted = true,
    String baseUrl = 'https://medicine.example',
  }) async {
    final secrets = MemorySecretStore();
    if (accepted) {
      secrets.values[ApiAuthRepository.accessTokenKey] = 'synthetic-old-token';
    }
    final local = MemoryInventoryLocalStore();
    final identity = await identityFixture(secrets, localStore: local);
    final result = await http.runWithClient(
      () => AppServices.create(
        apiBaseUrl: baseUrl,
        secretStore: secrets,
        localStore: local,
        identityStore: identity,
        exportFiles: exports,
      ),
      () => MockClient((request) async {
        final Object body = switch (request.url.path) {
          '/api/v1/auth/device-links' => {
            'code': 'SYNTHETIC',
            'pollToken': 'synthetic-poll',
            'expiresAt': '2099-01-01T00:00:00Z',
          },
          '/api/v1/auth/device-links/exchange' => {
            'state': 'approved',
            'token': 'synthetic-new-token',
          },
          '/api/v1/auth/me' => {
            'user': {'id': 'synthetic-user', 'hasFamily': true},
            'family': {
              'id': 'family-a',
              'name': 'Synthetic family',
              'role': 'member',
            },
          },
          '/synthetic-safe-read' => {'ok': true},
          _ => {},
        };
        return http.Response(
          jsonEncode(body),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );
    opened.add(result);
    return result;
  }

  Future<void> acceptNewIdentity(AppServices app) async {
    await app.auth!.startDeviceLink();
    final result = await app.auth!.exchangePendingLink();
    expect(result.state, 'approved');
    expect(await app.auth!.readAccessToken(), 'synthetic-new-token');
  }

  setUp(() async {
    fixture = await Directory.systemTemp.createTemp('medbox-startup-review-');
    cache = await Directory('${fixture.path}/cache').create();
    final support = await Directory('${fixture.path}/support').create();
    state = _StartupReviewState(
      FilePrivateAtomicState(
        directoryProvider: () async => support,
        name: 'export-ownership.v1.json',
      ),
    );
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    SharedPreferences.setMockInitialValues({});
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'initialize') return true;
          return null;
        });
  });

  tearDown(() async {
    for (final app in opened) {
      app.api?.close();
    }
    opened.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
    debugDefaultTargetPlatformOverride = null;
    await fixture.delete(recursive: true);
  });

  test(
    'slow startup permits auth acceptance and ordinary authenticated reads',
    () async {
      state.gate = Completer<void>();
      final coordinator = process();
      final exports = ExportTemporaryStore(process: coordinator);
      final app = await services(
        exports,
        accepted: false,
      ).timeout(const Duration(seconds: 3));
      await state.entered.future;
      await acceptNewIdentity(app).timeout(const Duration(seconds: 3));
      expect(await app.api!.get('/synthetic-safe-read'), {'ok': true});
      expect(state.gate!.isCompleted, false);
      expect(identical(app.workflow!.exportFiles, exports), true);
      state.gate!.complete();
      await app.exportRecovery;
      expect(app.exportRecoveryIssues, isEmpty);
    },
  );

  test('recreated services share one startup attempt and second-store export waits', () async {
    state.gate = Completer<void>();
    final coordinator = process();
    final firstStore = ExportTemporaryStore(process: coordinator);
    final secondStore = ExportTemporaryStore(process: coordinator);
    final first = await services(firstStore);
    final second = await services(secondStore);
    await state.entered.future;
    expect(identical(first.exportRecovery, second.exportRecovery), true);
    expect(state.reads, 1);
    var wrote = false;
    final third = ExportTemporaryStore(
      process: coordinator,
      writeBytes: (_, _) async => wrote = true,
    );
    final pending = create(third);
    final rejected = expectLater(
      pending,
      throwsA(isA<ExportRecoveryException>()),
    );
    await Future<void>.delayed(Duration.zero);
    expect(wrote, false);
    expect(state.reads, 1);
    state.failRead = true;
    state.gate!.complete();
    await Future.wait([first.exportRecovery, second.exportRecovery, rejected]);
    expect(state.reads, 1);
    expect(wrote, false);
    expect(
      first.exportRecoveryIssues.single.kind,
      ExportRecoveryIssueKind.journalUnavailable,
    );
    expect(
      await first.auth!.getCurrentUser().then((profile) => profile.userId),
      'synthetic-user',
    );
    expect(await cache.list().toList(), isEmpty);
  });

  test(
    'ambiguous old original does not block accepting a new identity',
    () async {
      final old = await create(ExportTemporaryStore(process: process()));
      await old.file.writeAsBytes([9, 9, 9], flush: true);
      final exports = ExportTemporaryStore(process: process());
      final app = await services(exports, accepted: false);
      await app.exportRecovery;
      expect(
        app.exportRecoveryIssues.single.kind,
        ExportRecoveryIssueKind.ambiguousOwnership,
      );
      await acceptNewIdentity(app);
      expect(await app.api!.get('/synthetic-safe-read'), {'ok': true});
      await expectLater(
        create(exports),
        throwsA(isA<ExportRecoveryException>()),
      );
      expect(await old.file.readAsBytes(), [9, 9, 9]);
      expect(await ExportOwnershipJournal(state: state).read(), hasLength(1));
    },
  );

  test(
    'failed startup is handled in demo and invalid-configuration branches',
    () async {
      state.failRead = true;
      for (final baseUrl in ['', 'not a url']) {
        final exports = ExportTemporaryStore(process: process());
        final app = await services(exports, baseUrl: baseUrl);
        await app.exportRecovery;
        expect(
          app.exportRecoveryIssues.single.kind,
          ExportRecoveryIssueKind.journalUnavailable,
        );
        expect(await app.demoMedicineRepository.listMedicines(), isNotEmpty);
        expect(app.auth, isNull);
      }
    },
  );

  test('missing startup root is an export-only failure', () async {
    final exports = ExportTemporaryStore(
      process: ExportProcessCoordinator(
        temporaryDirectory: () async =>
            throw const FileSystemException('synthetic root unavailable'),
        journal: ExportOwnershipJournal(state: state),
      ),
    );
    final app = await services(exports);
    await app.exportRecovery;
    expect(
      app.exportRecoveryIssues.single.kind,
      ExportRecoveryIssueKind.rootUnavailable,
    );
    expect(
      await app.auth!.getCurrentUser().then((profile) => profile.userId),
      'synthetic-user',
    );
    expect(await app.api!.get('/synthetic-safe-read'), {'ok': true});
    expect(state.reads, 0);
  });

  test('old-process unlink failure preserves original but does not block new login', () async {
    final old = await create(ExportTemporaryStore(process: process()));
    final exports = ExportTemporaryStore(
      process: process(
        delete: (_) async {
          throw const FileSystemException(
            'synthetic old export unlink failure',
          );
        },
      ),
    );
    final app = await services(exports, accepted: false);
    await app.exportRecovery;
    expect(
      app.exportRecoveryIssues.single.kind,
      ExportRecoveryIssueKind.cleanupFailed,
    );
    await acceptNewIdentity(app);
    await expectLater(create(exports), throwsA(isA<ExportRecoveryException>()));
    expect(await old.file.readAsBytes(), [1, 2, 3]);
    expect(await ExportOwnershipJournal(state: state).read(), hasLength(1));
  });

  test(
    'discarding startup future emits no unhandled background error',
    () async {
      state.failRead = true;
      final errors = <Object>[];
      await runZonedGuarded(() async {
        final exports = ExportTemporaryStore(process: process());
        final app = await services(exports);
        // Intentionally do not listen to app.exportRecovery or add an error
        // handler. The production startup wrapper must contain its own errors.
        await state.entered.future;
        await Future<void>.delayed(Duration.zero);
        expect(
          app.exportRecoveryIssues.single.kind,
          ExportRecoveryIssueKind.journalUnavailable,
        );
        expect(await app.api!.get('/synthetic-safe-read'), {'ok': true});
      }, (error, _) => errors.add(error));
      expect(errors, isEmpty);
    },
  );

  test(
    'explicit retry clears startup failure while startup future stays settled',
    () async {
      state.failRead = true;
      final exports = ExportTemporaryStore(process: process());
      final app = await services(exports);
      await app.exportRecovery;
      expect(app.exportRecoveryIssues, isNotEmpty);
      state.failRead = false;
      final owned = await create(exports);
      expect(app.exportRecoveryIssues, isEmpty);
      expect(identical(app.exportRecovery, exports.recoverForStartup()), true);
      await owned.release();
    },
  );

  test(
    'known live partial writer remains in the new-identity acceptance barrier',
    () async {
      final coordinator = process();
      final entered = Completer<void>();
      final settle = Completer<void>();
      final exports = ExportTemporaryStore(
        process: coordinator,
        writeBytes: (file, bytes) async {
          await file.writeAsBytes([1], flush: true);
          entered.complete();
          await settle.future;
          await file.writeAsBytes(bytes, flush: true);
        },
      );
      final app = await services(exports);
      await app.exportRecovery;
      final pendingExport = create(exports);
      final exportRejected = expectLater(
        pendingExport,
        throwsA(isA<ExportTemporaryException>()),
      );
      await entered.future;
      await app.auth!.startDeviceLink();
      var accepted = false;
      final replacement = app.auth!.exchangePendingLink().then(
        (_) => accepted = true,
      );
      while (exports.identityEpoch == 0) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(accepted, false);
      expect(await app.auth!.readAccessToken(), isNot('synthetic-new-token'));
      settle.complete();
      await Future.wait([replacement, exportRejected]);
      expect(accepted, true);
      expect(await app.auth!.readAccessToken(), 'synthetic-new-token');
      expect(await cache.list().toList(), isEmpty);
    },
  );

  test(
    'known live deletion failure prevents replacement credential acceptance',
    () async {
      var failDelete = false;
      final coordinator = process(
        delete: (file) async {
          if (failDelete) {
            throw const FileSystemException('synthetic delete failure');
          }
          await file.delete();
        },
      );
      final exports = ExportTemporaryStore(process: coordinator);
      final app = await services(exports);
      await app.exportRecovery;
      final owned = await create(exports);
      await app.auth!.startDeviceLink();
      failDelete = true;
      await expectLater(app.auth!.exchangePendingLink(), throwsA(anything));
      expect(await app.auth!.readAccessToken(), isNot('synthetic-new-token'));
      expect(await owned.file.exists(), true);
      expect(app.familyInvalidated.value, true);
      failDelete = false;
      await owned.release();
    },
  );
}
