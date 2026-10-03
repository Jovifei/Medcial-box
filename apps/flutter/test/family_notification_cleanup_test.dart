import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:home_medicine_flutter/app.dart';
import 'package:home_medicine_flutter/features/home/production_shell.dart';
import 'package:home_medicine_flutter/features/auth/device_link_page.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:home_medicine_flutter/data/api_auth_repository.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/app_services.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';
import 'package:shared_preferences/shared_preferences.dart';

http.Response jsonResponse(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);
http.Response apiError(String code, [int status = 404]) => jsonResponse({
  'error': {'code': code, 'message': 'Synthetic response'},
}, status);

class PausedSecrets extends MemorySecretStore {
  bool pauseNextRead = false;
  final entered = Completer<void>();
  final release = Completer<void>();
  @override
  Future<String?> read(String key) async {
    final value = await super.read(key);
    if (pauseNextRead) {
      pauseNextRead = false;
      entered.complete();
      await release.future;
    }
    return value;
  }
}

class NotificationAdapter {
  final pending = <int, Map<dynamic, dynamic>>{};
  int cancels = 0;
  Completer<void>? cancelEntered;
  Completer<void>? cancelRelease;
  Future<Object?> handle(MethodCall call) async {
    switch (call.method) {
      case 'initialize':
        return true;
      case 'getNotificationAppLaunchDetails':
        return null;
      case 'cancelAll':
        cancels++;
        if (cancelEntered != null && !cancelEntered!.isCompleted) {
          cancelEntered!.complete();
          await cancelRelease!.future;
        }
        pending.clear();
        return null;
      case 'zonedSchedule':
        final payload = call.arguments as Map<dynamic, dynamic>;
        pending[payload['id'] as int] = payload;
        return null;
      default:
        return null;
    }
  }
}

Future<AppServices> serviceWith(
  Future<http.Response> Function(http.Request) handler, {
  required MemorySecretStore secrets,
  required MemoryInventoryLocalStore local,
}) => http.runWithClient(
  () => AppServices.create(
    apiBaseUrl: 'https://medicine.example',
    secretStore: secrets,
    localStore: local,
  ),
  () => MockClient(handler),
);

Future<void> seedFamily(AppServices services) async {
  await services.localStore.saveFamily(
    FamilyRecord(id: 'family-a', name: 'Synthetic family', role: 'member'),
  );
  await services.localStore.saveDraft(
    'medicine-new',
    'synthetic-private-draft',
  );
  await services.medicines!.listMedicines();
  await services.reminders.resume(services.medicines!);
}

http.Response inventory([String identity = 'a']) => jsonResponse({
  'medicines': [
    {
      'id': 'medicine-$identity',
      'name': 'Synthetic private item',
      'batches': [
        {'id': 'batch-$identity', 'managementExpiryDate': '2099-12-31'},
      ],
    },
  ],
});

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  AndroidFlutterLocalNotificationsPlugin.registerWith();
  const channel = MethodChannel('dexterous.com/flutter/local_notifications');
  late NotificationAdapter notifications;
  late MemorySecretStore secrets;
  late MemoryInventoryLocalStore local;

  setUp(() {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    SharedPreferences.setMockInitialValues({
      'home_medicine.local_reminders.enabled': true,
    });
    notifications = NotificationAdapter();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, notifications.handle);
    secrets = MemorySecretStore()
      ..values[ApiAuthRepository.accessTokenKey] = 'synthetic-session-a';
    local = MemoryInventoryLocalStore();
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
    debugDefaultTargetPlatformOverride = null;
  });

  test('current FAMILY_NOT_FOUND clears stock alarms and private family cache but retains login', () async {
    final methods = <String>[];
    final services = await serviceWith(
      (request) async {
        methods.add(request.method);
        if (request.url.path == '/api/v1/medicines') return inventory();
        return apiError('FAMILY_NOT_FOUND');
      },
      secrets: secrets,
      local: local,
    );
    await seedFamily(services);
    expect(notifications.pending, isNotEmpty);
    await services.plans!.onChanged!();
    expect(
      notifications.pending,
      isEmpty,
      reason:
          'membership loss must cancel existing stock as well as dose alarms',
    );
    expect(services.medicines!.medicines, isEmpty);
    expect(local.inventory, isNull);
    expect(local.family, isNull);
    expect(local.lastSyncedAt, isNull);
    expect(local.drafts, isEmpty);
    expect(await services.auth!.readAccessToken(), 'synthetic-session-a');
    expect(services.sessionInvalidated.value, isFalse);
    expect(methods.every((method) => method == 'GET'), isTrue);
  });

  for (final failure in [
    'network',
    'FORBIDDEN',
    'NOT_FOUND',
    'FAMILY_NOT_FOUND_500',
  ]) {
    test(
      '$failure does not invalidate current family inventory or stock alarms',
      () async {
        final services = await serviceWith(
          (request) async {
            if (request.url.path == '/api/v1/medicines') return inventory();
            if (failure == 'network') {
              throw http.ClientException('synthetic offline');
            }
            return apiError(
              failure == 'FAMILY_NOT_FOUND_500' ? 'FAMILY_NOT_FOUND' : failure,
              failure == 'FORBIDDEN'
                  ? 403
                  : failure == 'FAMILY_NOT_FOUND_500'
                  ? 500
                  : 404,
            );
          },
          secrets: secrets,
          local: local,
        );
        await seedFamily(services);
        final oldIds = notifications.pending.keys.toSet();
        await services.plans!.onChanged!();
        expect(notifications.pending.keys.toSet(), oldIds);
        expect(services.medicines!.medicines.single.id, 'medicine-a');
        expect(local.family!.id, 'family-a');
        expect(local.drafts, isNotEmpty);
        expect(await services.auth!.readAccessToken(), 'synthetic-session-a');
        expect(services.sessionInvalidated.value, isFalse);
      },
    );
  }

  test(
    'current session expiry clears all private family state and token',
    () async {
      final services = await serviceWith(
        (request) async {
          if (request.url.path == '/api/v1/medicines') return inventory();
          return apiError('UNAUTHORIZED', 401);
        },
        secrets: secrets,
        local: local,
      );
      await seedFamily(services);
      await services.plans!.onChanged!();
      expect(notifications.pending, isEmpty);
      expect(services.medicines!.medicines, isEmpty);
      expect(local.inventory, isNull);
      expect(local.family, isNull);
      expect(local.drafts, isEmpty);
      expect(await services.auth!.readAccessToken(), isNull);
      expect(services.sessionInvalidated.value, isTrue);
      expect(services.familyInvalidated.value, isFalse);
    },
  );

  for (final action in ['create', 'join']) {
    test(
      'explicit $action recovers authenticated family setup after family loss',
      () async {
        var removed = false;
        var identity = 'a';
        final services = await serviceWith(
          (request) async {
            if (request.url.path == '/api/v1/medicines') {
              return inventory(identity);
            }
            if (request.method == 'POST') {
              identity = 'b';
              removed = false;
              return jsonResponse({});
            }
            if (removed) return apiError('FAMILY_NOT_FOUND');
            return jsonResponse({
              'family': {
                'id': 'family-$identity',
                'name': 'Synthetic family $identity',
                'role': 'owner',
              },
            });
          },
          secrets: secrets,
          local: local,
        );
        await seedFamily(services);
        removed = true;
        await services.plans!.onChanged!();
        expect(services.familyInvalidated.value, isTrue);
        expect(notifications.pending, isEmpty);
        final family = action == 'create'
            ? await services.families!.createFamily('Synthetic family b')
            : await services.families!.acceptInvitation('synthetic-invitation');
        expect(family.id, 'family-b');
        expect(local.family!.id, 'family-b');
        expect(local.inventory, isNull);
        expect(local.drafts, isEmpty);
        expect(notifications.pending, isEmpty);
        expect(services.familyInvalidated.value, isFalse);
        expect(services.sessionInvalidated.value, isFalse);
        expect(await services.auth!.readAccessToken(), 'synthetic-session-a');
      },
    );
  }

  for (final status in [401, 404]) {
    for (final deferredToken in [false, true]) {
      test(
        'late $status ${deferredToken ? 'token lookup' : 'response'} cannot clear newly accepted same-token family',
        () async {
          final pausedSecrets = PausedSecrets()
            ..values[ApiAuthRepository.accessTokenKey] = 'synthetic-session-a';
          final entered = Completer<void>();
          final release = Completer<void>();
          var identity = 'a';
          final services = await serviceWith(
            (request) async {
              if (request.url.path == '/api/v1/medicines') {
                return inventory(identity);
              }
              if (request.url.path == '/api/v1/families/invitations/accept') {
                identity = 'b';
                return jsonResponse({});
              }
              if (request.url.path == '/api/v1/families/current') {
                return jsonResponse({
                  'family': {
                    'id': 'family-$identity',
                    'name': 'Synthetic family $identity',
                    'role': 'member',
                  },
                });
              }
              if (deferredToken) {
                pausedSecrets.pauseNextRead = true;
              } else {
                entered.complete();
                await release.future;
              }
              return apiError(
                status == 401 ? 'UNAUTHORIZED' : 'FAMILY_NOT_FOUND',
                status,
              );
            },
            secrets: pausedSecrets,
            local: local,
          );
          await seedFamily(services);
          final refresh = services.plans!.onChanged!();
          await (deferredToken ? pausedSecrets.entered.future : entered.future);
          await services.families!.acceptInvitation('synthetic-invitation');
          await services.medicines!.listMedicines();
          services.reminders.enabled = true;
          await services.reminders.sync(services.medicines!.medicines);
          await services.localStore.saveDraft(
            'new',
            'synthetic-family-b-draft',
          );
          final ids = notifications.pending.keys.toSet();
          expect(ids, isNotEmpty);
          if (deferredToken) {
            pausedSecrets.release.complete();
          } else {
            release.complete();
          }
          await refresh;
          expect(notifications.pending.keys.toSet(), ids);
          expect(local.family!.id, 'family-b');
          expect(local.inventory!.single.id, 'medicine-b');
          expect(local.drafts, {'new': 'synthetic-family-b-draft'});
          expect(await services.auth!.readAccessToken(), 'synthetic-session-a');
          expect(services.sessionInvalidated.value, isFalse);
          expect(services.familyInvalidated.value, isFalse);
        },
      );
    }
  }

  test('transient reminder reads retain valid stock and dose alarms; successful revocation removes only dose alarms', () async {
    var offline = false;
    var revoked = false;
    final services = await serviceWith(
      (request) async {
        if (request.url.path == '/api/v1/medicines') return inventory();
        if (offline) throw http.ClientException('synthetic offline');
        if (request.url.path == '/api/v1/notification-preferences') {
          return jsonResponse({
            'preferences': {
              'channels': ['android'],
              'stockReminderTime': '09:00',
            },
          });
        }
        return jsonResponse({
          'entries': [
            if (!revoked)
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
    await seedFamily(services);
    await services.plans!.onChanged!();
    expect(notifications.pending.length, 5);
    final ids = notifications.pending.keys.toSet();
    offline = true;
    await services.plans!.onChanged!();
    expect(notifications.pending.keys.toSet(), ids);
    expect(local.family!.id, 'family-a');
    offline = false;
    revoked = true;
    await services.plans!.onChanged!();
    expect(notifications.pending.length, 4);
    expect(
      notifications.pending.values.every(
        (value) => value['payload'] == 'pending',
      ),
      isTrue,
    );
    expect(local.inventory!.single.id, 'medicine-a');
    expect(local.drafts, isNotEmpty);
    expect(services.familyInvalidated.value, isFalse);
  });

  test('explicit family acceptance waits for in-flight identity cleanup cancellation', () async {
    var accepted = false;
    final services = await serviceWith(
      (request) async {
        if (request.url.path == '/api/v1/medicines') return inventory();
        if (request.method == 'POST') {
          accepted = true;
          return jsonResponse({});
        }
        if (request.url.path == '/api/v1/families/current') {
          return jsonResponse({
            'family': {
              'id': 'family-b',
              'name': 'Synthetic b',
              'role': 'member',
            },
          });
        }
        return apiError('FAMILY_NOT_FOUND');
      },
      secrets: secrets,
      local: local,
    );
    await seedFamily(services);
    notifications.cancelEntered = Completer<void>();
    notifications.cancelRelease = Completer<void>();
    final refresh = services.plans!.onChanged!();
    await notifications.cancelEntered!.future;
    final acceptance = services.families!.acceptInvitation('synthetic-code');
    await Future<void>.delayed(Duration.zero);
    expect(
      accepted,
      isFalse,
      reason: 'new family request cannot cross old native cancellation',
    );
    notifications.cancelRelease!.complete();
    await refresh;
    await acceptance;
    expect(accepted, isTrue);
    expect(local.family!.id, 'family-b');
    expect(services.familyInvalidated.value, isFalse);
  });

  testWidgets(
    'authoritative family loss leaves protected screen for family setup and explicit creation restores home',
    (tester) async {
      var missing = false;
      var identity = 'a';
      final methods = <String>[];
      final client = MockClient((request) async {
        methods.add(request.method);
        if (request.method == 'POST' &&
            request.url.path == '/api/v1/families') {
          missing = false;
          identity = 'b';
          return jsonResponse({});
        }
        if (missing) return apiError('FAMILY_NOT_FOUND');
        final family = {
          'id': 'family-$identity',
          'name': 'Synthetic family $identity',
          'role': 'owner',
        };
        if (request.url.path == '/api/v1/auth/me') {
          return jsonResponse({
            'user': {'id': 'user-a', 'hasFamily': true},
            'family': family,
          });
        }
        if (request.url.path == '/api/v1/families/current') {
          return jsonResponse({'family': family});
        }
        if (request.url.path == '/api/v1/medicines') return inventory(identity);
        if (request.url.path == '/api/v1/notification-preferences') {
          return jsonResponse({
            'preferences': {
              'channels': ['android'],
              'stockReminderTime': '09:00',
            },
          });
        }
        return jsonResponse({'date': '2099-12-31', 'entries': []});
      });
      await http.runWithClient(() async {
        await tester.pumpWidget(
          HomeMedicineApp(
            apiBaseUrl: 'https://medicine.example',
            secretStore: secrets,
            localStore: local,
          ),
        );
        await tester.pumpAndSettle();
      }, () => client);
      final services = tester
          .widget<ProductionShell>(find.byType(ProductionShell))
          .services;
      expect(notifications.pending, isNotEmpty);
      missing = true;
      await services.plans!.onChanged!();
      await tester.pumpAndSettle();
      expect(find.text('先选择你的家庭'), findsOneWidget);
      expect(find.byType(ProductionShell), findsNothing);
      expect(notifications.pending, isEmpty);
      expect(await services.auth!.readAccessToken(), 'synthetic-session-a');
      expect(
        methods.every((method) => method == 'GET'),
        isTrue,
        reason: 'membership-loss handling does not replay writes or send notifications',
      );
      final router = GoRouter.of(tester.element(find.text('先选择你的家庭')));
      router.go('/home');
      await tester.pumpAndSettle();
      expect(find.text('先选择你的家庭'), findsOneWidget);
      await tester.tap(find.text('创建家庭药箱'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('创建并进入药箱'));
      await tester.pumpAndSettle();
      expect(find.byType(ProductionShell), findsOneWidget);
      expect(local.family!.id, 'family-b');
      expect(local.inventory!.single.id, 'medicine-b');
      expect(services.familyInvalidated.value, isFalse);
      expect(await services.auth!.readAccessToken(), 'synthetic-session-a');
      expect(methods.where((method) => method == 'POST').length, 1);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
      debugDefaultTargetPlatformOverride = null;
    },
  );

  test('explicit current auth/me no-family success clears private state without logging out', () async {
    final services = await serviceWith(
      (request) async {
        if (request.url.path == '/api/v1/medicines') return inventory();
        return jsonResponse({
          'user': {'id': 'synthetic-user', 'hasFamily': false},
          'family': null,
        });
      },
      secrets: secrets,
      local: local,
    );
    await seedFamily(services);
    final profile = await services.auth!.getCurrentUser();
    expect(profile.hasFamily, isFalse);
    expect(notifications.pending, isEmpty);
    expect(local.inventory, isNull);
    expect(local.family, isNull);
    expect(local.drafts, isEmpty);
    expect(services.familyInvalidated.value, isTrue);
    expect(services.sessionInvalidated.value, isFalse);
    expect(await services.auth!.readAccessToken(), 'synthetic-session-a');
  });

  for (final shape in [
    'valid-family',
    'missing-flag',
    'missing-family',
    'false-with-family',
    'true-with-null',
    'missing-user-id',
    'blank-user-id',
    'failed-read',
  ]) {
    test('auth/me $shape does not clear valid caches or alarms', () async {
      final family = {
        'id': 'family-a',
        'name': 'Synthetic family',
        'role': 'member',
      };
      final services = await serviceWith(
        (request) async {
          if (request.url.path == '/api/v1/medicines') return inventory();
          if (shape == 'failed-read') {
            throw http.ClientException('synthetic offline');
          }
          return jsonResponse({
            'user': {
              if (shape != 'missing-user-id')
                'id': shape == 'blank-user-id' ? '   ' : 'synthetic-user',
              if (shape != 'missing-flag')
                'hasFamily': ['valid-family', 'true-with-null'].contains(shape),
            },
            if (shape != 'missing-family')
              'family': ['valid-family', 'false-with-family'].contains(shape)
                  ? family
                  : null,
          });
        },
        secrets: secrets,
        local: local,
      );
      await seedFamily(services);
      final ids = notifications.pending.keys.toSet();
      if (shape == 'valid-family') {
        expect((await services.auth!.getCurrentUser()).hasFamily, isTrue);
      } else {
        await expectLater(
          services.auth!.getCurrentUser(),
          throwsA(isA<Exception>()),
        );
      }
      expect(notifications.pending.keys.toSet(), ids);
      expect(local.inventory!.single.id, 'medicine-a');
      expect(local.family!.id, 'family-a');
      expect(local.drafts, isNotEmpty);
      expect(services.familyInvalidated.value, isFalse);
      expect(await services.auth!.readAccessToken(), 'synthetic-session-a');
    });
  }

  test('late old auth/me no-family success cannot clear a newly accepted same-token family', () async {
    final entered = Completer<void>();
    final release = Completer<void>();
    final services = await serviceWith(
      (request) async {
        if (request.url.path == '/api/v1/medicines') return inventory();
        if (request.url.path == '/api/v1/auth/me') {
          entered.complete();
          await release.future;
          return jsonResponse({
            'user': {'id': 'synthetic-user', 'hasFamily': false},
            'family': null,
          });
        }
        if (request.method == 'POST') return jsonResponse({});
        return jsonResponse({
          'family': {'id': 'family-b', 'name': 'Synthetic b', 'role': 'member'},
        });
      },
      secrets: secrets,
      local: local,
    );
    await seedFamily(services);
    final profile = services.auth!.getCurrentUser();
    final rejected = expectLater(
      profile,
      throwsA(
        isA<ApiException>().having((e) => e.code, 'code', 'STALE_SESSION'),
      ),
    );
    await entered.future;
    await services.families!.acceptInvitation('synthetic-code');
    await services.localStore.saveDraft('new', 'synthetic-family-b');
    release.complete();
    await rejected;
    expect(local.family!.id, 'family-b');
    expect(local.drafts, {'new': 'synthetic-family-b'});
    expect(services.familyInvalidated.value, isFalse);
    expect(await services.auth!.readAccessToken(), 'synthetic-session-a');
  });

  test(
    'auth and family acceptance share one identity transition queue',
    () async {
      final entered = Completer<void>();
      final release = Completer<void>();
      final acceptedWith = <String?>[];
      secrets.values[ApiAuthRepository.pendingPollTokenKey] = 'synthetic-poll';
      final services = await serviceWith(
        (request) async {
          if (request.url.path.endsWith('/device-links/exchange')) {
            entered.complete();
            await release.future;
            return jsonResponse({
              'state': 'approved',
              'token': 'synthetic-session-b',
            });
          }
          if (request.url.path.endsWith('/invitations/accept')) {
            acceptedWith.add(request.headers['authorization']);
            return jsonResponse({});
          }
          return jsonResponse({
            'family': {
              'id': 'family-b',
              'name': 'Synthetic b',
              'role': 'member',
            },
          });
        },
        secrets: secrets,
        local: local,
      );
      final reconnect = services.auth!.exchangePendingLink();
      await entered.future;
      final join = services.families!.acceptInvitation('synthetic-code');
      await Future<void>.delayed(Duration.zero);
      expect(acceptedWith, isEmpty);
      release.complete();
      await reconnect;
      await join;
      expect(acceptedWith, ['Bearer synthetic-session-b']);
      expect(local.family!.id, 'family-b');
      expect(await services.auth!.readAccessToken(), 'synthetic-session-b');
    },
  );

  testWidgets(
    'boot explicit no-family success cancels prior native alarms and retains authenticated setup',
    (tester) async {
      await local.saveFamily(
        FamilyRecord(id: 'family-a', name: 'Synthetic a', role: 'member'),
      );
      await local.saveDraft('old', 'synthetic-private-draft');
      notifications.pending[12] = {'id': 12, 'payload': 'pending'};
      final methods = <String>[];
      await http.runWithClient(
        () async {
          await tester.pumpWidget(
            HomeMedicineApp(
              apiBaseUrl: 'https://medicine.example',
              secretStore: secrets,
              localStore: local,
            ),
          );
          await tester.pumpAndSettle();
        },
        () => MockClient((request) async {
          methods.add(request.method);
          return jsonResponse({
            'user': {'id': 'synthetic-user', 'hasFamily': false},
            'family': null,
          });
        }),
      );
      expect(find.text('先选择你的家庭'), findsOneWidget);
      expect(local.family, isNull);
      expect(local.drafts, isEmpty);
      expect(notifications.pending, isEmpty);
      expect(
        secrets.values[ApiAuthRepository.accessTokenKey],
        'synthetic-session-a',
      );
      expect(methods, ['GET']);
      await tester.pumpWidget(const SizedBox.shrink());
      debugDefaultTargetPlatformOverride = null;
    },
  );

  testWidgets('boot late old401 cannot delete a newly accepted session token', (
    tester,
  ) async {
    final entered = Completer<void>();
    final release = Completer<void>();
    secrets.values[ApiAuthRepository.pendingPollTokenKey] = 'synthetic-poll';
    await http.runWithClient(
      () async {
        await tester.pumpWidget(
          HomeMedicineApp(
            apiBaseUrl: 'https://medicine.example',
            secretStore: secrets,
            localStore: local,
          ),
        );
        await tester.pump();
        await tester.pump();
      },
      () => MockClient((request) async {
        if (request.url.path == '/api/v1/auth/me') {
          entered.complete();
          await release.future;
          return apiError('UNAUTHORIZED', 401);
        }
        return jsonResponse({
          'state': 'approved',
          'token': 'synthetic-session-b',
        });
      }),
    );
    final services = tester
        .widget<BootGatePage>(find.byType(BootGatePage))
        .services;
    expect(entered.isCompleted, isTrue);
    await services.auth!.exchangePendingLink();
    await services.localStore.saveFamily(
      FamilyRecord(id: 'family-b', name: 'Synthetic b', role: 'owner'),
    );
    release.complete();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('重试'), findsOneWidget);
    expect(
      secrets.values[ApiAuthRepository.accessTokenKey],
      'synthetic-session-b',
    );
    expect(local.family!.id, 'family-b');
    expect(services.sessionInvalidated.value, isFalse);
    expect(find.byType(DeviceLinkPage), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
    debugDefaultTargetPlatformOverride = null;
  });

  test(
    '401 identity cleanup rechecks epoch after deferred token lookup',
    () async {
      final entered = Completer<void>();
      final tokenLookup = Completer<String?>();
      var reads = 0;
      var cleared = 0;
      final api = ApiClient(
        baseUrl: 'https://medicine.example',
        tokenProvider: () {
          reads++;
          if (reads == 1) return Future.value('synthetic-same-token');
          entered.complete();
          return tokenLookup.future;
        },
        client: MockClient((_) async => apiError('UNAUTHORIZED', 401)),
      );
      api.onUnauthorized = () async {
        cleared++;
      };
      final request = api.get('/api/v1/medicines');
      final rejected = expectLater(request, throwsA(isA<ApiException>()));
      await entered.future;
      api.invalidateIdentity();
      tokenLookup.complete('synthetic-same-token');
      await rejected;
      expect(
        cleared,
        0,
        reason: 'a delayed token read cannot authorize cleanup of a replacement identity',
      );
    },
  );
}
