import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_plan_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/plan_creation_operations.dart';
import 'package:home_medicine_flutter/data/plan_form_drafts.dart';
import 'package:home_medicine_flutter/models/plan_models.dart';

PlanFormDraftSnapshot snapshot([String name = '  Unfinished medicine  ']) =>
    PlanFormDraftSnapshot(
      careProfileId: 'profile-a',
      medicineId: 'medicine-a',
      medicineName: name,
      dosageText: '  unfinished dose ',
      timeSlots: const ['09:00', '19:00'],
      weekdays: const [],
      specificWeekdays: true,
      startDate: '2026-10-03',
      endDate: null,
      version: 3,
    );
const submitted = MedicationPlanDraft(
  careProfileId: 'profile-a',
  medicineId: 'medicine-a',
  medicineName: 'Submitted medicine',
  dosageText: 'Submitted dose',
  timeSlots: ['09:00'],
  weekdays: ['mon'],
  startDate: '2026-10-03',
);
http.Response response(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status);
http.Response creationAck() => response({
  'planId': 'created-a',
  'careProfileId': 'profile-a',
  'status': 'active',
  'version': 1,
}, 201);

class FaultStore extends MemoryInventoryLocalStore {
  bool failFormRead = false;
  bool failFormWrite = false;
  bool failFormDelete = false;
  bool failOperationDelete = false;
  bool failOperationWrite = false;
  bool writeThenFail = false;
  Completer<void>? writeEntered;
  Completer<void>? writeGate;
  Completer<void>? readEntered;
  Completer<void>? readGate;
  final deletes = <String>[];
  bool isForm(String key) => key.startsWith('plan-form.');
  @override
  Future<String?> readDraft(String key) async {
    if (isForm(key)) {
      readEntered?.complete();
      readEntered = null;
      await readGate?.future;
      if (failFormRead) throw StateError('synthetic form read failure');
    }
    return super.readDraft(key);
  }

  @override
  Future<void> saveDraft(String key, String json) async {
    if (isForm(key)) {
      writeEntered?.complete();
      writeEntered = null;
      await writeGate?.future;
      if (failFormWrite) {
        if (writeThenFail) await super.saveDraft(key, json);
        throw StateError('synthetic form write failure');
      }
    } else if (failOperationWrite) {
      throw StateError('synthetic original write failure');
    }
    await super.saveDraft(key, json);
  }

  @override
  Future<void> deleteDraft(String key) async {
    deletes.add(key);
    if (isForm(key) ? failFormDelete : failOperationDelete) {
      throw StateError('synthetic selective delete failure');
    }
    await super.deleteDraft(key);
  }

  @override
  Future<void> deletePlanCreationMarker(String scope) async {
    deletes.add('marker:$scope');
    await super.deletePlanCreationMarker(scope);
  }
}

class Fixture {
  Fixture({
    LocalAppStore? store,
    String baseUrl = 'https://synthetic.invalid',
    Future<String?> Function()? tokenProvider,
  }) {
    local = store ?? FaultStore();
    api = ApiClient(
      baseUrl: baseUrl,
      tokenProvider: tokenProvider ?? () async => 'never-persist-this-token',
      client: MockClient((request) async {
        if (request.url.path == '/api/v1/auth/me') {
          return response({
            'user': {'id': user, 'hasFamily': true},
            'family': {'id': family},
          });
        }
        if (request.method == 'POST') {
          posts.add(jsonDecode(request.body) as Map<String, dynamic>);
          return await onPost?.call(request) ?? creationAck();
        }
        if (request.method == 'PUT') {
          puts.add(jsonDecode(request.body) as Map<String, dynamic>);
          return await onPut?.call(request) ??
              response({
                'planId': request.url.pathSegments.last,
                'version': (puts.last['version'] as int) + 1,
              });
        }
        throw StateError('Unexpected ${request.method} ${request.url}');
      }),
    );
    repo = ApiPlanRepository(api: api, localStore: local);
  }
  late LocalAppStore local;
  late ApiClient api;
  late ApiPlanRepository repo;
  String user = 'user-a';
  String family = 'family-a';
  final posts = <Map<String, dynamic>>[];
  final puts = <Map<String, dynamic>>[];
  Future<http.Response> Function(http.Request)? onPost;
  Future<http.Response> Function(http.Request)? onPut;
  Future<PlanFormDraftHandle> open({String? planId}) async =>
      repo.formDrafts.open(
        await repo.creations.open(loadPending: planId == null),
        planId: planId,
      );
}

void main() {
  test(
    'medicine binding edit intent roundtrips without promoting legacy drafts',
    () async {
      final store = FaultStore();
      final f = Fixture(store: store);
      final handle = await f.open(planId: 'edit-a');
      final changed = snapshot().toJson()..['medicineBindingChanged'] = true;
      await f.repo.formDrafts.save(
        handle,
        PlanFormDraftSnapshot.fromJson(changed),
      );
      final restored = await f.open(planId: 'edit-a');
      expect(restored.saved!.medicineBindingChanged, true);
      expect(restored.saved!.medicineId, 'medicine-a');
      final key = PlanFormDrafts.storageKey(handle.session, planId: 'edit-a');
      final record = jsonDecode(store.drafts[key]!) as Map<String, dynamic>;
      (record['values'] as Map).remove('medicineBindingChanged');
      store.drafts[key] = jsonEncode(record);
      final legacy = await f.open(planId: 'edit-a');
      expect(legacy.saved!.medicineBindingChanged, false);
      expect(legacy.saved!.medicineId, 'medicine-a');
      expect(snapshot().medicineBindingChanged, false);
      (record['values'] as Map)['medicineBindingChanged'] = 'yes';
      store.drafts[key] = jsonEncode(record);
      expect(
        (await f.open(planId: 'edit-a')).error,
        isA<PlanFormDraftException>(),
      );
      expect(f.puts, isEmpty);
      expect(f.posts, isEmpty);
    },
  );

  test('unrelated corrupt creation state does not prevent opening and saving an edit', () async {
    final store = FaultStore();
    final f = Fixture(store: store);
    final session = await f.repo.creations.open(loadPending: false);
    store.drafts[PlanCreationOperations.storageKey(session)] =
        '{broken original';
    final edit = await f.open(planId: 'edit-a');
    await f.repo.formDrafts.save(edit, snapshot());
    await f.repo.updatePlan(
      'edit-a',
      draft: submitted,
      version: 3,
      formDraft: edit,
    );
    expect(f.puts, hasLength(1));
    expect(store.drafts.values.single, '{broken original');
    await expectLater(f.open(), throwsA(isA<PlanCreationException>()));
    expect(f.posts, isEmpty);
  });

  test('associated intent uses fail-closed schema and rejects edit-reference corruption', () async {
    final store = FaultStore();
    final f = Fixture(store: store);
    final handle = await f.open();
    await f.repo.formDrafts.save(handle, snapshot());
    f.onPost = (_) async => throw http.ClientException('lost');
    await expectLater(
      f.repo.createPlan(submitted, session: handle.session, formDraft: handle),
      throwsA(isA<ApiNetworkException>()),
    );
    final key = PlanCreationOperations.storageKey(handle.session);
    final record = jsonDecode(store.drafts[key]!) as Map<String, dynamic>;
    expect(record['version'], 2);
    final edit = await f.open(planId: 'edit-a');
    await f.repo.formDrafts.save(edit, snapshot('edit input'));
    final editRecord = jsonDecode(
      store.drafts[PlanFormDrafts.storageKey(edit.session, planId: 'edit-a')]!,
    ) as Map;
    record['formDraft'] = editRecord['reference'];
    store.drafts[key] = jsonEncode(record);
    final restart = Fixture(store: store);
    await expectLater(restart.open(), throwsA(isA<PlanCreationException>()));
    expect(
      (await restart.open(planId: 'edit-a')).saved!.medicineName,
      'edit input',
    );
    expect(restart.posts, isEmpty);
  });

  test(
    'existing real dates outside picker range remain ordinary editable input',
    () async {
      final f = Fixture();
      final handle = await f.open(planId: 'historical');
      final values = snapshot().toJson()
        ..['startDate'] = '1999-12-31'
        ..['endDate'] = '2100-12-31';
      await f.repo.formDrafts.save(
        handle,
        PlanFormDraftSnapshot.fromJson(values),
      );
      final reopened = await f.open(planId: 'historical');
      expect(reopened.saved!.startDate, '1999-12-31');
      expect(reopened.saved!.endDate, '2100-12-31');
      f.repo.formDrafts.close(reopened);
      await Future<void>.delayed(Duration.zero);
      f.api.invalidateIdentity();
      f.repo.formDrafts.resetForIdentity();
      expect(reopened.saved, isNull);
    },
  );

  test('ordinary ACK read failure retains the keyed original until cleanup recovers', () async {
    final store = FaultStore();
    final f = Fixture(store: store);
    final handle = await f.open();
    await f.repo.formDrafts.save(handle, snapshot());
    f.onPost = (_) async {
      store.failFormRead = true;
      return creationAck();
    };
    await f.repo.createPlan(
      submitted,
      session: handle.session,
      formDraft: handle,
    );
    expect(store.drafts, hasLength(2));
    expect(store.planCreationMarkers, hasLength(1));
    final restart = Fixture(store: store);
    final pending = await restart.open();
    expect(pending.frozen, true);
    expect(pending.error, isNull);
    store.failFormRead = false;
    await restart.repo.retryPlanCreation(pending.session);
    expect(restart.posts.single, f.posts.single);
    expect(store.drafts, isEmpty);
  });

  test(
    'failed explicit discard is recoverable and never hides the draft',
    () async {
      final store = FaultStore();
      final f = Fixture(store: store);
      final initial = await f.open();
      await f.repo.formDrafts.save(initial, snapshot());
      final handle = await f.open();
      store.failFormDelete = true;
      await expectLater(
        f.repo.formDrafts.discard(handle),
        throwsA(isA<PlanFormDraftException>()),
      );
      expect(handle.needsDecision, true);
      expect(handle.saved, isNotNull);
      expect(handle.error, isNotNull);
      store.failFormDelete = false;
      await f.repo.formDrafts.discard(handle);
      expect(handle.needsDecision, false);
      expect(handle.saved, isNull);
      expect(store.drafts, isEmpty);
    },
  );

  test(
    'edit unrecognizable ACK preserves input and requires reconciliation',
    () async {
      final store = FaultStore();
      final f = Fixture(store: store);
      final handle = await f.open(planId: 'edit-a');
      await f.repo.formDrafts.save(handle, snapshot());
      f.onPut = (_) async => response({'planId': 'wrong-plan', 'version': 4});
      await expectLater(
        f.repo.updatePlan(
          'edit-a',
          draft: submitted,
          version: 3,
          formDraft: handle,
        ),
        throwsA(isA<PlanFormDraftException>()),
      );
      expect(handle.frozen, false);
      expect(handle.saved, isNotNull);
      expect(store.drafts, hasLength(1));
      expect(f.puts, hasLength(1));
      expect(f.posts, isEmpty);
    },
  );

  test('late original ACK after family cleanup cannot erase replacement identity draft', () async {
    final backing = FaultStore();
    final store = IdentityLocalStore(backing);
    final f = Fixture(store: store);
    final handle = await f.open();
    await f.repo.formDrafts.save(handle, snapshot());
    final entered = Completer<void>();
    final gate = Completer<http.Response>();
    f.onPost = (_) {
      entered.complete();
      return gate.future;
    };
    final pending = f.repo.createPlan(
      submitted,
      session: handle.session,
      formDraft: handle,
    );
    final failure = expectLater(pending, throwsA(isA<ApiException>()));
    await entered.future;
    f.api.invalidateIdentity();
    f.repo.formDrafts.resetForIdentity();
    await store.clearFamilyData();
    expect(handle.saved, isNull);
    f.family = 'replacement-family';
    final replacement = await f.open();
    await f.repo.formDrafts.save(replacement, snapshot('replacement'));
    gate.complete(creationAck());
    await failure;
    expect((await f.open()).saved!.medicineName, 'replacement');
    expect(backing.planCreationMarkers, hasLength(1));
  });

  test(
    'semantic corruption is recoverable instead of changing schedule meaning',
    () async {
      for (final invalidFields in <Map<String, Object?>>[
        {
          'timeSlots': ['24:00'],
        },
        {
          'timeSlots': ['9:00'],
        },
        {
          'timeSlots': ['09:00', '09:00'],
        },
        {
          'timeSlots': [
            '01:00',
            '02:00',
            '03:00',
            '04:00',
            '05:00',
            '06:00',
            '07:00',
          ],
        },
        {
          'weekdays': ['monday'],
        },
        {
          'weekdays': ['mon', 'mon'],
        },
        {'startDate': '0000-01-01'},
        {'startDate': '2026-02-30'},
        {'endDate': '2026-13-01'},
        {'startDate': '99999-01-01'},
        {'version': 0},
      ]) {
        final store = FaultStore();
        final f = Fixture(store: store);
        final handle = await f.open();
        await f.repo.formDrafts.save(handle, snapshot());
        final key = PlanFormDrafts.storageKey(handle.session);
        final raw = jsonDecode(store.drafts[key]!) as Map<String, dynamic>;
        (raw['values'] as Map).addAll(invalidFields);
        store.drafts[key] = jsonEncode(raw);
        final reopened = await f.open();
        expect(
          reopened.error,
          isA<PlanFormDraftException>(),
          reason: '$invalidFields',
        );
        expect(reopened.saved, isNull);
        expect(reopened.needsDecision, true);
        await f.repo.formDrafts.discard(reopened);
        expect(store.drafts, isEmpty);
        expect(f.posts, isEmpty);
      }
    },
  );

  test('mutable input lists are copied when save is accepted', () async {
    final f = Fixture();
    final handle = await f.open();
    final values = snapshot().toJson();
    final mutableSlots = <String>['09:00'];
    final input = PlanFormDraftSnapshot(
      careProfileId: '',
      medicineName: '',
      dosageText: '',
      timeSlots: mutableSlots,
      weekdays: const [],
      specificWeekdays: false,
      startDate: '',
      version: 1,
    );
    final save = f.repo.formDrafts.save(handle, input);
    mutableSlots.add('12:00');
    await save;
    expect((await f.open()).saved!.timeSlots, ['09:00']);
    expect(values['timeSlots'], ['09:00', '19:00']);
  });

  test(
    'ordinary incomplete input round trips with explicit restore and no token',
    () async {
      final store = FaultStore();
      final f = Fixture(store: store);
      final handle = await f.open();
      await f.repo.formDrafts.save(handle, snapshot());
      f.repo.formDrafts.close(handle);
      final restart = Fixture(store: store);
      final restored = await restart.open();
      expect(restored.needsDecision, true);
      expect(restored.saved!.medicineName, snapshot().medicineName);
      expect(restored.saved!.specificWeekdays, true);
      expect(restored.saved!.weekdays, isEmpty);
      expect(restored.saved!.version, 3);
      await expectLater(
        restart.repo.formDrafts.save(restored, snapshot('replacement')),
        throwsA(isA<PlanFormDraftException>()),
      );
      final result = await restart.repo.formDrafts.restore(restored);
      expect(result.medicineId, 'medicine-a');
      expect(restored.needsDecision, false);
      expect(
        store.drafts.values.single,
        isNot(contains('never-persist-this-token')),
      );
      expect(f.posts, isEmpty);
      expect(restart.posts, isEmpty);
    },
  );

  test(
    'API, authenticated user, family, new and edit plan IDs isolate drafts',
    () async {
      final store = FaultStore();
      final f = Fixture(store: store);
      await f.repo.formDrafts.save(await f.open(), snapshot());
      await f.repo.formDrafts.save(
        await f.open(planId: 'p1'),
        snapshot('Edit p1'),
      );
      for (final other in [
        Fixture(store: store)..user = 'user-b',
        Fixture(store: store)..family = 'family-b',
        Fixture(store: store, baseUrl: 'https://second.invalid'),
      ]) {
        expect((await other.open()).saved, isNull);
      }
      expect((await f.open(planId: 'p2')).saved, isNull);
      expect((await f.open(planId: 'p1')).saved!.medicineName, 'Edit p1');
      expect((await f.open()).saved!.medicineName, snapshot().medicineName);
    },
  );

  test('malformed and unreadable ordinary state is explicit recoverable, never submitted', () async {
    for (final readFailure in [false, true]) {
      final store = FaultStore()..failFormRead = readFailure;
      final f = Fixture(store: store);
      final session = await f.repo.creations.open();
      final key = PlanFormDrafts.storageKey(session);
      store.drafts[key] = '{broken';
      final handle = await f.repo.formDrafts.open(session);
      expect(handle.error, isA<PlanFormDraftException>());
      expect(handle.needsDecision, true);
      await expectLater(
        f.repo.createPlan(submitted, session: session, formDraft: handle),
        throwsA(isA<PlanFormDraftException>()),
      );
      expect(f.posts, isEmpty);
      await f.repo.formDrafts.discard(handle);
      expect(handle.error, isNull);
      expect(handle.needsDecision, false);
      expect(store.drafts, isEmpty);
      store.failFormRead = false;
      await f.repo.formDrafts.save(handle, snapshot('recovered'));
    }
  });

  test(
    'partial write failure blocks creation until explicit successful save',
    () async {
      final store = FaultStore()
        ..failFormWrite = true
        ..writeThenFail = true;
      final f = Fixture(store: store);
      final handle = await f.open();
      await expectLater(
        f.repo.formDrafts.save(handle, snapshot()),
        throwsA(isA<PlanFormDraftException>()),
      );
      expect(handle.error, isNotNull);
      await expectLater(
        f.repo.createPlan(
          submitted,
          session: handle.session,
          formDraft: handle,
        ),
        throwsA(isA<PlanFormDraftException>()),
      );
      expect(f.posts, isEmpty);
      expect(store.planCreationMarkers, isEmpty);
      store.failFormWrite = false;
      await f.repo.formDrafts.save(handle, snapshot('recovered'));
      await f.repo.createPlan(
        submitted,
        session: handle.session,
        formDraft: handle,
      );
      expect(f.posts, hasLength(1));
      expect(store.drafts, isEmpty);
    },
  );

  test('accepted queued saves survive immediate close and preserve latest revision', () async {
    final store = FaultStore();
    final f = Fixture(store: store);
    final handle = await f.open();
    store.writeGate = Completer<void>();
    store.writeEntered = Completer<void>();
    final entered = store.writeEntered!.future;
    final first = f.repo.formDrafts.save(handle, snapshot('first'));
    await entered;
    final last = f.repo.formDrafts.save(handle, snapshot('last accepted'));
    f.repo.formDrafts.close(handle);
    expect(f.repo.formDrafts.isCurrent(handle), false);
    final reopened = f.open();
    store.writeGate!.complete();
    await Future.wait([first, last]);
    expect((await reopened).saved!.medicineName, 'last accepted');
  });

  test('explicit discard cancels queued input and waits before deleting in-flight write', () async {
    final store = FaultStore();
    final f = Fixture(store: store);
    final handle = await f.open();
    store.writeGate = Completer<void>();
    store.writeEntered = Completer<void>();
    final entered = store.writeEntered!.future;
    final first = f.repo.formDrafts.save(handle, snapshot('first'));
    await entered;
    final queued = f.repo.formDrafts.save(handle, snapshot('stale queued'));
    final discarded = f.repo.formDrafts.discard(handle);
    store.writeGate!.complete();
    await Future.wait([first, queued, discarded]);
    expect(store.drafts, isEmpty);
    expect((await f.open()).saved, isNull);
  });

  test('replacing page owner prevents stale save discard and submit', () async {
    final f = Fixture();
    final old = await f.open();
    await f.repo.formDrafts.save(old, snapshot('old'));
    final newer = await f.open();
    await f.repo.formDrafts.restore(newer);
    await f.repo.formDrafts.save(newer, snapshot('new owner'));
    expect(f.repo.formDrafts.isCurrent(old), false);
    await expectLater(
      f.repo.formDrafts.save(old, snapshot('late')),
      throwsA(isA<PlanFormDraftException>()),
    );
    await expectLater(
      f.repo.formDrafts.discard(old),
      throwsA(isA<PlanFormDraftException>()),
    );
    await expectLater(
      f.repo.createPlan(submitted, session: old.session, formDraft: old),
      throwsA(isA<PlanFormDraftException>()),
    );
    expect(f.posts, isEmpty);
    expect((await f.open()).saved!.medicineName, 'new owner');
  });

  test(
    'freeze drains accepted saves before POST and blocks new input',
    () async {
      final store = FaultStore();
      final f = Fixture(store: store);
      final handle = await f.open();
      store.writeGate = Completer<void>();
      store.writeEntered = Completer<void>();
      final entered = store.writeEntered!.future;
      final first = f.repo.formDrafts.save(handle, snapshot('first'));
      await entered;
      final last = f.repo.formDrafts.save(handle, snapshot('final accepted'));
      final submit = f.repo.createPlan(
        submitted,
        session: handle.session,
        formDraft: handle,
      );
      await Future<void>.delayed(Duration.zero);
      expect(handle.frozen, true);
      expect(f.posts, isEmpty);
      await expectLater(
        f.repo.formDrafts.save(handle, snapshot('too late')),
        throwsA(isA<PlanFormDraftException>()),
      );
      f.onPost = (_) async {
        final saved = jsonDecode(
          store.drafts[PlanFormDrafts.storageKey(handle.session)]!,
        ) as Map;
        expect((saved['values'] as Map)['medicineName'], 'final accepted');
        return creationAck();
      };
      store.writeGate!.complete();
      await Future.wait([first, last, submit]);
      expect(handle.frozen, true);
      expect(store.drafts, isEmpty);
      expect(store.deletes[0], startsWith('plan-form.'));
      expect(store.deletes[1], startsWith('marker:'));
      expect(store.deletes[2], startsWith('plan-creation.'));
    },
  );

  test('selective ordinary ACK deletion failure retains original key across restart', () async {
    final store = FaultStore();
    final f = Fixture(store: store);
    final handle = await f.open();
    await f.repo.formDrafts.save(handle, snapshot());
    store.failFormDelete = true;
    final ack = await f.repo.createPlan(
      submitted,
      session: handle.session,
      formDraft: handle,
    );
    expect(ack.planId, 'created-a');
    expect(store.drafts, hasLength(2));
    expect(store.planCreationMarkers, hasLength(1));
    expect(store.deletes.every((key) => key.startsWith('plan-form.')), true);
    final restart = Fixture(store: store);
    final restored = await restart.open();
    expect(restored.frozen, true);
    expect(restored.saved, isNull);
    expect(
      restart.repo.creations.pending(restored.session)!.key,
      f.posts.single['idempotencyKey'],
    );
    await expectLater(
      restart.repo.createPlan(
        submitted,
        session: restored.session,
        formDraft: restored,
      ),
      throwsA(isA<PlanCreationException>()),
    );
    expect(restart.posts, isEmpty);
    store.failFormDelete = false;
    await restart.repo.retryPlanCreation(restored.session);
    expect(restart.posts.single, f.posts.single);
    expect(store.drafts, isEmpty);
    expect(store.planCreationMarkers, isEmpty);
  });

  test('original deletion interrupted after ordinary cleanup still replays same operation', () async {
    final store = FaultStore();
    final f = Fixture(store: store);
    final handle = await f.open();
    await f.repo.formDrafts.save(handle, snapshot());
    store.failOperationDelete = true;
    await f.repo.createPlan(
      submitted,
      session: handle.session,
      formDraft: handle,
    );
    expect(store.drafts.keys.single, startsWith('plan-creation.'));
    final restart = Fixture(store: store);
    final restored = await restart.open();
    expect(restored.frozen, true);
    store.failOperationDelete = false;
    await restart.repo.retryPlanCreation(restored.session);
    expect(restart.posts.single, f.posts.single);
    expect(store.drafts, isEmpty);
  });

  test('failed original persistence makes no POST and freezes ordinary input for same-key retry', () async {
    final store = FaultStore();
    final f = Fixture(store: store);
    final handle = await f.open();
    await f.repo.formDrafts.save(handle, snapshot());
    store.failOperationWrite = true;
    await expectLater(
      f.repo.createPlan(submitted, session: handle.session, formDraft: handle),
      throwsStateError,
    );
    expect(f.posts, isEmpty);
    final key = f.repo.creations.pending(handle.session)!.key;
    expect(handle.frozen, true);
    store.failOperationWrite = false;
    await f.repo.retryPlanCreation(handle.session);
    expect(f.posts.single['idempotencyKey'], key);
    expect(store.drafts, isEmpty);
  });

  test('pending original bypasses failed ordinary read and new viewer cannot steal owner', () async {
    final store = FaultStore();
    final f = Fixture(store: store);
    final handle = await f.open();
    await f.repo.formDrafts.save(handle, snapshot());
    final entered = Completer<void>();
    final gate = Completer<http.Response>();
    f.onPost = (_) {
      entered.complete();
      return gate.future;
    };
    final submit = f.repo.createPlan(
      submitted,
      session: handle.session,
      formDraft: handle,
    );
    await entered.future;
    store.failFormRead = true;
    final spectator = await f.open();
    expect(spectator.frozen, true);
    expect(spectator.error, isNull);
    expect(f.repo.formDrafts.isCurrent(handle), true);
    expect(f.repo.formDrafts.isCurrent(spectator), true);
    final edit = await f.open(planId: 'edit-a');
    expect(edit.frozen, false);
    expect(edit.error, isNotNull);
    store.failFormRead = false;
    gate.complete(creationAck());
    expect((await submit).planId, 'created-a');
    expect(store.drafts, isEmpty);
  });

  test(
    'privacy cleanup drains in-flight writes and cancels queued private input',
    () async {
      final backing = FaultStore();
      final store = IdentityLocalStore(backing);
      final f = Fixture(store: store);
      final handle = await f.open();
      backing.writeGate = Completer<void>();
      backing.writeEntered = Completer<void>();
      final entered = backing.writeEntered!.future;
      final first = f.repo.formDrafts.save(handle, snapshot('private first'));
      await entered;
      final queued = f.repo.formDrafts.save(handle, snapshot('private queued'));
      f.api.invalidateIdentity();
      f.repo.formDrafts.resetForIdentity();
      final cleared = store.clearFamilyData();
      backing.writeGate!.complete();
      await Future.wait([first, queued, cleared]);
      expect(backing.drafts, isEmpty);
      expect((await f.open()).saved, isNull);
    },
  );

  test(
    'identity change during restore read never exposes old snapshot',
    () async {
      final store = FaultStore();
      final f = Fixture(store: store);
      final initial = await f.open();
      await f.repo.formDrafts.save(initial, snapshot());
      store.readGate = Completer<void>();
      store.readEntered = Completer<void>();
      final entered = store.readEntered!.future;
      final pending = f.open();
      final failure = expectLater(
        pending,
        throwsA(isA<PlanFormDraftException>()),
      );
      await entered;
      f.api.invalidateIdentity();
      f.repo.formDrafts.resetForIdentity();
      store.readGate!.complete();
      await failure;
    },
  );

  test('late edit ACK only deletes associated revision, preserving newer page input', () async {
    final store = FaultStore();
    final f = Fixture(store: store);
    final old = await f.open(planId: 'plan-a');
    await f.repo.formDrafts.save(old, snapshot('old edit'));
    final entered = Completer<void>();
    final gate = Completer<http.Response>();
    f.onPut = (_) {
      entered.complete();
      return gate.future;
    };
    final update = f.repo.updatePlan(
      'plan-a',
      draft: submitted,
      version: 3,
      formDraft: old,
    );
    await entered.future;
    final newer = await f.open(planId: 'plan-a');
    await f.repo.formDrafts.restore(newer);
    await f.repo.formDrafts.save(newer, snapshot('newer edit'));
    gate.complete(response({'planId': 'plan-a', 'version': 4}));
    await update;
    expect((await f.open(planId: 'plan-a')).saved!.medicineName, 'newer edit');
  });

  test('edit token wait checks page owner before dispatch', () async {
    Completer<String?>? tokenGate;
    final entered = Completer<void>();
    final f = Fixture(
      tokenProvider: () {
        if (tokenGate != null) {
          entered.complete();
          return tokenGate.future;
        }
        return Future.value('synthetic');
      },
    );
    final old = await f.open(planId: 'plan-a');
    await f.repo.formDrafts.save(old, snapshot());
    tokenGate = Completer<String?>();
    final update = f.repo.updatePlan(
      'plan-a',
      draft: submitted,
      version: 3,
      formDraft: old,
    );
    final failure = expectLater(update, throwsA(isA<ApiException>()));
    await entered.future;
    f.repo.formDrafts.close(old);
    tokenGate.complete('synthetic');
    await failure;
    expect(f.puts, isEmpty);
  });

  test('edit ACK survives selective cleanup and stalled refresh without re-dispatch', () async {
    final store = FaultStore();
    final f = Fixture(store: store);
    final handle = await f.open(planId: 'plan-a');
    await f.repo.formDrafts.save(handle, snapshot());
    final refresh = Completer<void>();
    f.repo.onChanged = () => refresh.future;
    store.failFormDelete = true;
    await f.repo.updatePlan(
      'plan-a',
      draft: submitted,
      version: 3,
      formDraft: handle,
    );
    expect(handle.frozen, true);
    expect(f.puts, hasLength(1));
    expect(f.posts, isEmpty);
    refresh.complete();
  });

  test('first definite rejection resumes draft, uncertain rejection retains original', () async {
    final f = Fixture();
    final handle = await f.open();
    await f.repo.formDrafts.save(handle, snapshot());
    f.onPost = (_) async => response({
      'error': {'code': 'VALIDATION_ERROR'},
    }, 400);
    await expectLater(
      f.repo.createPlan(submitted, session: handle.session, formDraft: handle),
      throwsA(isA<ApiException>()),
    );
    expect(handle.frozen, false);
    expect(handle.saved, isNotNull);
    await f.repo.formDrafts.save(handle, snapshot('corrected'));
    f.onPost = (_) async => throw http.ClientException('lost');
    await expectLater(
      f.repo.createPlan(submitted, session: handle.session, formDraft: handle),
      throwsA(isA<ApiNetworkException>()),
    );
    expect(handle.frozen, true);
    f.onPost = (_) async => response({
      'error': {'code': 'FORBIDDEN'},
    }, 403);
    await expectLater(
      f.repo.retryPlanCreation(handle.session),
      throwsA(isA<ApiException>()),
    );
    expect(handle.frozen, true);
    expect(f.repo.creations.pending(handle.session), isNotNull);
  });
}
