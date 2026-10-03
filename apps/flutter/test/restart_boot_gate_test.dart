import 'dart:async';
import 'dart:convert';

import 'package:home_medicine_flutter/features/medicine/medicine_entry_api_page.dart';
import 'package:home_medicine_flutter/data/medicine_draft_queue.dart';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:home_medicine_flutter/app.dart';
import 'package:home_medicine_flutter/core/widgets/app_surfaces.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_plan_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/plan_form_drafts.dart';
import 'package:home_medicine_flutter/data/private_atomic_state.dart';
import 'package:home_medicine_flutter/data/session_identity_state.dart';
import 'package:home_medicine_flutter/features/auth/device_link_page.dart';
import 'package:home_medicine_flutter/features/home/production_shell.dart';
import 'package:home_medicine_flutter/features/my/my_page.dart';
import 'package:home_medicine_flutter/features/plan/plan_detail_page.dart';
import 'package:home_medicine_flutter/features/plan/plan_form_page.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _origin = 'https://medicine.example';
const _occurrence = '11111111-1111-4111-8111-111111111111';
const _launchPayload = 'dose-occurrence:v1:2026-10-03:$_occurrence';
const _cachedName = 'Synthetic private cached medicine';
const _draftName = 'Synthetic owned restart draft';
const _detailName = 'Synthetic authorized notification plan';
const _channel = MethodChannel('dexterous.com/flutter/local_notifications');

http.Response _json(Object value, [int status = 200]) => http.Response.bytes(
  utf8.encode(jsonEncode(value)),
  status,
  headers: {'content-type': 'application/json'},
);

class _Notifications {
  bool launch = false;
  int launchReads = 0;
  final calls = <String>[];

  Future<Object?> handle(MethodCall call) async {
    calls.add(call.method);
    if (call.method == 'initialize') return true;
    if (call.method == 'getNotificationAppLaunchDetails') {
      launchReads++;
      return {
        'notificationLaunchedApp': launch,
        if (launch)
          'notificationResponse': {
            'notificationId': 7,
            'notificationResponseType': 0,
            'payload': _launchPayload,
          },
      };
    }
    return null;
  }
}

class _FaultIdentityStore extends MemoryPrivateAtomicState {
  bool failSignOut = false;
  bool writeStarted = false;
  Completer<void>? gate;

  @override
  Future<void> write(String value) async {
    if (failSignOut && (jsonDecode(value) as Map)['state'] == 'signedOut') {
      writeStarted = true;
      await gate?.future;
      throw StateError('Synthetic signout persistence failure');
    }
    await super.write(value);
  }
}

class _Fixture {
  _Fixture({MemoryPrivateAtomicState? identityStore})
    : identityStore = identityStore ?? MemoryPrivateAtomicState();
  final secrets = MemorySecretStore();
  final MemoryPrivateAtomicState identityStore;
  final local = MemoryInventoryLocalStore();
  final requests = <http.Request>[];
  bool offline = false;
  bool familyMissing = false;
  bool notificationVisible = true;

  Map<String, Object?> get family => {
    'id': 'family-a',
    'name': 'Synthetic family A',
    'role': 'owner',
  };

  Future<SessionIdentityState> accepted({
    bool owner = true,
    String? familyId = 'family-a',
  }) async {
    final state = SessionIdentityState(
      origin: _origin,
      secrets: secrets,
      persistence: identityStore,
    );
    await state.initialize();
    state.finishLegacyQuarantine();
    await state.acceptToken(state.beginLink(), 'synthetic-restart-token');
    if (owner) {
      await state.recordOwner(
        expectedGeneration: state.generation!,
        userId: 'user-a',
        familyId: familyId,
        isCurrent: () => true,
      );
    }
    return state;
  }

  Future<void> cache({String familyId = 'family-a'}) async {
    await local.saveFamily(
      FamilyRecord(
        id: familyId,
        name: 'Synthetic cached family $familyId',
        role: 'member',
      ),
    );
    await local.saveInventory(const [
      MedicineRecord(id: 'cached-medicine', name: _cachedName),
    ]);
  }

  Future<String> draft(SessionIdentityState state) async {
    final api = ApiClient(
      baseUrl: _origin,
      tokenProvider: state.readAccessToken,
      identityState: state,
      client: MockClient((_) async => throw StateError('No seed HTTP')),
    )..refreshIdentityContext = () async => state.owner;
    final repo = ApiPlanRepository(api: api, localStore: local);
    final session = await repo.creations.open();
    final handle = await repo.formDrafts.open(session);
    await repo.formDrafts.save(
      handle,
      const PlanFormDraftSnapshot(
        careProfileId: 'profile-a',
        medicineName: _draftName,
        dosageText: 'Synthetic unfinished dose',
        timeSlots: ['09:00'],
        weekdays: ['mon'],
        specificWeekdays: true,
        startDate: '2026-10-03',
        version: 1,
      ),
    );
    repo.formDrafts.close(handle);
    api.close();
    return PlanFormDrafts.storageKey(session);
  }

  Future<http.Response> send(http.Request request) async {
    requests.add(request);
    if (request.url.path == '/api/v1/auth/device-links') {
      // Avoid starting any poll timer while testing a locked route.
      return _json({
        'error': {
          'code': 'UNAVAILABLE',
          'message': 'Synthetic unavailable link',
        },
      }, 503);
    }
    if (offline) throw http.ClientException('Synthetic offline');
    if (familyMissing) {
      return _json({
        'error': {
          'code': 'FAMILY_NOT_FOUND',
          'message': 'Synthetic removed family',
        },
      }, 404);
    }
    switch (request.url.path) {
      case '/api/v1/auth/logout':
        return _json({});
      case '/api/v1/auth/me':
        return _json({
          'user': {'id': 'user-a', 'hasFamily': true},
          'family': family,
        });
      case '/api/v1/families/current':
        return _json({'family': family});
      case '/api/v1/medicines':
        return _json({
          'medicines': [
            {
              'id': 'server-medicine',
              'name': 'Synthetic online medicine',
              'batches': [],
            },
          ],
        });
      case '/api/v1/medication-plans/schedule':
        return _json({
          'date': '2026-10-03',
          'entries': [
            if (notificationVisible &&
                request.url.queryParameters['date'] != null)
              {
                'occurrenceId': _occurrence,
                'planId': 'plan-a',
                'time': '09:00',
              },
          ],
        });
      case '/api/v1/medication-plans':
        return _json({'plans': []});
      case '/api/v1/medication-plans/plan-a':
        return _json({
          'canManage': true,
          'plan': {
            'id': 'plan-a',
            'careProfileId': 'profile-a',
            'careProfileName': 'Synthetic care profile',
            'medicineName': _detailName,
            'dosageText': 'Synthetic dose',
            'timeSlots': ['09:00'],
            'weekdays': ['mon'],
            'status': 'active',
            'version': 1,
            'startDate': '2026-10-03',
          },
        });
      case '/api/v1/notification-preferences':
        return _json({
          'preferences': {'channels': [], 'stockReminderTime': '09:00'},
        });
      case '/api/v1/families/settings':
        return _json({
          'settings': {'stocktakeInterval': 'monthly'},
        });
      case '/api/v1/families/restock':
        return _json({'items': []});
      case '/api/v1/families/stocktakes/current':
        return _json({'stocktake': null});
      case '/api/v1/notifications/templates':
        return _json({'templates': []});
      case '/api/v1/care-profiles':
        return _json({
          'careProfiles': [
            {
              'id': 'profile-a',
              'displayName': 'Synthetic profile',
              'canManage': true,
            },
          ],
        });
      default:
        throw StateError(
          'Unexpected synthetic request ${request.method} ${request.url}',
        );
    }
  }
}

Future<void> _pump(WidgetTester tester) async {
  // Error BootGate intentionally keeps a spinner, so pump a bounded transition
  // window instead of waiting for an animation that will never settle.
  for (var i = 0; i < 15; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Future<void> _mount(
  WidgetTester tester,
  _Fixture fixture, {
  String initialLocation = '/',
}) async {
  await tester.binding.setSurfaceSize(const Size(1000, 1800));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final client = MockClient(fixture.send);
  addTearDown(client.close);
  await http.runWithClient(() async {
    await tester.pumpWidget(
      HomeMedicineApp(
        apiBaseUrl: _origin,
        secretStore: fixture.secrets,
        localStore: fixture.local,
        identityStore: fixture.identityStore,
        initialLocation: initialLocation,
      ),
    );
    await _pump(tester);
  }, () => client);
  // Widget-test framework verifies debug flags before ordinary teardown hooks.
  debugDefaultTargetPlatformOverride = null;
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  AndroidFlutterLocalNotificationsPlugin.registerWith();
  late _Notifications notifications;
  setUp(() {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    SharedPreferences.setMockInitialValues({});
    notifications = _Notifications();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, notifications.handle);
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, null);
    debugDefaultTargetPlatformOverride = null;
  });

  for (final delayed in [false, true]) {
    testWidgets(
      '${delayed ? 'slow' : 'immediate'} failed signout remains visible after MyPage disposal and retries explicitly',
      (tester) async {
        final store = _FaultIdentityStore();
        final f = _Fixture(identityStore: store);
        await f.accepted();
        await f.cache();
        await _mount(tester, f);
        final services = tester
            .widget<ProductionShell>(find.byType(ProductionShell))
            .services;
        GoRouter.of(tester.element(find.byType(ProductionShell)))
            .go('/home?tab=my');
        await _pump(tester);
        await tester.ensureVisible(find.text('退出 App 登录'));
        await tester.tap(find.text('退出 App 登录'));
        await _pump(tester);
        store.failSignOut = true;
        if (delayed) store.gate = Completer<void>();
        await tester.tap(find.widgetWithText(FilledButton, '退出登录'));
        await _pump(tester);
        expect(store.writeStarted, true);
        expect(find.byType(DeviceLinkPage), findsOneWidget);
        expect(find.byType(MyPage), findsNothing);
        expect(services.sessionInvalidated.value, true);
        expect(await services.auth!.readAccessToken(), isNull);
        if (delayed) {
          expect((jsonDecode(store.value!) as Map)['state'], 'accepted');
          store.gate!.complete();
          await _pump(tester);
        }
        expect(
          find.byKey(const ValueKey('session-persistence-warning')),
          findsOneWidget,
        );
        expect(find.text('重试本机退出状态'), findsOneWidget);
        expect(services.api!.identityState!.needsPersistenceRetry, true);
        store.failSignOut = false;
        await tester.tap(find.text('重试本机退出状态'));
        await _pump(tester);
        expect((jsonDecode(store.value!) as Map)['state'], 'signedOut');
        expect(services.api!.identityState!.needsPersistenceRetry, false);
        expect(
          find.byKey(const ValueKey('session-persistence-warning')),
          findsNothing,
        );
        expect(find.text('本机退出状态已保存，请重新获取连接码。'), findsOneWidget);
        expect(find.byType(ProductionShell), findsNothing);
        expect(find.byType(DeviceLinkPage), findsOneWidget);
      },
    );
  }

  testWidgets(
    'authoritative family loss outranks restart cache guard routing',
    (tester) async {
      final f = _Fixture();
      await f.accepted();
      await f.cache();
      await _mount(tester, f);
      final shell = tester.widget<ProductionShell>(
        find.byType(ProductionShell),
      );
      final router = GoRouter.of(tester.element(find.byType(ProductionShell)));
      f.familyMissing = true;
      await shell.services.plans!.onChanged!();
      await _pump(tester);
      expect(
        router.routeInformationProvider.value.uri.path,
        '/family-choice',
        reason:
            'familyInvalidated=${shell.services.familyInvalidated.value}; '
            'cacheMatches=${shell.services.offlineCacheMatchesOwner}; '
            'ownerFamily=${shell.services.api!.identityState!.owner?.familyId}',
      );
      expect(find.text('先选择你的家庭'), findsOneWidget);
      expect(find.byType(ProductionShell), findsNothing);
      expect(find.byType(BootGatePage), findsNothing);
    },
  );

  testWidgets(
    'valid accepted restart restores online through production BootGate',
    (tester) async {
      final f = _Fixture();
      final accepted = await f.accepted();
      await f.cache();
      await _mount(tester, f);
      expect(find.byType(ProductionShell), findsOneWidget);
      expect(find.byType(BootGatePage), findsNothing);
      expect(find.byType(DeviceLinkPage), findsNothing);
      expect(find.text('Synthetic online medicine'), findsOneWidget);
      final services = tester
          .widget<ProductionShell>(find.byType(ProductionShell))
          .services;
      expect(services.api!.identityState!.generation, accepted.generation);
      expect(services.api!.identityState!.owner!.userId, 'user-a');
      expect(f.requests.first.url.path, '/api/v1/auth/me');
      expect(f.requests.every((r) => r.method == 'GET'), true);
      expect(notifications.calls.where((c) => c == 'zonedSchedule'), isEmpty);
    },
  );

  testWidgets(
    'valid offline boot permits explicit owned ordinary draft restore and local edit',
    (tester) async {
      final f = _Fixture();
      final accepted = await f.accepted();
      await f.cache();
      final key = await f.draft(accepted);
      f.offline = true;
      await _mount(tester, f);
      expect(find.byType(ProductionShell), findsOneWidget);
      expect(find.text(_cachedName), findsOneWidget);
      final shell = tester.element(find.byType(ProductionShell));
      GoRouter.of(shell).push('/plans/new');
      await _pump(tester);
      expect(find.byType(PlanFormPage), findsOneWidget);
      expect(find.text('恢复草稿'), findsOneWidget);
      expect(find.text(_draftName), findsNothing);
      await tester.tap(find.text('恢复草稿'));
      await _pump(tester);
      expect(find.text(_draftName), findsOneWidget);
      expect(
        tester.widget<TextField>(find.byType(TextField).first).enabled,
        true,
      );
      await tester.enterText(
        find.byType(TextField).first,
        'Synthetic offline revised draft',
      );
      await _pump(tester);
      expect(f.local.drafts[key], contains('Synthetic offline revised draft'));
      expect(
        tester.widget<PrimaryButton>(find.byType(PrimaryButton)).onPressed,
        isNull,
      );
      f.offline = false;
      await _pump(tester);
      expect(
        tester.widget<PrimaryButton>(find.byType(PrimaryButton)).onPressed,
        isNull,
      );
      expect(f.requests.every((r) => r.method == 'GET'), true);
    },
  );

  for (final mode in [
    'missing-owner',
    'wrong-family',
    'familyless',
    'corrupt-envelope',
    'wrong-origin',
  ]) {
    testWidgets(
      '$mode restart cannot enter offline home or reveal cached family data',
      (tester) async {
        final f = _Fixture();
        await f.accepted(
          owner: mode != 'missing-owner',
          familyId: mode == 'familyless' ? null : 'family-a',
        );
        await f.cache(
          familyId: mode == 'wrong-family' ? 'family-b' : 'family-a',
        );
        if (mode == 'corrupt-envelope') {
          f.secrets.values[SessionIdentityState.accessTokenKey] = '{malformed';
        }
        if (mode == 'wrong-origin') {
          final record = jsonDecode(f.identityStore.value!) as Map;
          record['origin'] = 'https://other.example';
          f.identityStore.value = jsonEncode(record);
        }
        f.offline = true;
        await _mount(tester, f);
        expect(find.byType(ProductionShell), findsNothing);
        expect(find.text(_cachedName), findsNothing);
        expect(find.byType(PlanDetailPage), findsNothing);
        expect(
          f.requests.where((r) => r.url.path == '/api/v1/medicines'),
          isEmpty,
        );
      },
    );
  }

  for (final location in ['/home', '/plans/new', '/plan/plan-a']) {
    testWidgets(
      'signedout initialLocation $location cannot bypass production gate',
      (tester) async {
        final f = _Fixture();
        final state = await f.accepted();
        await f.cache();
        await state.persistSignOut(state.beginSignOut());
        await _mount(tester, f, initialLocation: location);
        expect(find.byType(DeviceLinkPage), findsOneWidget);
        expect(find.byType(ProductionShell), findsNothing);
        expect(find.byType(PlanFormPage), findsNothing);
        expect(find.byType(PlanDetailPage), findsNothing);
        expect(find.text(_cachedName), findsNothing);
        expect(
          f.requests.every((r) => r.url.path == '/api/v1/auth/device-links'),
          true,
        );
      },
    );
  }

  testWidgets(
    'cold synthetic notification uses fresh authorization then opens current detail',
    (tester) async {
      final f = _Fixture();
      await f.accepted();
      await f.cache();
      notifications.launch = true;
      await _mount(tester, f);
      expect(notifications.launchReads, 1);
      expect(find.byType(PlanDetailPage), findsOneWidget);
      expect(find.text(_detailName), findsOneWidget);
      expect(
        f.requests.any(
          (r) =>
              r.url.path == '/api/v1/medication-plans/schedule' &&
              r.url.queryParameters['date'] == '2026-10-03',
        ),
        true,
      );
      expect(
        f.requests.where(
          (r) => r.url.path == '/api/v1/medication-plans/plan-a',
        ),
        hasLength(2),
      );
      expect(f.requests.every((r) => r.method == 'GET'), true);
      expect(notifications.calls.where((c) => c == 'zonedSchedule'), isEmpty);
    },
  );

  for (final mode in ['signedout', 'corrupt']) {
    testWidgets('$mode cold notification cannot open old protected detail', (
      tester,
    ) async {
      final f = _Fixture();
      final state = await f.accepted();
      await f.cache();
      if (mode == 'signedout') {
        await state.persistSignOut(state.beginSignOut());
      } else {
        f.secrets.values[SessionIdentityState.accessTokenKey] = '{malformed';
      }
      notifications.launch = true;
      await _mount(tester, f, initialLocation: '/plan/plan-a');
      expect(find.byType(DeviceLinkPage), findsOneWidget);
      expect(find.byType(PlanDetailPage), findsNothing);
      expect(find.text(_detailName), findsNothing);
      expect(find.text(_cachedName), findsNothing);
      expect(
        f.requests.where((r) => r.url.path.contains('medication-plans')),
        isEmpty,
      );
    });
  }

  testWidgets(
    'mismatched family cache cannot bypass offline BootGate through initial home',
    (tester) async {
      final f = _Fixture();
      await f.accepted();
      await f.cache(familyId: 'family-b');
      f.offline = true;
      await _mount(tester, f, initialLocation: '/home');
      expect(find.byType(ProductionShell), findsNothing);
      expect(find.text(_cachedName), findsNothing);
    },
  );
  testWidgets(
    'production repeated Add opens one entry and allows another after return',
    (tester) async {
      final f = _Fixture();
      await f.accepted();
      await f.cache();
      await _mount(tester, f, initialLocation: '/home');
      final add = find.widgetWithText(FloatingActionButton, '录入');
      await tester.tap(add);
      await tester.tap(add);
      await _pump(tester);
      expect(
        find.byType(MedicineEntryApiPage, skipOffstage: false),
        findsOneWidget,
      );
      final first = tester.state(find.byType(MedicineEntryApiPage));
      await tester.tap(find.byType(BackButton));
      await _pump(tester);
      expect(
        find.byType(MedicineEntryApiPage, skipOffstage: false),
        findsNothing,
      );
      await tester.tap(add);
      await _pump(tester);
      expect(
        find.byType(MedicineEntryApiPage, skipOffstage: false),
        findsOneWidget,
      );
      expect(
        identical(first, tester.state(find.byType(MedicineEntryApiPage))),
        isFalse,
      );
    },
  );

  testWidgets(
    'two independently opened production entries preserve concurrent drafts',
    (tester) async {
      final f = _Fixture();
      await f.accepted();
      await f.cache();
      await _mount(tester, f, initialLocation: '/home');
      await tester.tap(find.widgetWithText(FloatingActionButton, '录入'));
      await _pump(tester);
      // Exercise separate live routes despite the cabinet's repeated-tap guard.
      GoRouter.of(tester.element(find.byType(MedicineEntryApiPage)))
          .push('/medicine/new');
      await _pump(tester);
      final pages = find.byType(MedicineEntryApiPage, skipOffstage: false);
      expect(pages, findsNWidgets(2));
      final widgets = tester.widgetList<MedicineEntryApiPage>(pages).toList();
      expect(identical(widgets[0].localStore, widgets[1].localStore), isTrue);
      final states = tester.stateList(pages).toList();
      final first = (states[0] as dynamic).draftQueue as MedicineDraftQueue;
      final second = (states[1] as dynamic).draftQueue as MedicineDraftQueue;
      expect(identical(first, second), isFalse);
      await Future.wait([
        first.save('synthetic-a', {'name': 'synthetic-first'}),
        second.save('synthetic-b', {'name': 'synthetic-second'}),
      ]);
      expect((await first.list()).map((entry) => entry['id']).toSet(), {
        'synthetic-a',
        'synthetic-b',
      });
    },
  );
}
