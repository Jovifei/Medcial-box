import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:home_medicine_flutter/core/widgets/app_surfaces.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_plan_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/plan_creation_operations.dart';
import 'package:home_medicine_flutter/data/plan_form_drafts.dart';
import 'package:home_medicine_flutter/data/private_atomic_state.dart';
import 'package:home_medicine_flutter/data/session_identity_state.dart';
import 'package:home_medicine_flutter/features/plan/plan_form_page.dart';
import 'package:home_medicine_flutter/models/plan_models.dart';

const _ordinary = PlanFormDraftSnapshot(
  careProfileId: 'profile-a',
  medicineId: 'medicine-a',
  medicineName: 'Owned unfinished medicine',
  dosageText: 'Owned unfinished dose',
  timeSlots: ['09:00'],
  weekdays: ['mon', 'wed'],
  specificWeekdays: true,
  startDate: '2026-10-03',
  version: 3,
);
const _submitted = MedicationPlanDraft(
  careProfileId: 'profile-a',
  medicineName: 'Original frozen medicine',
  dosageText: 'Original frozen dose',
  timeSlots: ['09:00'],
  weekdays: ['mon'],
  startDate: '2026-10-03',
);

http.Response _response(Object value, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(value)), status);

class _OwnerStores {
  final secrets = MemorySecretStore();
  final persistence = MemoryPrivateAtomicState();

  SessionIdentityState state({
    String origin = 'https://owned.synthetic.invalid',
  }) => SessionIdentityState(
    origin: origin,
    secrets: secrets,
    persistence: persistence,
  );

  Future<SessionIdentityState> accept({
    String? familyId = 'family-a',
    bool owner = true,
    String origin = 'https://owned.synthetic.invalid',
  }) async {
    final current = state(origin: origin);
    await current.initialize();
    await current.acceptToken(current.beginLink(), 'synthetic-token');
    if (owner) {
      await current.recordOwner(
        expectedGeneration: current.generation!,
        userId: 'user-a',
        familyId: familyId,
        isCurrent: () => true,
      );
    }
    return current;
  }

  Future<SessionIdentityState> restart() async {
    final current = state();
    await current.initialize();
    return current;
  }
}

class _Harness {
  _Harness({
    MemoryInventoryLocalStore? store,
    SessionIdentityState? identityState,
  }) {
    local = store ?? MemoryInventoryLocalStore();
    api = ApiClient(
      baseUrl: 'https://owned.synthetic.invalid',
      tokenProvider:
          identityState?.readAccessToken ?? () async => 'synthetic-token',
      identityState: identityState,
      client: MockClient((request) async {
        requests.add('${request.method} ${request.url.path}');
        if (request.method != 'GET') {
          writes.add(request);
          if (loseWriteResponse) {
            throw http.ClientException('synthetic response lost');
          }
          return _response({
            'planId': 'plan-a',
            'careProfileId': 'profile-a',
            'status': 'active',
            'version': request.method == 'POST' ? 1 : 4,
          }, request.method == 'POST' ? 201 : 200);
        }
        if (offline || failPath == request.url.path) {
          throw http.ClientException('synthetic offline');
        }
        switch (request.url.path) {
          case '/api/v1/auth/me':
            return _response({
              'user': {'id': 'user-a', 'hasFamily': true},
              'family': {'id': 'family-a'},
            });
          case '/api/v1/care-profiles':
            return _response({
              'careProfiles': [
                {
                  'id': 'profile-a',
                  'displayName': 'Synthetic person',
                  'canManage': canManage,
                },
              ],
            });
          case '/api/v1/medication-plans/plan-a':
            return _response({
              'canManage': canManage,
              'plan': {
                'id': 'plan-a',
                'careProfileId': careProfileId,
                'medicineId': 'medicine-a',
                'medicineName': 'Current server medicine',
                'dosageText': 'Current server dose',
                'timeSlots': ['09:00'],
                'weekdays': ['mon', 'wed'],
                'startDate': '2026-10-03',
                'status': 'active',
                'version': version,
              },
            });
          case '/api/v1/medication-plans':
            return _response({'plans': []});
          default:
            throw StateError('Unexpected read ${request.url}');
        }
      }),
    );
    if (identityState != null) {
      api.refreshIdentityContext = () async {
        final result = await api.get('/api/v1/auth/me') as Map;
        final generation = identityState.generation;
        if (generation == null) return null;
        await identityState.recordOwner(
          expectedGeneration: generation,
          userId: result['user']['id'] as String,
          familyId: result['family']['id'] as String?,
          isCurrent: () => true,
        );
        return identityState.owner;
      };
    }
    repo = ApiPlanRepository(api: api, localStore: local);
  }

  late final MemoryInventoryLocalStore local;
  late final ApiClient api;
  late final ApiPlanRepository repo;
  final requests = <String>[];
  final writes = <http.Request>[];
  bool offline = false;
  bool canManage = true;
  bool loseWriteResponse = false;
  String careProfileId = 'profile-a';
  int version = 3;
  String? failPath;

  Future<PlanCreationSession> seed({bool edit = false}) async {
    final session = await repo.creations.open(loadPending: !edit);
    final handle = await repo.formDrafts.open(
      session,
      planId: edit ? 'plan-a' : null,
    );
    await repo.formDrafts.save(handle, _ordinary);
    repo.formDrafts.close(handle);
    return session;
  }
}

Future<GoRouter> _mount(
  WidgetTester tester,
  _Harness h, {
  bool edit = false,
}) async {
  await tester.binding.setSurfaceSize(const Size(1000, 1800));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (_, _) => const Scaffold(body: Text('Destination')),
        routes: [
          GoRoute(
            path: 'form',
            builder: (_, _) => PlanFormPage(
              repository: h.repo,
              planId: edit ? 'plan-a' : null,
            ),
          ),
        ],
      ),
    ],
  );
  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  router.push('/form');
  await tester.pumpAndSettle();
  addTearDown(router.dispose);
  return router;
}

TextField _name(WidgetTester tester) =>
    tester.widget<TextField>(find.byType(TextField).first);

Future<void> _restore(WidgetTester tester) async {
  await tester.tap(find.text('恢复草稿'));
  await tester.pumpAndSettle();
}

void main() {
  test(
    'a refresh result from an older accepted generation cannot open a draft',
    () async {
      final owners = _OwnerStores();
      final state = await owners.accept();
      final h = _Harness(identityState: state);
      await h.seed();
      final oldOwner = state.owner!;
      await state.acceptToken(state.beginLink(), 'synthetic-replacement-token');
      await state.recordOwner(
        expectedGeneration: state.generation!,
        userId: 'user-a',
        familyId: 'family-a',
        isCurrent: () => true,
      );
      expect(oldOwner.generation, isNot(state.generation));
      h.api.refreshIdentityContext = () async => oldOwner;
      await expectLater(
        h.repo.creations.open(),
        throwsA(isA<PlanCreationException>()),
      );
      expect(h.writes, isEmpty);
    },
  );

  test('without a refresh hook no offline authority is inferred from an attached owner', () async {
    final owners = _OwnerStores();
    final h = _Harness(identityState: await owners.accept());
    await h.seed();
    h.api.refreshIdentityContext = null;
    h.offline = true;
    await expectLater(
      h.repo.creations.open(),
      throwsA(isA<ApiNetworkException>()),
    );
    expect(h.writes, isEmpty);
  });

  test(
    'new accepted family cannot read a prior familys owned draft offline',
    () async {
      final owners = _OwnerStores();
      final original = _Harness(identityState: await owners.accept());
      final oldSession = await original.seed();
      final replacement = await owners.accept(familyId: 'family-b');
      final restarted = _Harness(
        store: original.local,
        identityState: replacement,
      )..offline = true;
      final session = await restarted.repo.creations.open();
      expect(session.offlineReadOnly, true);
      expect(session.scope, isNot(oldSession.scope));
      final handle = await restarted.repo.formDrafts.open(session);
      expect(handle.saved, isNull);
      expect(
        original.local.drafts.values.single,
        contains('Owned unfinished medicine'),
      );
      expect(restarted.writes, isEmpty);
    },
  );

  for (final edit in [false, true]) {
    testWidgets(
      'fresh generation-bound owner restores ${edit ? 'edit' : 'new'} draft offline without remote replay',
      (tester) async {
        final owners = _OwnerStores();
        final initial = _Harness(identityState: await owners.accept());
        final original = await initial.seed(edit: edit);
        final restoredOwner = await owners.restart();
        final restarted = _Harness(
          store: initial.local,
          identityState: restoredOwner,
        )..offline = true;
        await _mount(tester, restarted, edit: edit);
        expect(restoredOwner.owner!.userId, 'user-a');
        expect(find.text('恢复草稿'), findsOneWidget);
        expect(_name(tester).enabled, false);
        await _restore(tester);
        expect(_name(tester).enabled, true);
        expect(find.text('Owned unfinished medicine'), findsOneWidget);
        await tester.enterText(
          find.byType(TextField).at(1),
          'Restart offline local dose',
        );
        await tester.pumpAndSettle();
        final record =
            initial.local.drafts[PlanFormDrafts.storageKey(
              original,
              planId: edit ? 'plan-a' : null,
            )];
        expect(record, contains('Restart offline local dose'));
        expect(restarted.requests, ['GET /api/v1/auth/me']);
        expect(restarted.writes, isEmpty);
        restarted.offline = false;
        await tester.pumpAndSettle();
        expect(
          tester.widget<PrimaryButton>(find.byType(PrimaryButton)).onPressed,
          isNull,
        );
        expect(restarted.requests, ['GET /api/v1/auth/me']);
      },
    );
  }

  test('verified restart fallback is latched and only a fresh online open can submit', () async {
    final owners = _OwnerStores();
    final initial = _Harness(identityState: await owners.accept());
    final original = await initial.seed();
    final restarted = _Harness(
      store: initial.local,
      identityState: await owners.restart(),
    )..offline = true;
    final offline = await restarted.repo.creations.open();
    expect(offline.scope, original.scope);
    expect(offline.offlineReadOnly, true);
    final form = await restarted.repo.formDrafts.open(offline);
    expect(
      (await restarted.repo.formDrafts.restore(form)).medicineName,
      'Owned unfinished medicine',
    );
    restarted.offline = false;
    await expectLater(
      restarted.repo.createPlan(_submitted, session: offline),
      throwsA(isA<PlanCreationException>()),
    );
    expect(restarted.writes, isEmpty);
    restarted.repo.formDrafts.close(form);
    final online = await restarted.repo.creations.open();
    expect(online.offlineReadOnly, false);
    expect(offline.offlineReadOnly, true);
    expect(online.scope, offline.scope);
    expect(restarted.writes, isEmpty);
  });

  test('server errors and invalid identity results cannot use retained owner fallback', () async {
    final owners = _OwnerStores();
    final h = _Harness(identityState: await owners.accept());
    await h.seed();
    for (final failure in <Object>[
      const ApiException(
        statusCode: 401,
        code: 'UNAUTHORIZED',
        message: 'synthetic',
      ),
      const ApiException(
        statusCode: 403,
        code: 'NO_FAMILY',
        message: 'synthetic',
      ),
      const ApiException(statusCode: 500, code: 'SERVER', message: 'synthetic'),
      const FormatException('synthetic invalid identity'),
    ]) {
      h.api.refreshIdentityContext = () async => throw failure;
      await expectLater(h.repo.creations.open(), throwsA(same(failure)));
    }
    h.api.refreshIdentityContext = () async => null;
    await expectLater(
      h.repo.creations.open(),
      throwsA(isA<PlanCreationException>()),
    );
    expect(h.writes, isEmpty);
  });

  test('offline fallback rejects missing, uninitialized, wrong-origin and familyless owners', () async {
    final missing = _OwnerStores();
    final uninitialized = _OwnerStores();
    await uninitialized.accept();
    final wrongOrigin = _OwnerStores();
    final noFamily = _OwnerStores();
    final candidates = <SessionIdentityState>[
      await missing.accept(owner: false),
      uninitialized.state(),
      await wrongOrigin.accept(origin: 'https://other.synthetic.invalid'),
      await noFamily.accept(familyId: null),
    ];
    for (final owner in candidates) {
      final h = _Harness(identityState: owner);
      h.api.refreshIdentityContext = () async =>
          throw const ApiNetworkException('synthetic offline');
      await expectLater(
        h.repo.creations.open(),
        throwsA(
          anyOf(isA<ApiNetworkException>(), isA<PlanCreationException>()),
        ),
      );
      expect(h.requests, isEmpty);
      expect(h.local.drafts, isEmpty);
    }
  });

  test('secure envelope generation mismatch never unlocks a retained ordinary draft', () async {
    final owners = _OwnerStores();
    final initial = _Harness(identityState: await owners.accept());
    await initial.seed();
    final envelope = jsonDecode(
      owners.secrets.values[SessionIdentityState.accessTokenKey]!,
    ) as Map;
    envelope['generation'] = '0' * 48;
    owners.secrets.values[SessionIdentityState.accessTokenKey] = jsonEncode(
      envelope,
    );
    final owner = await owners.restart();
    expect(owner.owner, isNull);
    final restarted = _Harness(store: initial.local, identityState: owner);
    restarted.api.refreshIdentityContext = () async =>
        throw const ApiNetworkException('synthetic offline');
    await expectLater(
      restarted.repo.creations.open(),
      throwsA(isA<ApiNetworkException>()),
    );
    expect(
      initial.local.drafts.values.single,
      contains('Owned unfinished medicine'),
    );
    expect(restarted.requests, isEmpty);
  });

  test('identity invalidation during offline fallback cannot return an old owner session', () async {
    final owners = _OwnerStores();
    final owner = await owners.accept();
    final h = _Harness(identityState: owner);
    await h.seed();
    final gate = Completer<VerifiedOwnerContext?>();
    h.api.refreshIdentityContext = () => gate.future;
    final opened = h.repo.creations.open();
    final rejected = expectLater(opened, throwsA(isA<PlanCreationException>()));
    await Future<void>.delayed(Duration.zero);
    owner.beginSignOut();
    h.api.invalidateIdentity();
    gate.completeError(
      const ApiNetworkException('synthetic delayed network failure'),
    );
    await rejected;
    expect(h.writes, isEmpty);
  });

  test(
    'ordinary offline handle stops local saves after identity invalidation',
    () async {
      final owners = _OwnerStores();
      final owner = await owners.accept();
      final h = _Harness(identityState: owner);
      await h.seed();
      h.offline = true;
      final session = await h.repo.creations.open();
      final handle = await h.repo.formDrafts.open(session);
      await h.repo.formDrafts.restore(handle);
      final before = Map.of(h.local.drafts);
      owner.beginSignOut();
      h.api.invalidateIdentity();
      await expectLater(
        h.repo.formDrafts.save(handle, _ordinary),
        throwsA(isA<PlanFormDraftException>()),
      );
      expect(handle.saved, isNull);
      expect(h.local.drafts, before);
      expect(h.writes, isEmpty);
    },
  );

  test('read-only session cannot submit, retry or inspect after connectivity returns', () async {
    final h = _Harness();
    final session = (await h.seed()).asOfflineReadOnly();
    final before = List.of(h.requests);
    await expectLater(
      h.repo.createPlan(_submitted, session: session),
      throwsA(isA<PlanCreationException>()),
    );
    await expectLater(
      h.repo.retryPlanCreation(session),
      throwsA(isA<PlanCreationException>()),
    );
    await expectLater(
      h.repo.creations.inspectRecovery(session),
      throwsA(isA<PlanCreationException>()),
    );
    expect(h.requests, before);
    expect(h.writes, isEmpty);
    expect(h.local.drafts.values.single, contains('Owned unfinished medicine'));
  });

  test(
    'read-only edit handle cannot dispatch through the repository',
    () async {
      final h = _Harness();
      final session = (await h.seed(edit: true)).asOfflineReadOnly();
      final handle = await h.repo.formDrafts.open(session, planId: 'plan-a');
      await h.repo.formDrafts.restore(handle);
      await expectLater(
        h.repo.updatePlan(
          'plan-a',
          draft: _submitted,
          version: 3,
          formDraft: handle,
        ),
        throwsA(isA<PlanFormDraftException>()),
      );
      expect(h.writes, isEmpty);
      expect(handle.frozen, false);
      expect(
        h.local.drafts.values.single,
        contains('Owned unfinished medicine'),
      );
    },
  );

  for (final edit in [false, true]) {
    testWidgets(
      'profile outage permits only explicit owned ${edit ? 'edit' : 'new'} draft restore',
      (tester) async {
        final h = _Harness();
        final session = await h.seed(edit: edit);
        h.failPath = '/api/v1/care-profiles';
        await _mount(tester, h, edit: edit);
        expect(find.text('恢复草稿'), findsOneWidget);
        expect(_name(tester).enabled, false);
        expect(find.text('Owned unfinished medicine'), findsNothing);
        await _restore(tester);
        expect(_name(tester).enabled, true);
        expect(find.text('Owned unfinished medicine'), findsOneWidget);
        expect(
          tester.widget<PrimaryButton>(find.byType(PrimaryButton)).onPressed,
          isNull,
        );
        expect(
          tester
              .widget<TextButton>(find.widgetWithText(TextButton, '从药箱选择'))
              .onPressed,
          isNull,
        );
        expect(find.text('前往照护对象'), findsNothing);
        await tester.enterText(
          find.byType(TextField).first,
          'Offline local edit',
        );
        await tester.pumpAndSettle();
        final key = PlanFormDrafts.storageKey(
          session,
          planId: edit ? 'plan-a' : null,
        );
        expect(h.local.drafts[key], contains('Offline local edit'));
        expect(h.local.drafts[key], contains('profile-a'));
        h.failPath = null;
        await tester.pumpAndSettle();
        expect(
          tester.widget<PrimaryButton>(find.byType(PrimaryButton)).onPressed,
          isNull,
        );
        expect(h.writes, isEmpty);
        await tester.tap(find.text('联网重新读取'));
        await tester.pumpAndSettle();
        expect(find.text('恢复草稿'), findsOneWidget);
        expect(_name(tester).enabled, false);
        await _restore(tester);
        expect(find.text('Offline local edit'), findsOneWidget);
        expect(
          tester.widget<PrimaryButton>(find.byType(PrimaryButton)).onPressed,
          isNotNull,
        );
        expect(h.writes, isEmpty);
      },
    );
  }

  testWidgets(
    'missing current detail still exposes saved edit with preserved version',
    (tester) async {
      final h = _Harness();
      final session = await h.seed(edit: true);
      h.failPath = '/api/v1/medication-plans/plan-a';
      await _mount(tester, h, edit: true);
      await _restore(tester);
      expect(_name(tester).enabled, true);
      await tester.enterText(
        find.byType(TextField).at(1),
        'Offline updated dose',
      );
      await tester.pumpAndSettle();
      final record = jsonDecode(
        h.local.drafts[PlanFormDrafts.storageKey(session, planId: 'plan-a')]!,
      ) as Map;
      expect(record['values']['version'], 3);
      h.failPath = null;
      h.version = 4;
      await tester.tap(find.text('联网重新读取'));
      await tester.pumpAndSettle();
      await _restore(tester);
      expect(find.text('Offline updated dose'), findsOneWidget);
      expect(find.text('核对最新计划'), findsOneWidget);
      expect(
        tester.widget<PrimaryButton>(find.byType(PrimaryButton)).onPressed,
        isNull,
      );
      expect(h.writes, isEmpty);
    },
  );

  testWidgets(
    'online reload never promotes an offline draft to management permission',
    (tester) async {
      final h = _Harness();
      await h.seed(edit: true);
      h.failPath = '/api/v1/care-profiles';
      await _mount(tester, h, edit: true);
      await _restore(tester);
      expect(_name(tester).enabled, true);
      h.failPath = null;
      h.canManage = false;
      await tester.tap(find.text('联网重新读取'));
      await tester.pumpAndSettle();
      await _restore(tester);
      expect(_name(tester).enabled, false);
      expect(
        tester.widget<PrimaryButton>(find.byType(PrimaryButton)).onPressed,
        isNull,
      );
      expect(h.writes, isEmpty);
    },
  );

  testWidgets('without a saved ordinary draft an offline form remains locked', (
    tester,
  ) async {
    final h = _Harness()..failPath = '/api/v1/care-profiles';
    await _mount(tester, h);
    expect(find.text('此表单没有可恢复的本机草稿。'), findsOneWidget);
    expect(find.text('恢复草稿'), findsNothing);
    expect(_name(tester).enabled, false);
    expect(h.local.drafts, isEmpty);
    expect(h.writes, isEmpty);
  });

  testWidgets('pending original still outranks ordinary draft while offline', (
    tester,
  ) async {
    final h = _Harness();
    final session = await h.seed();
    h.loseWriteResponse = true;
    await expectLater(
      h.repo.createPlan(_submitted, session: session),
      throwsA(isA<ApiNetworkException>()),
    );
    h.failPath = '/api/v1/care-profiles';
    h.writes.clear();
    await _mount(tester, h);
    expect(find.text('Original frozen medicine'), findsOneWidget);
    expect(find.text('恢复草稿'), findsNothing);
    expect(_name(tester).enabled, false);
    expect(
      tester.widget<PrimaryButton>(find.byType(PrimaryButton)).onPressed,
      isNull,
    );
    expect(h.writes, isEmpty);
    expect(h.repo.creations.pending(session), isNotNull);
  });

  testWidgets(
    'opaque recovery marker remains frozen during offline restoration',
    (tester) async {
      final h = _Harness();
      final session = await h.seed();
      await h.local.savePlanCreationMarker(
        session.scope,
        'plan-opaque-marker-123456',
      );
      final restarted = _Harness(store: h.local)
        ..failPath = '/api/v1/care-profiles';
      await _mount(tester, restarted);
      expect(find.text('恢复草稿'), findsNothing);
      expect(_name(tester).enabled, false);
      expect(
        tester
            .widget<TextButton>(find.widgetWithText(TextButton, '查看已有计划'))
            .onPressed,
        isNull,
      );
      expect(restarted.writes, isEmpty);
      expect(
        await h.local.readPlanCreationMarker(session.scope),
        'plan-opaque-marker-123456',
      );
    },
  );
}
