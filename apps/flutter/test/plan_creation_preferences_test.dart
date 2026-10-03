// Synthetic plugin adapter; no native storage, account, or real device.
// ignore_for_file: depend_on_referenced_packages
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_platform_interface.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';

import 'plan_creation_operations_test.dart' show Harness, draft;

class FailingPreferences extends InMemorySharedPreferencesStore {
  FailingPreferences() : super.empty();
  String? failSetContains;
  bool failRemove = false;
  @override
  Future<bool> setValue(String valueType, String key, Object value) {
    if (failSetContains != null && key.contains(failSetContains!)) {
      return Future.value(false);
    }
    return super.setValue(valueType, key, value);
  }

  @override
  Future<bool> remove(String key) {
    if (failRemove) return Future.value(false);
    return super.remove(key);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late FailingPreferences backend;
  setUp(() {
    SharedPreferences.resetStatic();
    backend = FailingPreferences();
    SharedPreferencesStorePlatform.instance = backend;
  });
  tearDown(SharedPreferences.resetStatic);
  for (final part in ['plan_creation_marker', 'draft.v1']) {
    test('false result storing $part blocks POST', () async {
      backend.failSetContains = part;
      final store = await SharedPreferencesAppStore.create();
      final h = Harness(store: store);
      await expectLater(h.repo.createPlan(draft), throwsStateError);
      expect(h.posts, isEmpty);
    });
  }
  test('false private removal keeps cleanup failed, retry reloads persisted keys despite changed cache', () async {
    final store = await SharedPreferencesAppStore.create();
    await store.saveDraft('pending', 'SYNTHETIC_PRIVATE_PAYLOAD');
    await store.savePlanCreationMarker('scope', 'plan-synthetic-opaque-key');
    backend.failRemove = true;
    await expectLater(store.clearFamilyData(), throwsStateError);
    expect(
      (await backend.getAll()).values,
      contains('SYNTHETIC_PRIVATE_PAYLOAD'),
    );
    backend.failRemove = false;
    await store.clearFamilyData();
    expect(
      (await backend.getAll()).values,
      isNot(contains('SYNTHETIC_PRIVATE_PAYLOAD')),
    );
    expect(
      await store.readPlanCreationMarker('scope'),
      'plan-synthetic-opaque-key',
    );
  });
  test('false ACK cleanup remains acknowledged and original key survives fresh preferences reload', () async {
    final store = await SharedPreferencesAppStore.create();
    final h = Harness(store: store);
    backend.failRemove = true;
    final receipt = await h.repo.createPlan(draft);
    expect(receipt.planId, 'plan-a');
    SharedPreferences.resetStatic();
    final next = Harness(store: await SharedPreferencesAppStore.create());
    final session = await next.repo.creations.open();
    expect(
      next.repo.creations.pending(session)!.key,
      h.posts.single['idempotencyKey'],
    );
    backend.failRemove = false;
    await next.repo.retryPlanCreation(session);
    expect(next.posts.single, h.posts.single);
  });
}
