import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/app_services.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/private_atomic_state.dart';
import 'package:home_medicine_flutter/data/session_identity_state.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _origin = 'https://medicine.example';
const _tokenKey = SessionIdentityState.accessTokenKey;
const _pollKey = SessionIdentityState.pendingPollTokenKey;
const _a = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const _b = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const _legacyToken =
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

String _fence({
  String generation = _a,
  String origin = _origin,
  String state = 'accepted',
  Object? owner = const {
    'userId': 'synthetic-user-a',
    'familyId': 'synthetic-family-a',
  },
}) => jsonEncode({
  'schema': 1,
  'origin': origin,
  'generation': generation,
  'state': state,
  'owner': ?owner,
});
String _envelope({
  String generation = _a,
  String origin = _origin,
  String token = 'synthetic-token-a',
}) => jsonEncode({
  'schema': 1,
  'origin': origin,
  'generation': generation,
  'token': token,
});

class _StateStore extends MemoryPrivateAtomicState {
  _StateStore({super.value});
  bool failRead = false;
  bool failAllWrites = false;
  int? failWriteNumber;
  bool partialOnFailure = false;
  int writes = 0;
  Future<void> Function(String)? beforeWrite;
  void Function(String)? afterWrite;
  final history = <String>[];
  @override
  Future<String?> read() async {
    if (failRead) throw const FileSystemException('Synthetic read failure');
    return value;
  }

  @override
  Future<void> write(String value) async {
    writes++;
    if (failAllWrites || writes == failWriteNumber) {
      if (partialOnFailure) this.value = value.substring(0, value.length ~/ 2);
      throw const FileSystemException('Synthetic commit failure');
    }
    await beforeWrite?.call(value);
    this.value = value;
    history.add(value);
    afterWrite?.call(value);
  }
}

class _Secrets extends MemorySecretStore {
  bool failRead = false;
  bool failWrite = false;
  bool failDelete = false;
  bool dropAccessWrite = false;
  bool pauseNextAccessRead = false;
  final readEntered = Completer<void>();
  final readRelease = Completer<void>();
  final deleted = <String>[];
  @override
  Future<String?> read(String key) async {
    if (failRead) throw StateError('Synthetic secure read failure');
    final result = values[key];
    if (key == _tokenKey && pauseNextAccessRead) {
      pauseNextAccessRead = false;
      readEntered.complete();
      await readRelease.future;
    }
    return result;
  }

  @override
  Future<void> write(String key, String value) async {
    if (failWrite) throw StateError('Synthetic secure write failure');
    if (key == _tokenKey && dropAccessWrite) return;
    await super.write(key, value);
  }

  @override
  Future<void> delete(String key) async {
    deleted.add(key);
    if (failDelete) throw StateError('Synthetic secure delete failure');
    await super.delete(key);
  }
}

class _FailingClearStore extends MemoryInventoryLocalStore {
  bool failClear = false;
  @override
  Future<void> clearFamilyData() async {
    if (failClear) throw StateError('Synthetic private cleanup failure');
    await super.clearFamilyData();
  }
}

String _scope([String family = 'synthetic-family-a']) =>
    SessionIdentityState.scopeForOwner(
      VerifiedOwnerContext(
        origin: _origin,
        generation: _a,
        userId: 'synthetic-user-a',
        familyId: family,
      ),
    );
String _legacyKey(String scope) =>
    'home_medicine.draft.v1.plan-form.v1.$scope.new';
String _activeKey(String scope) => 'plan-form.v1.$scope.new';
http.Response _legacyFlow(http.Request request) {
  if (request.url.path.endsWith('/auth/device-links')) {
    return _json({
      'code': '123456',
      'pollToken': 'synthetic-poll',
      'expiresAt': '2099-01-01T00:00:00Z',
    });
  }
  if (request.url.path.endsWith('/exchange')) {
    return _json({'state': 'approved', 'token': 'synthetic-reconnected-token'});
  }
  if (request.url.path.endsWith('/auth/logout')) {
    throw http.ClientException('Synthetic offline logout');
  }
  return _json({
    'user': {'id': 'synthetic-user-a', 'hasFamily': true},
    'family': {'id': 'synthetic-family-a', 'name': 'A', 'role': 'member'},
  });
}

Future<AppServices> _legacyServices(
  _StateStore state,
  _Secrets secrets,
  MemoryInventoryLocalStore local,
) => http.runWithClient(
  () => AppServices.create(
    apiBaseUrl: _origin,
    identityStore: state,
    secretStore: secrets,
    localStore: local,
  ),
  () => MockClient((request) async => _legacyFlow(request)),
);

class _PausedClearStore extends MemoryInventoryLocalStore {
  bool pause = false;
  final clearEntered = Completer<void>();
  final clearRelease = Completer<void>();
  @override
  Future<void> clearFamilyData() async {
    if (pause) {
      pause = false;
      clearEntered.complete();
      await clearRelease.future;
    }
    await super.clearFamilyData();
  }
}

SessionIdentityState _state(
  _StateStore store,
  _Secrets secrets, {
  String origin = _origin,
}) =>
    SessionIdentityState(origin: origin, secrets: secrets, persistence: store);
Future<SessionIdentityState> _accepted(
  _StateStore store,
  _Secrets secrets,
) async {
  store.value = _fence();
  secrets.values[_tokenKey] = _envelope();
  final state = _state(store, secrets);
  await state.initialize();
  expect(await state.readAccessToken(), 'synthetic-token-a');
  return state;
}

http.Response _json(Object value, [int status = 200]) => http.Response(
  jsonEncode(value),
  status,
  headers: {'content-type': 'application/json'},
);

void main() {
  test('nonsecret fence refuses credential-bearing or ambiguous API bases', () {
    for (final origin in [
      'https://u:p@medicine.example',
      'https://medicine.example?api_key=synthetic',
      'https://medicine.example#fragment',
    ]) {
      expect(
        () => SessionIdentityState(
          origin: origin,
          secrets: MemorySecretStore(),
          persistence: MemoryPrivateAtomicState(),
        ),
        throwsArgumentError,
      );
    }
  });

  TestWidgetsFlutterBinding.ensureInitialized();
  AndroidFlutterLocalNotificationsPlugin.registerWith();
  const notifications = MethodChannel(
    'dexterous.com/flutter/local_notifications',
  );
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          notifications,
          (call) async => call.method == 'initialize' ? true : null,
        );
  });
  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(notifications, null);
  });

  group('ordinary restart fence', () {
    test(
      'matching envelope restores login and verified offline owner',
      () async {
        final store = _StateStore();
        final secrets = _Secrets();
        await _accepted(store, secrets);
        final restarted = _state(store, secrets);
        expect(restarted.accepted, isFalse);
        expect(restarted.owner, isNull);
        expect(await restarted.readAccessToken(), 'synthetic-token-a');
        expect(restarted.owner!.userId, 'synthetic-user-a');
        expect(restarted.owner!.familyId, 'synthetic-family-a');
        expect(restarted.owner!.generation, _a);
        expect(restarted.owner!.origin, _origin);
      },
    );

    test(
      'legacy raw token without state requires explicit reconnect',
      () async {
        final store = _StateStore();
        final secrets = _Secrets()..values[_tokenKey] = _legacyToken;
        final state = _state(store, secrets);
        expect(await state.readAccessToken(), isNull);
        expect(state.owner, isNull);
        expect(jsonDecode(store.value!)['state'], 'signedOut');
      },
    );

    test('missing owner preserves valid login but never fabricates offline context', () async {
      final store = _StateStore(value: _fence(owner: null));
      final secrets = _Secrets()..values[_tokenKey] = _envelope();
      final state = _state(store, secrets);
      expect(await state.readAccessToken(), 'synthetic-token-a');
      expect(state.owner, isNull);
    });

    final corruptRecords = <String, String>{
      'truncated JSON': '{"schema":1',
      'wrong schema': jsonEncode({'schema': 2}),
      'wrong generation': _fence(generation: _b),
      'wrong API origin': _fence(origin: 'https://other.example'),
      'owner empty user': _fence(owner: {'userId': '', 'familyId': 'family-a'}),
      'owner wrong type': _fence(owner: ['user-a', 'family-a']),
      'owner missing family': _fence(owner: {'userId': 'user-a'}),
      'owner blank family': _fence(
        owner: {'userId': 'user-a', 'familyId': ' '},
      ),
    };
    for (final entry in corruptRecords.entries) {
      test('${entry.key} denies token and offline context', () async {
        final store = _StateStore(value: entry.value);
        final secrets = _Secrets()..values[_tokenKey] = _envelope();
        final state = _state(store, secrets);
        expect(await state.readAccessToken(), isNull);
        expect(state.accepted, isFalse);
        expect(state.owner, isNull);
        expect(state.warning, isNotNull);
      });
    }

    final corruptEnvelopes = <String, String?>{
      'missing': null,
      'legacy raw': 'synthetic-legacy-token',
      'truncated': '{"schema":1',
      'wrong origin': _envelope(origin: 'https://other.example'),
      'wrong generation': _envelope(generation: _b),
      'empty token': _envelope(token: ''),
    };
    for (final entry in corruptEnvelopes.entries) {
      test('${entry.key} secure envelope fails closed', () async {
        final store = _StateStore(value: _fence());
        final secrets = _Secrets();
        if (entry.value != null) secrets.values[_tokenKey] = entry.value!;
        final state = _state(store, secrets);
        expect(await state.readAccessToken(), isNull);
        expect(state.owner, isNull);
        expect(state.warning, isNotNull);
      });
    }

    test('fence read throw denies secure credential', () async {
      final store = _StateStore(value: _fence())..failRead = true;
      final secrets = _Secrets()..values[_tokenKey] = _envelope();
      final state = _state(store, secrets);
      expect(await state.readAccessToken(), isNull);
      expect(state.warning, isNotNull);
    });
    test('secure read throw denies accepted record', () async {
      final store = _StateStore(value: _fence());
      final secrets = _Secrets()..failRead = true;
      final state = _state(store, secrets);
      expect(await state.readAccessToken(), isNull);
      expect(state.warning, isNotNull);
    });
    test(
      'initial missing-state commit failure never exposes legacy token',
      () async {
        final store = _StateStore()..failWriteNumber = 1;
        final secrets = _Secrets()..values[_tokenKey] = 'synthetic-legacy';
        final state = _state(store, secrets);
        expect(await state.readAccessToken(), isNull);
        expect(state.warning, isNotNull);
      },
    );
  });

  group('acceptance crash windows', () {
    test(
      'new secure generation plus old signed-out fence cannot restore',
      () async {
        final store = _StateStore(value: _fence(state: 'signedOut'));
        final secrets = _Secrets()
          ..values[_tokenKey] = _envelope(generation: _b);
        final state = _state(store, secrets);
        expect(await state.readAccessToken(), isNull);
        expect(state.owner, isNull);
      },
    );
    test('new accepted fence plus acknowledged but lost secure write cannot restore', () async {
      final store = _StateStore();
      final secrets = _Secrets();
      final state = await _accepted(store, secrets);
      secrets.dropAccessWrite = true;
      await state.acceptToken(state.beginLink(), 'synthetic-token-b');
      final record = jsonDecode(store.value!) as Map;
      expect(record['state'], 'accepted');
      expect(record['generation'], isNot(_a));
      expect(jsonDecode(secrets.values[_tokenKey]!)['generation'], _a);
      final restarted = _state(store, secrets);
      expect(await restarted.readAccessToken(), isNull);
      expect(restarted.owner, isNull);
      expect(await state.readAccessToken(), isNull);
    });
    test(
      'acceptance commits signed-out fence before replacement secret',
      () async {
        final store = _StateStore();
        final secrets = _Secrets();
        final state = await _accepted(store, secrets);
        final snapshots = <Map<String, String?>>[];
        store.afterWrite = (record) => snapshots.add({
          'record': record,
          'secret': secrets.values[_tokenKey],
        });
        await state.acceptToken(state.beginLink(), 'synthetic-token-b');
        expect(snapshots.length, 2);
        expect(jsonDecode(snapshots[0]['record']!)['state'], 'signedOut');
        expect(jsonDecode(snapshots[0]['secret']!)['generation'], _a);
        final crashed = _state(
          _StateStore(value: snapshots[0]['record']),
          _Secrets()..values[_tokenKey] = snapshots[0]['secret']!,
        );
        expect(await crashed.readAccessToken(), isNull);
        final success = _state(store, secrets);
        expect(await success.readAccessToken(), 'synthetic-token-b');
        expect(
          success.owner,
          isNull,
          reason:
              'The prior user/family binding must not survive a new acceptance',
        );
      },
    );
    test('secure write failure leaves durable signed-out fence', () async {
      final store = _StateStore();
      final secrets = _Secrets();
      final state = await _accepted(store, secrets);
      secrets.failWrite = true;
      await expectLater(
        state.acceptToken(state.beginLink(), 'synthetic-token-b'),
        throwsA(isA<SessionPersistenceException>()),
      );
      expect(await state.readAccessToken(), isNull);
      expect(await _state(store, secrets).readAccessToken(), isNull);
    });
    for (final partial in [false, true]) {
      test(
        'acceptance commit failure partial=$partial remains blocked after restart',
        () async {
          final store = _StateStore();
          final secrets = _Secrets();
          final state = await _accepted(store, secrets);
          store.failWriteNumber = 2;
          store.partialOnFailure = partial;
          await expectLater(
            state.acceptToken(state.beginLink(), 'synthetic-token-b'),
            throwsA(isA<SessionPersistenceException>()),
          );
          expect(await state.readAccessToken(), isNull);
          expect(state.warning, isNotNull);
          expect(await _state(store, secrets).readAccessToken(), isNull);
        },
      );
    }
    test(
      'first fence failure is sealed by an independent successful retry',
      () async {
        final store = _StateStore();
        final secrets = _Secrets();
        final state = await _accepted(store, secrets);
        store.failWriteNumber = 1;
        await expectLater(
          state.acceptToken(state.beginLink(), 'synthetic-token-b'),
          throwsA(isA<SessionPersistenceException>()),
        );
        expect(await state.readAccessToken(), isNull);
        expect(jsonDecode(store.value!)['state'], 'signedOut');
        expect(await _state(store, secrets).readAccessToken(), isNull);
      },
    );
    test('all fence writes failing closes memory and reports unconfirmed durability', () async {
      final store = _StateStore();
      final secrets = _Secrets();
      final state = await _accepted(store, secrets);
      store.failAllWrites = true;
      await expectLater(
        state.acceptToken(state.beginLink(), 'synthetic-token-b'),
        throwsA(isA<SessionPersistenceException>()),
      );
      expect(await state.readAccessToken(), isNull);
      expect(state.warning, contains('重启'));
      expect(jsonDecode(secrets.values[_tokenKey]!)['generation'], _a);
      // Every durable write failed: the old accepted disk state genuinely
      // remains. The warning, rather than a false restart claim, is required.
      expect(
        await _state(store, secrets).readAccessToken(),
        'synthetic-token-a',
      );
    });
  });

  group('logout and stale-operation fences', () {
    test(
      'logout closes synchronously then durable fence survives failed deletes',
      () async {
        final store = _StateStore();
        final secrets = _Secrets();
        final state = await _accepted(store, secrets);
        secrets.values[_pollKey] = 'synthetic-pending';
        secrets.failDelete = true;
        final intent = state.beginSignOut();
        expect(state.accepted, isFalse);
        expect(state.owner, isNull);
        expect(await state.readAccessToken(), isNull);
        await state.persistSignOut(intent);
        await expectLater(
          state.deleteSignedOutSecrets(intent),
          throwsStateError,
        );
        expect(secrets.deleted, containsAll([_tokenKey, _pollKey]));
        expect(await _state(store, secrets).readAccessToken(), isNull);
      },
    );
    test(
      'logout persistence throw is explicit; later retry closes restart gate',
      () async {
        final store = _StateStore();
        final secrets = _Secrets();
        final state = await _accepted(store, secrets);
        store.failWriteNumber = 1;
        final intent = state.beginSignOut();
        await expectLater(
          state.persistSignOut(intent),
          throwsA(isA<SessionPersistenceException>()),
        );
        expect(await state.readAccessToken(), isNull);
        expect(state.warning, isNotNull);
        await state.persistSignOut(intent);
        expect(state.warning, isNull);
        expect(await _state(store, secrets).readAccessToken(), isNull);
      },
    );
    test('partial logout state is denied on recreation', () async {
      final store = _StateStore();
      final secrets = _Secrets();
      final state = await _accepted(store, secrets);
      store.failWriteNumber = 1;
      store.partialOnFailure = true;
      await expectLater(
        state.persistSignOut(state.beginSignOut()),
        throwsA(isA<SessionPersistenceException>()),
      );
      expect(await _state(store, secrets).readAccessToken(), isNull);
    });
    test(
      'secure read completing after logout returns no old credential',
      () async {
        final store = _StateStore();
        final secrets = _Secrets();
        final state = await _accepted(store, secrets);
        secrets.pauseNextAccessRead = true;
        final read = state.readAccessToken();
        await secrets.readEntered.future;
        final intent = state.beginSignOut();
        await state.persistSignOut(intent);
        secrets.readRelease.complete();
        expect(await read, isNull);
        expect(state.owner, isNull);
      },
    );
    test(
      'stale logout retry cannot delete or fence a later explicit login',
      () async {
        final store = _StateStore();
        final secrets = _Secrets();
        final state = await _accepted(store, secrets);
        final outgoing = state.beginSignOut();
        await state.persistSignOut(outgoing);
        await state.acceptToken(state.beginLink(), 'synthetic-token-b');
        final generation = state.generation;
        await state.persistSignOut(outgoing);
        await state.deleteSignedOutSecrets(outgoing);
        expect(state.generation, generation);
        expect(await state.readAccessToken(), 'synthetic-token-b');
        expect(
          await _state(store, secrets).readAccessToken(),
          'synthetic-token-b',
        );
      },
    );
    test(
      'late old owner commit cannot replace a newer accepted identity',
      () async {
        final store = _StateStore();
        final secrets = _Secrets();
        final state = await _accepted(store, secrets);
        final oldGeneration = state.generation!;
        await state.acceptToken(state.beginLink(), 'synthetic-token-b');
        await state.recordOwner(
          expectedGeneration: oldGeneration,
          userId: 'old-user',
          familyId: 'old-family',
          isCurrent: () => true,
        );
        expect(state.owner, isNull);
        expect(jsonDecode(store.value!)['owner'], isNull);
      },
    );
    test(
      'owner commit checks current API epoch before any disk update',
      () async {
        final store = _StateStore();
        final secrets = _Secrets();
        final state = await _accepted(store, secrets);
        await state.recordOwner(
          expectedGeneration: state.generation!,
          userId: 'wrong-user',
          familyId: 'wrong-family',
          isCurrent: () => false,
        );
        expect(state.owner!.userId, 'synthetic-user-a');
        expect(store.writes, 0);
      },
    );
    test('family loss clears offline family but retains matching login after restart', () async {
      final store = _StateStore();
      final secrets = _Secrets();
      final state = await _accepted(store, secrets);
      await state.clearFamily();
      expect(await state.readAccessToken(), 'synthetic-token-a');
      expect(state.owner!.familyId, isNull);
      final restarted = _state(store, secrets);
      expect(await restarted.readAccessToken(), 'synthetic-token-a');
      expect(restarted.owner!.userId, 'synthetic-user-a');
      expect(restarted.owner!.familyId, isNull);
    });
    test(
      'family fence write failure closes gate with explicit warning',
      () async {
        final store = _StateStore();
        final secrets = _Secrets();
        final state = await _accepted(store, secrets);
        store.failWriteNumber = 1;
        await expectLater(
          state.clearFamily(),
          throwsA(isA<SessionPersistenceException>()),
        );
        expect(await state.readAccessToken(), isNull);
        expect(state.owner, isNull);
        expect(state.warning, isNotNull);
      },
    );
  });

  group('legacy recovery invalidation', () {
    test(
      'verified logout permanently denies revival of that owner scope',
      () async {
        final store = _StateStore();
        final secrets = _Secrets();
        final state = await _accepted(store, secrets);
        final scope = _scope();
        expect(state.canRestoreLegacyScope(scope), isTrue);
        final intent = state.beginSignOut();
        expect(state.canRestoreLegacyScope(scope), isFalse);
        expect(
          state.canRestoreLegacyScope(_scope('synthetic-family-b')),
          isTrue,
        );
        await state.persistSignOut(intent);
        await state.acceptToken(
          state.beginLink(),
          'synthetic-reconnected-token',
        );
        await state.recordOwner(
          expectedGeneration: state.generation!,
          userId: 'synthetic-user-a',
          familyId: 'synthetic-family-a',
          isCurrent: () => true,
        );
        final restarted = _state(store, secrets);
        expect(
          await restarted.readAccessToken(),
          'synthetic-reconnected-token',
        );
        expect(restarted.canRestoreLegacyScope(scope), isFalse);
      },
    );
    test(
      'family loss blocks old scope through same-family rebind and restart',
      () async {
        final store = _StateStore();
        final secrets = _Secrets();
        final state = await _accepted(store, secrets);
        await state.clearFamily();
        expect(state.canRestoreLegacyScope(_scope()), isFalse);
        await state.recordOwner(
          expectedGeneration: state.generation!,
          userId: 'synthetic-user-a',
          familyId: 'synthetic-family-a',
          isCurrent: () => true,
        );
        final restarted = _state(store, secrets);
        expect(await restarted.readAccessToken(), 'synthetic-token-a');
        expect(restarted.canRestoreLegacyScope(_scope()), isFalse);
      },
    );
    test('explicit logout of unknown legacy ownership blocks every quarantine scope', () async {
      final store = _StateStore();
      final secrets = _Secrets()..values[_tokenKey] = _legacyToken;
      final state = _state(store, secrets);
      await state.initialize();
      expect(state.requiresLegacyQuarantine, isTrue);
      final intent = state.beginSignOut();
      await state.persistSignOut(intent);
      state.finishLegacyQuarantine();
      await state.acceptToken(state.beginLink(), 'synthetic-reconnected-token');
      final restarted = _state(store, secrets);
      expect(await restarted.readAccessToken(), 'synthetic-reconnected-token');
      expect(restarted.canRestoreLegacyScope(_scope()), isFalse);
      expect(
        restarted.canRestoreLegacyScope(_scope('synthetic-family-b')),
        isFalse,
      );
    });
    test(
      'failed logout cleanup leftovers cannot revive after same-user reconnect',
      () async {
        final store = _StateStore(value: _fence());
        final secrets = _Secrets()..values[_tokenKey] = _envelope();
        final local = _FailingClearStore()..failClear = true;
        final scope = _scope();
        local.legacyQuarantine[_legacyKey(scope)] =
            'synthetic-invalidated-draft';
        final services = await _legacyServices(store, secrets, local);
        secrets.failDelete = true;
        expect(await services.auth!.logout(), isNotNull);
        expect(
          local.legacyQuarantine[_legacyKey(scope)],
          'synthetic-invalidated-draft',
        );
        local.failClear = false;
        secrets.failDelete = false;
        // Cleanup recovery changes the epoch; start a fresh intent after it settles.
        await services.api!.waitForIdentityCleanup();
        await services.auth!.startDeviceLink();
        await services.auth!.exchangePendingLink();
        await services.auth!.getCurrentUser();
        expect(local.drafts[_activeKey(scope)], isNull);
        expect(
          local.legacyQuarantine[_legacyKey(scope)],
          'synthetic-invalidated-draft',
        );
        services.api!.close();
        final restarted = await _legacyServices(store, secrets, local);
        await restarted.auth!.getCurrentUser();
        expect(local.drafts[_activeKey(scope)], isNull);
        expect(
          restarted.api!.identityState!.canRestoreLegacyScope(scope),
          isFalse,
        );
        restarted.api!.close();
      },
    );
    test('migration-only matching scope can restore after explicit validated reconnect', () async {
      final store = _StateStore();
      final secrets = _Secrets()..values[_tokenKey] = _legacyToken;
      final local = MemoryInventoryLocalStore();
      final scope = _scope();
      local.drafts[_activeKey(scope)] = 'synthetic-preserved-migration-draft';
      local.drafts['medicine-new'] = 'synthetic-unowned-medicine-draft';
      final services = await _legacyServices(store, secrets, local);
      expect(await services.auth!.readAccessToken(), isNull);
      await services.auth!.startDeviceLink();
      await services.auth!.exchangePendingLink();
      expect(local.drafts[_activeKey(scope)], isNull);
      await services.auth!.getCurrentUser();
      expect(
        local.drafts[_activeKey(scope)],
        'synthetic-preserved-migration-draft',
      );
      expect(local.drafts['medicine-new'], isNull);
      expect(
        local.legacyQuarantine['home_medicine.draft.v1.medicine-new'],
        'synthetic-unowned-medicine-draft',
      );
      services.api!.close();
    });
    test('explicit logout before migration cannot adopt same-user quarantine after reconnect', () async {
      final store = _StateStore();
      final secrets = _Secrets()..values[_tokenKey] = _legacyToken;
      final local = MemoryInventoryLocalStore();
      final scope = _scope();
      local.legacyQuarantine[_legacyKey(scope)] =
          'synthetic-unowned-invalidated-draft';
      final services = await _legacyServices(store, secrets, local);
      await services.auth!.logout();
      await services.auth!.startDeviceLink();
      await services.auth!.exchangePendingLink();
      await services.auth!.getCurrentUser();
      expect(local.drafts[_activeKey(scope)], isNull);
      expect(
        local.legacyQuarantine[_legacyKey(scope)],
        'synthetic-unowned-invalidated-draft',
      );
      services.api!.close();
    });
  });

  test('failed family-loss cleanup cannot revive quarantined draft on same-family recovery', () async {
    final store = _StateStore(value: _fence());
    final secrets = _Secrets()..values[_tokenKey] = _envelope();
    final local = _FailingClearStore()..failClear = true;
    final scope = _scope();
    local.legacyQuarantine[_legacyKey(scope)] =
        'synthetic-family-invalidated-draft';
    var unavailable = true;
    final services = await http.runWithClient(
      () => AppServices.create(
        apiBaseUrl: _origin,
        identityStore: store,
        secretStore: secrets,
        localStore: local,
      ),
      () => MockClient((request) async {
        if (unavailable) {
          return _json({
            'error': {
              'code': 'FAMILY_NOT_FOUND',
              'message': 'Synthetic revoked family',
            },
          }, 404);
        }
        return _legacyFlow(request);
      }),
    );
    await expectLater(services.api!.get('/family-loss'), throwsStateError);
    expect(services.api!.identityState!.canRestoreLegacyScope(scope), isFalse);
    unavailable = false;
    local.failClear = false;
    await services.api!.waitForIdentityCleanup();
    await services.auth!.getCurrentUser();
    expect(await services.auth!.readAccessToken(), 'synthetic-token-a');
    expect(local.drafts[_activeKey(scope)], isNull);
    expect(
      local.legacyQuarantine[_legacyKey(scope)],
      'synthetic-family-invalidated-draft',
    );
    services.api!.close();
    final restarted = await _legacyServices(store, secrets, local);
    await restarted.auth!.getCurrentUser();
    expect(local.drafts[_activeKey(scope)], isNull);
    restarted.api!.close();
  });

  test('logout after migration acceptance but before owner validation cannot revive quarantine', () async {
    final store = _StateStore();
    final secrets = _Secrets()..values[_tokenKey] = _legacyToken;
    final local = MemoryInventoryLocalStore();
    final scope = _scope();
    local.drafts[_activeKey(scope)] = 'synthetic-interrupted-migration-draft';
    final services = await _legacyServices(store, secrets, local);
    await services.auth!.startDeviceLink();
    await services.auth!.exchangePendingLink();
    expect(services.api!.identityState!.owner, isNull);
    expect(
      local.legacyQuarantine[_legacyKey(scope)],
      'synthetic-interrupted-migration-draft',
    );
    await services.auth!.logout();
    services.api!.close();
    final restarted = await _legacyServices(store, secrets, local);
    await restarted.auth!.startDeviceLink();
    await restarted.auth!.exchangePendingLink();
    await restarted.auth!.getCurrentUser();
    expect(
      local.drafts[_activeKey(scope)],
      isNull,
      reason: 'Logout in the accepted-but-unverified window invalidates unknown quarantine ownership',
    );
    expect(
      local.legacyQuarantine[_legacyKey(scope)],
      'synthetic-interrupted-migration-draft',
    );
    restarted.api!.close();
  });

  test('missing fence plus truncated modern envelope cannot become legacy recovery eligibility', () async {
    final store = _StateStore();
    final secrets = _Secrets()
      ..values[_tokenKey] = '{"schema":1,"origin":"https://medicine.example"';
    final state = _state(store, secrets);
    await state.initialize();
    expect(await state.readAccessToken(), isNull);
    expect(
      state.canRestoreLegacyScope(_scope()),
      isFalse,
      reason: 'Malformed modern secure state is not a genuine historical raw session token',
    );
  });

  group('production API/service wiring', () {
    test(
      'AppServices waits for initialization before exposing any token or owner',
      () async {
        final gate = Completer<void>();
        final entered = Completer<void>();
        final store = _StateStore();
        store.beforeWrite = (_) async {
          entered.complete();
          await gate.future;
        };
        final secrets = _Secrets()..values[_tokenKey] = _legacyToken;
        var exposed = false;
        var requests = 0;
        final pending = http
            .runWithClient(
              () => AppServices.create(
                apiBaseUrl: _origin,
                secretStore: secrets,
                identityStore: store,
                localStore: MemoryInventoryLocalStore(),
              ),
              () => MockClient((_) async {
                requests++;
                return _json({});
              }),
            )
            .then((service) {
              exposed = true;
              return service;
            });
        await entered.future;
        expect(exposed, isFalse);
        expect(requests, 0);
        gate.complete();
        final services = await pending;
        expect(await services.auth!.readAccessToken(), isNull);
        await expectLater(
          services.api!.get('/protected'),
          throwsA(isA<ApiException>()),
        );
        expect(requests, 0);
        services.api!.close();
      },
    );
    test('wrong configured API never receives a saved credential', () async {
      var requests = 0;
      final store = _StateStore(value: _fence());
      final secrets = _Secrets()..values[_tokenKey] = _envelope();
      final services = await http.runWithClient(
        () => AppServices.create(
          apiBaseUrl: 'https://other.example',
          secretStore: secrets,
          identityStore: store,
          localStore: MemoryInventoryLocalStore(),
        ),
        () => MockClient((_) async {
          requests++;
          return _json({});
        }),
      );
      await expectLater(
        services.api!.get('/protected'),
        throwsA(isA<ApiException>()),
      );
      expect(await services.auth!.readAccessToken(), isNull);
      expect(services.api!.identityState!.owner, isNull);
      expect(requests, 0);
      services.api!.close();
    });
    test('stale 401 cannot remove a newer accepted envelope even with same token text', () async {
      final store = _StateStore();
      final secrets = _Secrets();
      final state = await _accepted(store, secrets);
      final entered = Completer<void>();
      final release = Completer<http.Response>();
      var unauthorized = 0;
      final api = ApiClient(
        baseUrl: _origin,
        identityState: state,
        tokenProvider: state.readAccessToken,
        client: MockClient((_) {
          entered.complete();
          return release.future;
        }),
      );
      api.onUnauthorized = () async {
        unauthorized++;
        final intent = state.beginSignOut();
        await state.persistSignOut(intent);
        await state.deleteSignedOutSecrets(intent);
      };
      final request = api.get('/protected');
      final expectation = expectLater(request, throwsA(isA<ApiException>()));
      await entered.future;
      api.invalidateIdentity();
      await state.acceptToken(state.beginLink(), 'synthetic-token-a');
      release.complete(
        _json({
          'error': {'code': 'UNAUTHORIZED'},
        }, 401),
      );
      await expectation;
      expect(unauthorized, 0);
      expect(await state.readAccessToken(), 'synthetic-token-a');
      expect(state.generation, isNot(_a));
      api.close();
    });
    test(
      'token read begun before logout cannot transmit old credentials',
      () async {
        final store = _StateStore();
        final secrets = _Secrets();
        final state = await _accepted(store, secrets);
        var requests = 0;
        final api = ApiClient(
          baseUrl: _origin,
          identityState: state,
          tokenProvider: state.readAccessToken,
          client: MockClient((_) async {
            requests++;
            return _json({});
          }),
        );
        secrets.pauseNextAccessRead = true;
        final pending = api.get('/protected');
        final expectation = expectLater(pending, throwsA(isA<ApiException>()));
        await secrets.readEntered.future;
        final intent = state.beginSignOut();
        api.invalidateIdentity();
        await state.persistSignOut(intent);
        secrets.readRelease.complete();
        await expectation;
        expect(requests, 0);
        api.close();
      },
    );
    test('401 closes in-flight success immediately even while durable sign-out is blocked', () async {
      final store = _StateStore(value: _fence());
      final secrets = _Secrets()..values[_tokenKey] = _envelope();
      final fenceEntered = Completer<void>();
      final fenceRelease = Completer<void>();
      store.beforeWrite = (value) async {
        if (jsonDecode(value)['state'] == 'signedOut') {
          fenceEntered.complete();
          await fenceRelease.future;
        }
      };
      final successEntered = Completer<void>();
      final successResponse = Completer<http.Response>();
      final services = await http.runWithClient(
        () => AppServices.create(
          apiBaseUrl: _origin,
          secretStore: secrets,
          identityStore: store,
          localStore: MemoryInventoryLocalStore(),
        ),
        () => MockClient((request) {
          if (request.url.path == '/success') {
            successEntered.complete();
            return successResponse.future;
          }
          return Future.value(
            _json({
              'error': {'code': 'UNAUTHORIZED'},
            }, 401),
          );
        }),
      );
      final oldSuccess = services.api!
          .get('/success')
          .then<Object?>((value) => value, onError: (Object error) => error);
      await successEntered.future;
      final unauthorized = services.api!.get('/unauthorized');
      final unauthorizedCheck = expectLater(
        unauthorized,
        throwsA(isA<ApiException>()),
      );
      await fenceEntered.future;
      expect(services.sessionInvalidated.value, isTrue);
      expect(await services.auth!.readAccessToken(), isNull);
      successResponse.complete(_json({'private': 'old identity response'}));
      final outcome = await oldSuccess;
      fenceRelease.complete();
      await unauthorizedCheck;
      expect(
        outcome,
        isA<ApiException>(),
        reason: 'Invalidation must precede disk IO, so old 200 responses cannot still succeed',
      );
      services.api!.close();
    });
    for (final baseUrl in [
      _origin,
      'https://other.example',
      '$_origin/other-api',
    ]) {
      test(
        'legacy raw token never transmits automatically to $baseUrl',
        () async {
          final store = _StateStore();
          final secrets = _Secrets()..values[_tokenKey] = _legacyToken;
          final local = MemoryInventoryLocalStore();
          local.drafts['medicine-new'] = 'synthetic-unowned-legacy-draft';
          var requests = 0;
          final services = await http.runWithClient(
            () => AppServices.create(
              apiBaseUrl: baseUrl,
              secretStore: secrets,
              identityStore: store,
              localStore: local,
            ),
            () => MockClient((_) async {
              requests++;
              return _json({});
            }),
          );
          expect(await services.auth!.readAccessToken(), isNull);
          await expectLater(
            services.auth!.getCurrentUser(),
            throwsA(isA<ApiException>()),
          );
          expect(requests, 0);
          expect(
            local.drafts['medicine-new'],
            'synthetic-unowned-legacy-draft',
            reason: 'Untrusted old bytes are not proof of an owner or permission to discard them',
          );
          services.api!.close();
        },
      );
    }
    test(
      'external same-token family move clears old data before validated rebind',
      () async {
        final store = _StateStore(value: _fence());
        final secrets = _Secrets()..values[_tokenKey] = _envelope();
        final local = MemoryInventoryLocalStore();
        local.family = FamilyRecord(
          id: 'synthetic-family-a',
          name: 'A',
          role: 'member',
        );
        local.drafts['synthetic-old-draft'] = 'synthetic-old-private-data';
        local.inventory = [
          MedicineRecord(id: 'old-item', name: 'Old item', batches: []),
        ];
        final services = await http.runWithClient(
          () => AppServices.create(
            apiBaseUrl: _origin,
            secretStore: secrets,
            identityStore: store,
            localStore: local,
          ),
          () => MockClient(
            (_) async => _json({
              'user': {
                'id': 'synthetic-user-a',
                'nickname': null,
                'hasFamily': true,
              },
              'family': {
                'id': 'synthetic-family-b',
                'name': 'B',
                'role': 'member',
              },
            }),
          ),
        );
        final profile = await services.auth!.getCurrentUser();
        expect(profile.family!.id, 'synthetic-family-b');
        expect(local.drafts, isEmpty);
        expect(local.inventory, isNull);
        expect(local.family!.id, 'synthetic-family-b');
        expect(
          services.api!.identityState!.owner!.familyId,
          'synthetic-family-b',
        );
        expect(
          services.familyInvalidated.value,
          isFalse,
          reason: 'A validated replacement family must not remain routed to family setup',
        );
        expect(await services.auth!.readAccessToken(), 'synthetic-token-a');
        final restored = _state(store, secrets);
        expect(await restored.readAccessToken(), 'synthetic-token-a');
        expect(restored.owner!.familyId, 'synthetic-family-b');
        services.api!.close();
      },
    );
    test(
      'late auth me cannot bind old owner while replacement cleanup is queued',
      () async {
        final store = _StateStore(value: _fence());
        final secrets = _Secrets()..values[_tokenKey] = _envelope();
        final local = _PausedClearStore()..pause = true;
        final meEntered = Completer<void>();
        final meResponse = Completer<http.Response>();
        final services = await http.runWithClient(
          () => AppServices.create(
            apiBaseUrl: _origin,
            secretStore: secrets,
            identityStore: store,
            localStore: local,
          ),
          () => MockClient((request) async {
            if (request.url.path.endsWith('/auth/me')) {
              meEntered.complete();
              return meResponse.future;
            }
            if (request.url.path.endsWith('/auth/device-links')) {
              return _json({
                'code': '987654',
                'pollToken': 'synthetic-new-poll',
                'expiresAt': '2099-01-01T00:00:00Z',
              });
            }
            return _json({'state': 'approved', 'token': 'synthetic-token-b'});
          }),
        );
        final me = services.auth!.getCurrentUser();
        final meCheck = expectLater(me, throwsA(isA<ApiException>()));
        await meEntered.future;
        await services.auth!.startDeviceLink();
        final approval = services.auth!.exchangePendingLink();
        await local.clearEntered.future;
        meResponse.complete(
          _json({
            'user': {'id': 'synthetic-user-a', 'hasFamily': true},
            'family': {
              'id': 'synthetic-family-a',
              'name': 'A',
              'role': 'member',
            },
          }),
        );
        await meCheck;
        local.clearRelease.complete();
        await approval;
        expect(await services.auth!.readAccessToken(), 'synthetic-token-b');
        expect(services.api!.identityState!.owner, isNull);
        expect(jsonDecode(store.value!)['owner'], isNull);
        expect(local.family, isNull);
        services.api!.close();
      },
    );
    test('current family unavailable removes owner family and preserves session on restart', () async {
      final store = _StateStore(value: _fence());
      final secrets = _Secrets()..values[_tokenKey] = _envelope();
      final services = await http.runWithClient(
        () => AppServices.create(
          apiBaseUrl: _origin,
          secretStore: secrets,
          identityStore: store,
          localStore: MemoryInventoryLocalStore(),
        ),
        () => MockClient(
          (_) async => _json({
            'error': {
              'code': 'FAMILY_NOT_FOUND',
              'message': 'Synthetic missing family',
            },
          }, 404),
        ),
      );
      await expectLater(
        services.api!.get('/family-probe'),
        throwsA(isA<ApiException>()),
      );
      expect(services.familyInvalidated.value, isTrue);
      expect(services.sessionInvalidated.value, isFalse);
      expect(await services.auth!.readAccessToken(), 'synthetic-token-a');
      final restored = _state(store, secrets);
      expect(await restored.readAccessToken(), 'synthetic-token-a');
      expect(restored.owner!.familyId, isNull);
      services.api!.close();
    });
    test('explicit logout retry recovers cleanup barrier after family fence write failure', () async {
      final store = _StateStore(value: _fence());
      final secrets = _Secrets()..values[_tokenKey] = _envelope();
      final local = MemoryInventoryLocalStore()
        ..family = FamilyRecord(
          id: 'synthetic-family-a',
          name: 'A',
          role: 'member',
        );
      local.drafts['old-private'] = 'synthetic-old-private';
      final services = await http.runWithClient(
        () => AppServices.create(
          apiBaseUrl: _origin,
          identityStore: store,
          secretStore: secrets,
          localStore: local,
        ),
        () => MockClient((request) async {
          if (request.url.path == '/family-probe') {
            return _json({
              'error': {'code': 'FAMILY_NOT_FOUND', 'message': 'missing'},
            }, 404);
          }
          return _legacyFlow(request);
        }),
      );
      store.failAllWrites = true;
      await expectLater(services.api!.get('/family-probe'), throwsA(anything));
      expect(services.sessionInvalidated.value, isTrue);
      store.failAllWrites = false;
      await services.auth!.logout();
      final link = await services.auth!.startDeviceLink();
      expect(link.code, '123456');
      expect(local.drafts, isEmpty);
      await services.auth!.exchangePendingLink();
      expect(
        await services.auth!.readAccessToken(),
        'synthetic-reconnected-token',
      );
      services.api!.close();
    });
    test('current-family endpoint clears prior private data before same-token family rebind', () async {
      final store = _StateStore(value: _fence());
      final secrets = _Secrets()..values[_tokenKey] = _envelope();
      final local = MemoryInventoryLocalStore();
      local.family = FamilyRecord(
        id: 'synthetic-family-a',
        name: 'A',
        role: 'member',
      );
      local.drafts['old-private'] = 'synthetic-old-family-draft';
      local.inventory = [
        MedicineRecord(id: 'old-private', name: 'Old private', batches: []),
      ];
      final services = await http.runWithClient(
        () => AppServices.create(
          apiBaseUrl: _origin,
          identityStore: store,
          secretStore: secrets,
          localStore: local,
        ),
        () => MockClient(
          (request) async => _json({
            'family': {
              'id': 'synthetic-family-b',
              'name': 'B',
              'role': 'member',
            },
          }),
        ),
      );
      final family = await services.families!.getCurrentFamily();
      expect(family.id, 'synthetic-family-b');
      expect(local.drafts, isEmpty);
      expect(local.inventory, isNull);
      expect(local.family!.id, 'synthetic-family-b');
      expect(
        services.api!.identityState!.owner!.familyId,
        'synthetic-family-b',
      );
      expect(services.familyInvalidated.value, isFalse);
      expect(services.offlineCacheMatchesOwner, isTrue);
      expect(await services.auth!.readAccessToken(), 'synthetic-token-a');
      services.api!.close();
    });
    test('missing family cache quarantines orphan inventory before verified profile reopens routes', () async {
      final store = _StateStore(value: _fence());
      final secrets = _Secrets()..values[_tokenKey] = _envelope();
      final local = MemoryInventoryLocalStore();
      local.inventory = [
        MedicineRecord(
          id: 'unproven-old-item',
          name: 'Unproven old item',
          batches: [],
        ),
      ];
      local.drafts['medicine-new'] = 'synthetic-unowned-medicine';
      local.drafts[_activeKey(_scope())] = 'synthetic-correctly-scoped-plan';
      final services = await _legacyServices(store, secrets, local);
      expect(local.family, isNull);
      expect(local.inventory, isNull);
      expect(local.drafts['medicine-new'], isNull);
      expect(
        local.legacyQuarantine['home_medicine.inventory.v1'],
        contains('unproven-old-item'),
      );
      expect(
        local.legacyQuarantine['home_medicine.draft.v1.medicine-new'],
        'synthetic-unowned-medicine',
      );
      expect(
        local.drafts[_activeKey(_scope())],
        'synthetic-correctly-scoped-plan',
      );
      expect(services.offlineCacheMatchesOwner, isFalse);
      await services.auth!.getCurrentUser();
      expect(services.offlineCacheMatchesOwner, isTrue);
      expect(local.inventory, isNull);
      expect(local.drafts['medicine-new'], isNull);
      expect(
        local.drafts[_activeKey(_scope())],
        'synthetic-correctly-scoped-plan',
      );
      services.api!.close();
    });
  });
}
