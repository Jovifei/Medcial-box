import 'package:home_medicine_flutter/data/export_ownership_journal.dart';
import 'package:home_medicine_flutter/data/private_atomic_state.dart';
import 'package:home_medicine_flutter/data/export_temporary_store.dart';

import 'dart:io';

import 'support/identity_fixture.dart';

// ignore: depend_on_referenced_packages
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';
import 'package:home_medicine_flutter/features/auth/device_link_page.dart';
import 'package:home_medicine_flutter/features/home/production_shell.dart';
import 'package:home_medicine_flutter/app.dart';
import 'package:go_router/go_router.dart';
import 'package:flutter/material.dart';

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:home_medicine_flutter/data/api_auth_repository.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'family_notification_cleanup_test.dart' as h;

class FailedDeleteSecrets extends MemorySecretStore {
  @override
  Future<void> delete(String key) async {
    if (key == ApiAuthRepository.accessTokenKey) {
      throw StateError('synthetic-delete-failure');
    }
    await super.delete(key);
  }
}

class PausedFamilyClearStore extends MemoryInventoryLocalStore {
  final entered = Completer<void>();
  final release = Completer<void>();
  @override
  Future<void> clearFamilyData() async {
    if (!entered.isCompleted) entered.complete();
    await release.future;
    await super.clearFamilyData();
  }
}

class FamilyCleanupPaths extends PathProviderPlatform {
  FamilyCleanupPaths(this.root);
  final Directory root;
  @override
  Future<String?> getTemporaryPath() async => root.path;
}

class FailingFamilyClearStore extends MemoryInventoryLocalStore {
  bool fail = false;
  @override
  Future<void> clearFamilyData() async {
    if (fail) throw StateError('synthetic-storage-clear-failure');
    await super.clearFamilyData();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  AndroidFlutterLocalNotificationsPlugin.registerWith();
  const channel = MethodChannel('dexterous.com/flutter/local_notifications');
  late h.NotificationAdapter notifications;
  late MemorySecretStore secrets;
  late MemoryInventoryLocalStore local;
  bool failCancel = false;
  setUp(() {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    SharedPreferences.setMockInitialValues({
      'home_medicine.local_reminders.enabled': true,
    });
    notifications = h.NotificationAdapter();
    secrets = MemorySecretStore()
      ..values[ApiAuthRepository.accessTokenKey] = 'synthetic-token';
    local = MemoryInventoryLocalStore();
    failCancel = false;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'cancelAll' && failCancel) {
            throw PlatformException(code: 'synthetic-cancel-failure');
          }
          return notifications.handle(call);
        });
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
    debugDefaultTargetPlatformOverride = null;
  });
  test('malformed nickname must preserve valid family state', () async {
    final services = await h.serviceWith(
      (request) async {
        if (request.url.path == '/api/v1/medicines') return h.inventory();
        return h.jsonResponse({
          'user': {'id': 'synthetic-user', 'hasFamily': false, 'nickname': 123},
          'family': null,
        });
      },
      secrets: secrets,
      local: local,
    );
    await h.seedFamily(services);
    await expectLater(services.auth!.getCurrentUser(), throwsA(anything));
    expect(local.family?.id, 'family-a');
    expect(notifications.pending, isNotEmpty);
  });
  test('malformed present family must preserve valid family record', () async {
    final services = await h.serviceWith(
      (request) async {
        if (request.url.path == '/api/v1/medicines') return h.inventory();
        return h.jsonResponse({
          'user': {'id': 'synthetic-user', 'hasFamily': true},
          'family': {},
        });
      },
      secrets: secrets,
      local: local,
    );
    await h.seedFamily(services);
    try {
      await services.auth!.getCurrentUser();
    } catch (_) {}
    expect(local.family?.id, 'family-a');
  });
  test('failed cleanup must not permanently block explicit logout', () async {
    final services = await h.serviceWith(
      (request) async {
        if (request.url.path == '/api/v1/medicines') return h.inventory();
        if (request.url.path == '/api/v1/auth/logout') {
          return h.jsonResponse({});
        }
        return h.apiError('FAMILY_NOT_FOUND');
      },
      secrets: secrets,
      local: local,
    );
    await h.seedFamily(services);
    failCancel = true;
    await services.plans!.onChanged!();
    failCancel = false;
    await services.auth!.logout();
    expect(storedSyntheticToken(secrets), isNull);
  });
  test(
    'current 401 must delete stale token despite native cancellation failure',
    () async {
      final services = await h.serviceWith(
        (request) async {
          if (request.url.path == '/api/v1/medicines') return h.inventory();
          return h.apiError('UNAUTHORIZED', 401);
        },
        secrets: secrets,
        local: local,
      );
      await h.seedFamily(services);
      failCancel = true;
      await services.plans!.onChanged!();
      expect(services.sessionInvalidated.value, isTrue);
      expect(storedSyntheticToken(secrets), isNull);
    },
  );
  test('acknowledged dose confirmation with offline refresh removes old dose alarm and keeps stock', () async {
    var confirmed = false;
    final services = await h.serviceWith(
      (request) async {
        if (request.url.path == '/api/v1/medicines') return h.inventory();
        if (request.method == 'POST' && request.url.path.contains('/confirm')) {
          confirmed = true;
          return h.jsonResponse({'status': 'taken'});
        }
        if (confirmed) throw http.ClientException('synthetic-offline');
        if (request.url.path == '/api/v1/notification-preferences') {
          return h.jsonResponse({
            'preferences': {
              'channels': ['android'],
              'stockReminderTime': '09:00',
            },
          });
        }
        return h.jsonResponse({
          'entries': [
            {
              'occurrenceId': '11111111-1111-4111-8111-111111111111',
              'date': '2099-12-31',
              'time': '09:00',
            },
          ],
        });
      },
      secrets: secrets,
      local: local,
    );
    await h.seedFamily(services);
    await services.plans!.onChanged!();
    expect(notifications.pending.length, 5);
    await services.plans!.confirmDose(
      '11111111-1111-4111-8111-111111111111',
      action: 'taken',
      idempotencyKey: 'synthetic-key',
    );
    expect(notifications.pending.length, 4);
    expect(
      notifications.pending.values.every((v) => v['payload'] == 'pending'),
      isTrue,
    );
  });
  test('overlapping current loss cleanups cannot leave old native cancellation behind new family', () async {
    var identity = 'a';
    final services = await h.serviceWith(
      (request) async {
        if (request.url.path == '/api/v1/medicines') {
          return h.inventory(identity);
        }
        if (request.url.path == '/api/v1/families/invitations/accept') {
          identity = 'b';
          return h.jsonResponse({});
        }
        if (request.url.path == '/api/v1/families/current') {
          return h.jsonResponse({
            'family': {
              'id': 'family-b',
              'name': 'Synthetic b',
              'role': 'member',
            },
          });
        }
        return h.apiError('FAMILY_NOT_FOUND');
      },
      secrets: secrets,
      local: local,
    );
    await h.seedFamily(services);
    notifications.cancelEntered = Completer<void>();
    notifications.cancelRelease = Completer<void>();
    final oldLoss = expectLater(
      services.api!.get('/synthetic-probe-old'),
      throwsA(isA<ApiException>()),
    );
    await notifications.cancelEntered!.future;
    // This request begins in the new epoch while the first cleanup is pending.
    final newLoss = expectLater(
      services.api!.get('/synthetic-probe-new'),
      throwsA(isA<ApiException>()),
    );
    var accepted = false;
    final acceptance = services.families!
        .acceptInvitation('synthetic-code')
        .then((value) {
          accepted = true;
          return value;
        });
    for (var i = 0; i < 20; i++) {
      await Future<void>.delayed(Duration.zero);
    }
    final acceptedBeforeOldCancellationFinished = accepted;
    notifications.cancelRelease!.complete();
    await oldLoss;
    await newLoss;
    await acceptance;
    expect(
      acceptedBeforeOldCancellationFinished,
      isFalse,
      reason: 'acceptance must wait all older native cancellation futures',
    );
    await services.medicines!.listMedicines();
    services.reminders.enabled = true;
    await services.reminders.sync(services.medicines!.medicines);
    expect(notifications.pending.length, 4);
    expect(
      notifications.pending.length,
      4,
      reason: 'old cleanup must not cancel replacement family alarms',
    );
  });

  test(
    'an identity waiter drains a newer cleanup registered during its wait',
    () async {
      final first = Completer<void>();
      final second = Completer<void>();
      var calls = 0;
      final api = ApiClient(
        baseUrl: 'https://medicine.example',
        tokenProvider: () async => 'synthetic-token',
        client: MockClient((_) async => h.jsonResponse({})),
      );
      api.onFamilyUnavailable = () {
        api.invalidateIdentity();
        calls++;
        return calls == 1 ? first.future : second.future;
      };
      final cleanup1 = api.reportNoCurrentFamily(api.identityEpoch);
      var drained = false;
      final waiter = api.waitForIdentityCleanup().then((_) {
        drained = true;
      });
      final cleanup2 = api.reportNoCurrentFamily(api.identityEpoch);
      first.complete();
      for (var i = 0; i < 20; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      final returnedBeforeNewestCleanup = drained;
      second.complete();
      await Future.wait([cleanup1, cleanup2, waiter]);
      expect(
        returnedBeforeNewestCleanup,
        isFalse,
        reason: 'barrier wait must observe cleanup added while waiting',
      );
      api.close();
    },
  );
  test('persistent cancellation failure still allows explicit logout token deletion', () async {
    final services = await h.serviceWith(
      (request) async {
        if (request.url.path == '/api/v1/medicines') return h.inventory();
        if (request.url.path == '/api/v1/auth/logout') {
          return h.jsonResponse({});
        }
        return h.apiError('FAMILY_NOT_FOUND');
      },
      secrets: secrets,
      local: local,
    );
    await h.seedFamily(services);
    failCancel = true;
    await services.plans!.onChanged!();
    await services.auth!.logout();
    expect(storedSyntheticToken(secrets), isNull);
    expect(services.sessionInvalidated.value, isTrue);
  });

  test('failed cleanup holds family guard and blocks acceptance until a later successful explicit retry', () async {
    var accepted = 0;
    final services = await h.serviceWith(
      (request) async {
        if (request.url.path == '/api/v1/medicines') return h.inventory();
        if (request.method == 'POST') {
          accepted++;
          return h.jsonResponse({});
        }
        if (request.url.path == '/api/v1/families/current') {
          return h.jsonResponse({
            'family': {
              'id': 'family-b',
              'name': 'Synthetic b',
              'role': 'member',
            },
          });
        }
        return h.apiError('FAMILY_NOT_FOUND');
      },
      secrets: secrets,
      local: local,
    );
    await h.seedFamily(services);
    failCancel = true;
    await services.plans!.onChanged!();
    await expectLater(
      services.families!.acceptInvitation('synthetic'),
      throwsA(anything),
    );
    expect(accepted, 0);
    expect(services.familyInvalidated.value, isTrue);
    failCancel = false;
    await services.families!.acceptInvitation('synthetic');
    expect(accepted, 1);
    expect(local.family!.id, 'family-b');
    expect(local.inventory, isNull);
    expect(notifications.pending, isEmpty);
    expect(services.familyInvalidated.value, isFalse);
  });

  test('failed native initialization can recover on a later explicit family transition', () async {
    var failInitialize = true;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'initialize' && failInitialize) {
            throw PlatformException(code: 'synthetic-init-failure');
          }
          return notifications.handle(call);
        });
    final services = await h.serviceWith(
      (request) async {
        if (request.method == 'POST') return h.jsonResponse({});
        if (request.url.path == '/api/v1/families/current') {
          return h.jsonResponse({
            'family': {
              'id': 'family-b',
              'name': 'Synthetic b',
              'role': 'member',
            },
          });
        }
        return h.apiError('FAMILY_NOT_FOUND');
      },
      secrets: secrets,
      local: local,
    );
    notifications.pending[123] = {'id': 123, 'payload': 'pending'};
    await services.plans!.onChanged!();
    expect(services.familyInvalidated.value, isTrue);
    failInitialize = false;
    await services.families!.acceptInvitation('synthetic');
    expect(local.family!.id, 'family-b');
    expect(notifications.pending, isEmpty);
    expect(services.familyInvalidated.value, isFalse);
  });

  test('old acknowledged mutation hook cannot erase a replacement identity dose projection', () async {
    final services = await h.serviceWith(
      (request) async {
        if (request.url.path == '/api/v1/medicines') return h.inventory();
        if (request.method == 'POST') {
          return h.jsonResponse({'status': 'taken'});
        }
        if (request.url.path == '/api/v1/notification-preferences') {
          return h.jsonResponse({
            'preferences': {
              'channels': ['android'],
              'stockReminderTime': '09:00',
            },
          });
        }
        return h.jsonResponse({
          'entries': [
            {
              'occurrenceId': '11111111-1111-4111-8111-111111111111',
              'date': '2099-12-31',
              'time': '09:00',
            },
          ],
        });
      },
      secrets: secrets,
      local: local,
    );
    await h.seedFamily(services);
    await services.plans!.onChanged!();
    final ids = notifications.pending.keys.toSet();
    expect(ids.length, 5);
    await services.plans!.confirmDose(
      'synthetic-old',
      action: 'taken',
      idempotencyKey: 'synthetic',
      onConfirmed: (_) {
        // Switch precisely between acknowledged response and observer hooks.
        services.api!.invalidateIdentity();
      },
    );
    expect(notifications.pending.keys.toSet(), ids);
  });
  for (final failDelete in [false, true]) {
    testWidgets(
      failDelete
          ? 'offline logout and secret deletion failure cannot restore session through same-process boot route'
          : 'explicit logout with slow cleanup ends at connect rather than family setup',
      (tester) async {
        if (failDelete) {
          secrets = FailedDeleteSecrets()
            ..values[ApiAuthRepository.accessTokenKey] = 'synthetic-token';
        }
        await tester.binding.setSurfaceSize(const Size(800, 1600));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final delayedLocal = PausedFamilyClearStore();
        await http.runWithClient(
          () async {
            await tester.pumpWidget(
              HomeMedicineApp(
                apiBaseUrl: 'https://medicine.example',
                secretStore: secrets,
                identityStore: await identityFixture(
                  secrets,
                  localStore: delayedLocal,
                ),
                localStore: delayedLocal,
              ),
            );
            await tester.pumpAndSettle();
          },
          () => MockClient((request) async {
            if (failDelete && request.url.path == '/api/v1/auth/logout') {
              throw http.ClientException('synthetic-offline');
            }
            final family = {
              'id': 'family-a',
              'name': 'Synthetic family',
              'role': 'owner',
            };
            if (request.url.path == '/api/v1/auth/me') {
              return h.jsonResponse({
                'user': {'id': 'synthetic-user', 'hasFamily': true},
                'family': family,
              });
            }
            if (request.url.path == '/api/v1/families/current') {
              return h.jsonResponse({'family': family});
            }
            if (request.url.path == '/api/v1/medicines') return h.inventory();
            if (request.url.path == '/api/v1/notification-preferences') {
              return h.jsonResponse({
                'preferences': {
                  'channels': ['android'],
                  'stockReminderTime': '09:00',
                },
              });
            }
            if (request.url.path == '/api/v1/auth/device-links') {
              return h.jsonResponse({
                'code': 'SYNTHETIC',
                'pollToken': 'synthetic-poll',
                'expiresAt': '2099-12-31T00:00:00Z',
              });
            }
            return h.jsonResponse({'date': '2099-12-31', 'entries': []});
          }),
        );
        expect(find.byType(ProductionShell), findsOneWidget);
        await tester.tap(find.text('我的'));
        await tester.pumpAndSettle();
        await tester.scrollUntilVisible(find.text('退出 App 登录'), 400);
        await tester.pumpAndSettle();
        await tester.tap(find.text('退出 App 登录'));
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, '退出登录'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));
        expect(delayedLocal.entered.isCompleted, isTrue);
        delayedLocal.release.complete();
        await tester.pumpAndSettle();
        expect(
          storedSyntheticToken(secrets),
          failDelete ? 'synthetic-token' : isNull,
        );
        expect(find.byType(DeviceLinkPage), findsOneWidget);
        final router = GoRouter.of(tester.element(find.byType(DeviceLinkPage)));
        router.go('/');
        await tester.pumpAndSettle();
        expect(find.byType(DeviceLinkPage), findsOneWidget);
        expect(find.text('先选择你的家庭'), findsNothing);
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpAndSettle();
        debugDefaultTargetPlatformOverride = null;
      },
    );
  }

  test('definitive family cleanup preserves export ownership hook and unrelated synthetic files', () async {
    final root = await Directory.systemTemp.createTemp(
      'medbox-family-export-test-',
    );
    final previousPaths = PathProviderPlatform.instance;
    PathProviderPlatform.instance = FamilyCleanupPaths(root);
    addTearDown(() async {
      PathProviderPlatform.instance = previousPaths;
      await root.delete(recursive: true);
    });
    final services = await h.serviceWith(
      (request) async {
        if (request.url.path == '/api/v1/medicines') return h.inventory();
        return h.apiError('FAMILY_NOT_FOUND');
      },
      secrets: secrets,
      local: local,
      exportFiles: ExportTemporaryStore(
        process: ExportProcessCoordinator(
          temporaryDirectory: () async => root,
          journal: ExportOwnershipJournal(state: MemoryPrivateAtomicState()),
        ),
      ),
    );
    await h.seedFamily(services);
    final unrelated = await File('${root.path}/unrelated-synthetic.txt')
        .writeAsString('synthetic fixture');
    final exports = services.workflow!.exportFiles;
    final owned = await exports.create(
      bytes: [1, 2, 3],
      extension: 'csv',
      identityEpoch: exports.identityEpoch,
    );
    expect(await owned.file.exists(), isTrue);
    await services.plans!.onChanged!();
    expect(await owned.file.exists(), isFalse);
    expect(await unrelated.exists(), isTrue);
    expect(local.family, isNull);
    expect(await services.auth!.readAccessToken(), 'synthetic-token');
  });

  test('failed local storage cleanup blocks family acceptance and later retry clears private data', () async {
    final failedStore = FailingFamilyClearStore();
    var accepted = 0;
    final services = await h.serviceWith(
      (request) async {
        if (request.url.path == '/api/v1/medicines') return h.inventory();
        if (request.method == 'POST') {
          accepted++;
          return h.jsonResponse({});
        }
        if (request.url.path == '/api/v1/families/current') {
          return h.jsonResponse({
            'family': {
              'id': 'family-b',
              'name': 'Synthetic b',
              'role': 'member',
            },
          });
        }
        return h.apiError('FAMILY_NOT_FOUND');
      },
      secrets: secrets,
      local: failedStore,
    );
    await h.seedFamily(services);
    failedStore.fail = true;
    await services.plans!.onChanged!();
    expect(failedStore.drafts, isNotEmpty);
    expect(services.familyInvalidated.value, isTrue);
    await expectLater(
      services.families!.acceptInvitation('synthetic'),
      throwsA(anything),
    );
    expect(accepted, 0);
    failedStore.fail = false;
    await services.families!.acceptInvitation('synthetic');
    expect(accepted, 1);
    expect(failedStore.family!.id, 'family-b');
    expect(failedStore.drafts, isEmpty);
    expect(notifications.pending, isEmpty);
  });
}
