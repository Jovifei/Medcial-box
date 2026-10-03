import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_plan_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/plan_creation_operations.dart';
import 'package:home_medicine_flutter/models/plan_models.dart';

const draft = MedicationPlanDraft(
  careProfileId: 'profile-a',
  medicineName: 'Original medicine',
  dosageText: 'Original dose',
  timeSlots: ['09:00'],
  weekdays: ['mon'],
  startDate: '2026-10-03',
  medicineId: 'medicine-a',
);
http.Response response(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status);

class TestStore extends MemoryInventoryLocalStore {
  bool failRead = false;
  bool failSave = false;
  bool failDelete = false;
  bool failMarkerDelete = false;
  Completer<void>? saveEntered;
  Completer<void>? saveGate;
  Completer<void>? readEntered;
  Completer<void>? readGate;
  @override
  Future<String?> readDraft(String key) async {
    readEntered?.complete();
    readEntered = null;
    await readGate?.future;
    if (failRead) throw StateError('synthetic read failure');
    return super.readDraft(key);
  }

  @override
  Future<void> saveDraft(String key, String value) async {
    saveEntered?.complete();
    saveEntered = null;
    await saveGate?.future;
    if (failSave) throw StateError('synthetic save failure');
    return super.saveDraft(key, value);
  }

  @override
  Future<void> deletePlanCreationMarker(String scope) async {
    if (failMarkerDelete) throw StateError('synthetic marker cleanup failure');
    return super.deletePlanCreationMarker(scope);
  }

  @override
  Future<void> deleteDraft(String key) async {
    if (failDelete) throw StateError('synthetic delete failure');
    return super.deleteDraft(key);
  }
}

class Harness {
  Harness({
    LocalAppStore? store,
    Future<String?> Function()? tokenProvider,
    String baseUrl = 'https://synthetic.invalid',
  }) {
    local = store ?? TestStore();
    api = ApiClient(
      baseUrl: baseUrl,
      tokenProvider: tokenProvider ?? () async => 'synthetic',
      client: MockClient((r) async {
        if (r.url.path == '/api/v1/auth/me') {
          return response({
            'user': {'id': user, 'hasFamily': true},
            'family': {'id': family},
          });
        }
        if (r.method == 'GET' && r.url.path == '/api/v1/medication-plans') {
          return planListResponse ?? response({'plans': []});
        }
        if (r.url.path == '/api/v1/care-profiles') {
          return response({
            'careProfiles': [
              {
                'id': 'profile-a',
                'displayName': 'Synthetic person',
                'canManage': true,
              },
            ],
          });
        }
        if (r.method == 'POST') {
          posts.add(jsonDecode(r.body) as Map<String, dynamic>);
          return onPost?.call(r) ??
              response({
                'planId': 'plan-a',
                'careProfileId': 'profile-a',
                'status': 'active',
                'version': 1,
              }, 201);
        }
        throw StateError('Unexpected ${r.method} ${r.url}');
      }),
    );
    repo = ApiPlanRepository(api: api, localStore: local);
  }
  late LocalAppStore local;
  late ApiClient api;
  late ApiPlanRepository repo;
  http.Response? planListResponse;
  String user = 'user-a';
  String family = 'family-a';
  final posts = <Map<String, dynamic>>[];
  Future<http.Response> Function(http.Request)? onPost;
}

void main() {
  test('persist immutable original payload and key before dispatch, retry only explicitly', () async {
    final store = TestStore();
    final h = Harness(store: store);
    final slots = ['09:00'];
    final original = MedicationPlanDraft(
      careProfileId: 'profile-a',
      medicineName: 'Original medicine',
      dosageText: 'Original dose',
      timeSlots: slots,
      weekdays: [],
      startDate: '2026-10-03',
    );
    h.onPost = (_) async {
      expect(store.drafts.length, 1);
      final record = jsonDecode(store.drafts.values.single) as Map;
      expect(record['key'], h.posts.last['idempotencyKey']);
      expect(
        jsonDecode(record['payload'] as String),
        {...h.posts.last}..remove('idempotencyKey'),
      );
      throw http.ClientException('synthetic response lost');
    };
    final session = await h.repo.creations.open();
    await expectLater(
      h.repo.createPlan(original, session: session),
      throwsA(isA<ApiNetworkException>()),
    );
    slots.add('12:00');
    await expectLater(
      h.repo.createPlan(draft, session: session),
      throwsA(isA<PlanCreationException>()),
    );
    expect(h.posts.length, 1);
    final fresh = Harness(store: store);
    final restored = await fresh.repo.creations.open();
    expect(fresh.posts, isEmpty);
    expect(fresh.repo.creations.pending(restored)!.draft.timeSlots, ['09:00']);
    await fresh.repo.retryPlanCreation(restored);
    expect(fresh.posts.single, h.posts.single);
    expect(store.drafts, isEmpty);
  });
  test('initial storage failure sends nothing and explicit retry retains original key', () async {
    final store = TestStore()..failSave = true;
    final h = Harness(store: store);
    final session = await h.repo.creations.open();
    await expectLater(
      h.repo.createPlan(draft, session: session),
      throwsStateError,
    );
    expect(h.posts, isEmpty);
    final key = h.repo.creations.pending(session)!.key;
    store.failSave = false;
    await h.repo.retryPlanCreation(session);
    expect(h.posts.single['idempotencyKey'], key);
  });
  test('unreadable persisted state blocks a new operation', () async {
    final h = Harness(store: TestStore()..failRead = true);
    await expectLater(h.repo.createPlan(draft), throwsStateError);
    expect(h.posts, isEmpty);
  });
  test(
    'corrupt persisted state fails closed instead of silently changing key',
    () async {
      final store = TestStore();
      final h = Harness(store: store);
      final session = await h.repo.creations.open();
      store.drafts[PlanCreationOperations.storageKey(session)] = '{broken';
      final restarted = Harness(store: store);
      await expectLater(
        restarted.repo.createPlan(draft),
        throwsA(isA<PlanCreationException>()),
      );
      expect(restarted.posts, isEmpty);
    },
  );
  test('concurrent submits cannot dispatch a second creation', () async {
    final h = Harness();
    final gate = Completer<http.Response>();
    final entered = Completer<void>();
    h.onPost = (_) {
      entered.complete();
      return gate.future;
    };
    final session = await h.repo.creations.open();
    final running = h.repo.createPlan(draft, session: session);
    await entered.future;
    await expectLater(
      h.repo.createPlan(draft, session: session),
      throwsA(isA<PlanCreationException>()),
    );
    await expectLater(
      h.repo.retryPlanCreation(session),
      throwsA(isA<PlanCreationException>()),
    );
    expect(h.posts.length, 1);
    gate.complete(
      response({
        'planId': 'plan-a',
        'careProfileId': 'profile-a',
        'status': 'active',
        'version': 1,
      }, 201),
    );
    await running;
  });
  test('session/family invalidation during storage drains and removes late private write', () async {
    final store = TestStore();
    final local = IdentityLocalStore(store);
    final h = Harness(store: local);
    final session = await h.repo.creations.open();
    final entered = Completer<void>();
    store.saveEntered = entered;
    store.saveGate = Completer<void>();
    final running = h.repo.createPlan(draft, session: session);
    final failure = expectLater(running, throwsA(isA<PlanCreationException>()));
    await entered.future;
    h.api.invalidateIdentity();
    final cleared = local.clearFamilyData();
    store.saveGate!.complete();
    await failure;
    await cleared;
    expect(h.posts, isEmpty);
    expect(store.drafts, isEmpty);
  });
  test('page cancellation during save prevents HTTP dispatch', () async {
    final store = TestStore();
    final h = Harness(store: store);
    final session = await h.repo.creations.open();
    final entered = Completer<void>();
    store.saveEntered = entered;
    store.saveGate = Completer<void>();
    var current = true;
    final running = h.repo.createPlan(
      draft,
      session: session,
      isCurrent: () => current,
    );
    final failure = expectLater(running, throwsA(isA<PlanCreationException>()));
    await entered.future;
    current = false;
    store.saveGate!.complete();
    await failure;
    expect(h.posts, isEmpty);
    expect(store.drafts.length, 1);
  });
  test(
    'page cancellation during final async token read prevents dispatch',
    () async {
      Completer<String?>? gate;
      final entered = Completer<void>();
      final h = Harness(
        tokenProvider: () {
          if (gate != null) {
            entered.complete();
            return gate.future;
          }
          return Future.value('synthetic');
        },
      );
      final session = await h.repo.creations.open();
      var current = true;
      gate = Completer<String?>();
      final running = h.repo.createPlan(
        draft,
        session: session,
        isCurrent: () => current,
      );
      final failure = expectLater(running, throwsA(isA<ApiException>()));
      await entered.future;
      current = false;
      gate.complete('synthetic');
      await failure;
      expect(h.posts, isEmpty);
    },
  );
  test('identity changes during pending read cannot expose or dispatch old payload', () async {
    final store = TestStore();
    final h = Harness(store: store);
    final entered = Completer<void>();
    store.readEntered = entered;
    store.readGate = Completer<void>();
    final running = h.repo.creations.open();
    final failure = expectLater(running, throwsA(isA<PlanCreationException>()));
    await entered.future;
    h.api.invalidateIdentity();
    store.readGate!.complete();
    await failure;
    expect(h.posts, isEmpty);
  });
  test(
    'user/family/API scoped recovery never restores another identity intent',
    () async {
      final store = TestStore();
      final h = Harness(store: store);
      h.onPost = (_) async => throw http.ClientException('lost');
      await expectLater(
        h.repo.createPlan(draft),
        throwsA(isA<ApiNetworkException>()),
      );
      for (final other in [
        Harness(store: store)..user = 'user-b',
        Harness(store: store)..family = 'family-b',
        Harness(store: store, baseUrl: 'https://another.invalid'),
      ]) {
        final session = await other.repo.creations.open();
        expect(other.repo.creations.pending(session), isNull);
        expect(other.posts, isEmpty);
      }
      expect(store.drafts.length, 1);
    },
  );
  test('ACK cleanup failure remains success and restart retry recovers the same key', () async {
    final store = TestStore()..failDelete = true;
    final h = Harness(store: store);
    var ack = 0;
    h.repo.onMutationAcknowledged = (_) async {
      ack++;
      throw StateError('native cleanup failed');
    };
    final receipt = await h.repo.createPlan(draft);
    expect(receipt.planId, 'plan-a');
    expect(ack, 1);
    expect(store.drafts.length, 1);
    final restart = Harness(store: store);
    final session = await restart.repo.creations.open();
    expect(restart.posts, isEmpty);
    store.failDelete = false;
    await restart.repo.retryPlanCreation(session);
    expect(restart.posts.single, h.posts.single);
    expect(store.drafts, isEmpty);
  });
  test(
    'malformed ACK is unresolved and explicit replay preserves key',
    () async {
      final h = Harness();
      h.onPost = (_) async => response({'planId': 'plan-a'}, 201);
      final session = await h.repo.creations.open();
      await expectLater(
        h.repo.createPlan(draft, session: session),
        throwsA(isA<PlanCreationException>()),
      );
      h.onPost = null;
      await h.repo.retryPlanCreation(session);
      expect(h.posts[0], h.posts[1]);
    },
  );
  test('definite first rejection releases key but later rejection never erases uncertainty', () async {
    final h = Harness();
    h.onPost = (_) async => response({
      'error': {'code': 'VALIDATION_ERROR'},
    }, 400);
    final session = await h.repo.creations.open();
    await expectLater(
      h.repo.createPlan(draft, session: session),
      throwsA(isA<ApiException>()),
    );
    expect(h.repo.creations.pending(session), isNull);
    h.onPost = (_) async => throw http.ClientException('lost');
    await expectLater(
      h.repo.createPlan(draft, session: session),
      throwsA(isA<ApiNetworkException>()),
    );
    final uncertainKey = h.repo.creations.pending(session)!.key;
    expect(uncertainKey, isNot(h.posts.first['idempotencyKey']));
    h.onPost = (_) async => response({
      'error': {'code': 'FORBIDDEN'},
    }, 403);
    await expectLater(
      h.repo.retryPlanCreation(session),
      throwsA(isA<ApiException>()),
    );
    expect(h.repo.creations.pending(session)!.key, uncertainKey);
  });
  test('late response after identity change does not acknowledge new session or clear its storage', () async {
    final h = Harness();
    final gate = Completer<http.Response>();
    final entered = Completer<void>();
    h.onPost = (_) {
      entered.complete();
      return gate.future;
    };
    var ack = 0;
    h.repo.onMutationAcknowledged = (_) async {
      ack++;
    };
    final running = h.repo.createPlan(draft);
    final failure = expectLater(running, throwsA(isA<ApiException>()));
    await entered.future;
    h.api.invalidateIdentity();
    gate.complete(
      response({
        'planId': 'plan-a',
        'careProfileId': 'profile-a',
        'status': 'active',
        'version': 1,
      }, 201),
    );
    await failure;
    expect(ack, 0);
  });
  test('privacy cleanup retains only a scoped opaque tombstone and prevents fresh create after login', () async {
    final store = TestStore();
    final h = Harness(store: store);
    h.onPost = (_) async => throw http.ClientException('lost');
    await expectLater(
      h.repo.createPlan(draft),
      throwsA(isA<ApiNetworkException>()),
    );
    final original = h.posts.single['idempotencyKey'];
    h.api.invalidateIdentity();
    await store.clearFamilyData();
    expect(store.drafts, isEmpty);
    expect(store.planCreationMarkers.values.single, original);
    final next = Harness(store: store);
    final session = await next.repo.creations.open();
    expect(next.repo.creations.needsRecovery(session), true);
    expect(next.repo.creations.pending(session), isNull);
    await expectLater(
      next.repo.createPlan(draft, session: session),
      throwsA(isA<PlanCreationException>()),
    );
    expect(next.posts, isEmpty);
    final inspection = await next.repo.creations.inspectRecovery(session);
    expect(store.planCreationMarkers, isNotEmpty);
    expect(next.posts, isEmpty);
    await next.repo.creations.abandonAfterInspection(inspection);
    expect(store.planCreationMarkers, isEmpty);
    expect(next.posts, isEmpty);
    await next.repo.createPlan(draft, session: session);
    expect(next.posts.single['idempotencyKey'], isNot(original));
  });
  test(
    'failed/malformed list and stale identity cannot retire orphan marker',
    () async {
      final store = TestStore();
      final h = Harness(store: store);
      h.onPost = (_) async => throw http.ClientException('lost');
      await expectLater(
        h.repo.createPlan(draft),
        throwsA(isA<ApiNetworkException>()),
      );
      h.api.invalidateIdentity();
      await store.clearFamilyData();
      final session = await h.repo.creations.open();
      h.planListResponse = response({
        'error': {'code': 'OFFLINE'},
      }, 503);
      await expectLater(
        h.repo.creations.inspectRecovery(session),
        throwsA(isA<ApiException>()),
      );
      h.planListResponse = response({});
      await expectLater(
        h.repo.creations.inspectRecovery(session),
        throwsA(isA<PlanCreationException>()),
      );
      h.planListResponse = null;
      final inspection = await h.repo.creations.inspectRecovery(session);
      h.api.invalidateIdentity();
      await expectLater(
        h.repo.creations.abandonAfterInspection(inspection),
        throwsA(isA<PlanCreationException>()),
      );
      expect(store.planCreationMarkers, isNotEmpty);
    },
  );
  test('same-scope old local request in flight blocks tombstone retirement after identity cleanup', () async {
    final store = TestStore();
    final h = Harness(store: store);
    final entered = Completer<void>();
    final gate = Completer<http.Response>();
    h.onPost = (_) {
      entered.complete();
      return gate.future;
    };
    final running = h.repo.createPlan(draft);
    final failure = expectLater(running, throwsA(isA<ApiException>()));
    await entered.future;
    h.api.invalidateIdentity();
    await store.clearFamilyData();
    final session = await h.repo.creations.open();
    await expectLater(
      h.repo.creations.inspectRecovery(session),
      throwsA(isA<PlanCreationException>()),
    );
    expect(store.planCreationMarkers, isNotEmpty);
    gate.complete(
      response({
        'planId': 'plan-a',
        'careProfileId': 'profile-a',
        'status': 'active',
        'version': 1,
      }, 201),
    );
    await failure;
  });
  test(
    'either ACK cleanup step failing retains original key across restart',
    () async {
      for (final markerFailure in [true, false]) {
        final store = TestStore()
          ..failMarkerDelete = markerFailure
          ..failDelete = !markerFailure;
        final h = Harness(store: store);
        await h.repo.createPlan(draft);
        final next = Harness(store: store);
        final session = await next.repo.creations.open();
        expect(
          next.repo.creations.pending(session)!.key,
          h.posts.single['idempotencyKey'],
        );
        store.failDelete = false;
        store.failMarkerDelete = false;
        await next.repo.retryPlanCreation(session);
        expect(next.posts.single, h.posts.single);
        expect(store.drafts, isEmpty);
        expect(store.planCreationMarkers, isEmpty);
      }
    },
  );
  test('ACK returns before stalled passive refresh and still invokes mutation cleanup first', () async {
    final h = Harness();
    final gate = Completer<void>();
    var ack = 0;
    var refresh = 0;
    h.repo.onMutationAcknowledged = (_) async {
      ack++;
    };
    h.repo.onChanged = () async {
      refresh++;
      await gate.future;
    };
    final receipt = await h.repo.createPlan(draft);
    await Future<void>.delayed(Duration.zero);
    expect(receipt.planId, 'plan-a');
    expect(ack, 1);
    expect(refresh, 1);
    gate.complete();
  });
}
