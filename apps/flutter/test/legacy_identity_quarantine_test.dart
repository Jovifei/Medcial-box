// Synthetic preference backend only; no native storage or real user records.
// ignore_for_file: depend_on_referenced_packages
import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_platform_interface.dart';

const _draft = 'home_medicine.draft.v1.';
const _quarantine = 'home_medicine.legacy_quarantine.v1.';
const _inventory = 'home_medicine.inventory.v1';
const _family = 'home_medicine.family.v1';
const _sync = 'home_medicine.inventory.last_synced_at.v1';
const _marker = 'home_medicine.plan_creation_marker.v1.synthetic';
const _ordinary = '{"synthetic":"ordinary plan bytes"}';
const _pending = '{"key":"original-synthetic-intent","synthetic":"pending"}';

String _scope({
  String api = 'https://synthetic.invalid',
  String user = 'user-a',
  String family = 'family-a',
}) => base64Url.encode(utf8.encode(jsonEncode([api, user, family])));
String _form(String scope) => 'plan-form.v1.$scope.form-bnVsbA==';
String _operation(String scope) => 'plan-creation.v1.$scope';
String _q(String original) => '$_quarantine$original';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _Preferences backend;
  late SharedPreferences preferences;
  late SharedPreferencesAppStore store;

  setUp(() async {
    SharedPreferences.resetStatic();
    backend = _Preferences();
    SharedPreferencesStorePlatform.instance = backend;
    preferences = await SharedPreferences.getInstance();
    store = SharedPreferencesAppStore(preferences);
    await preferences.setString('unrelated.setting', 'keep');
  });
  tearDown(() async {
    expect((await backend.getAll())['flutter.unrelated.setting'], 'keep');
    SharedPreferences.resetStatic();
  });

  Future<void> seedPlans() async {
    await store.saveDraft(_form(_scope()), _ordinary);
    await store.saveDraft(_operation(_scope()), _pending);
    await store.saveDraft('medicine-unscoped', 'SYNTHETIC_OLD_MEDICINE');
  }

  Future<Object?> persisted(String key) async =>
      (await backend.getAll())['flutter.$key'];

  test('startup quarantine preserves only the established plan scope with missing family key', () async {
    await seedPlans();
    final other = _scope(family: 'other');
    await store.saveDraft(_form(other), 'other-private-plan');
    await preferences.setString(_inventory, 'unknown-inventory');
    expect(await store.readFamily(), isNull);
    await IdentityLocalStore(store)
        .quarantineLegacyFamilyData(preserveVerifiedPlanScope: _scope());
    expect(await store.readDraft(_form(_scope())), _ordinary);
    expect(await store.readDraft(_operation(_scope())), _pending);
    expect(await store.readDraft('medicine-unscoped'), isNull);
    expect(await store.readDraft(_form(other)), isNull);
    expect(await persisted(_q('$_draft${_form(other)}')), 'other-private-plan');
    expect(await store.readInventory(), isNull);
  });

  test(
    'memory startup quarantine has the same exact verified-scope preservation',
    () async {
      final memory = MemoryInventoryLocalStore();
      await memory.saveDraft(_form(_scope()), _ordinary);
      await memory.saveDraft(_operation(_scope()), _pending);
      await memory.saveDraft('medicine-unscoped', 'unknown');
      await memory.quarantineLegacyFamilyData(
        preserveVerifiedPlanScope: _scope(),
      );
      expect(memory.drafts, {
        _form(_scope()): _ordinary,
        _operation(_scope()): _pending,
      });
      expect(
        memory.legacyQuarantine,
        containsPair(
          '$_draft'
              'medicine-unscoped',
          'unknown',
        ),
      );
    },
  );

  test('quarantine preserves all private bytes and leaves unrelated preferences and opaque markers', () async {
    await seedPlans();
    await preferences.setString(
      _inventory,
      'invalid inventory JSON preserved exactly',
    );
    await preferences.setString(_family, 'family bytes');
    await preferences.setString(_sync, 'last-sync bytes');
    await preferences.setString(_marker, 'opaque-safety-marker');
    await preferences.setStringList('${_draft}bad-type', [
      'not',
      'a',
      'string',
    ]);
    await preferences.setInt('${_draft}bad-number', 7);
    await preferences.setBool('${_draft}bad-bool', true);
    await preferences.setDouble('${_draft}bad-double', 1.25);
    final before = Map<String, Object>.from(await backend.getAll());
    await store.quarantineLegacyFamilyData();
    expect(await store.readInventory(), isNull);
    expect(await store.readFamily(), isNull);
    expect(await store.readLastSyncedAt(), isNull);
    expect(await store.readDraft(_form(_scope())), isNull);
    expect(await store.readDraft('medicine-unscoped'), isNull);
    expect(await persisted(_marker), 'opaque-safety-marker');
    for (final entry in before.entries) {
      final key = entry.key.substring('flutter.'.length);
      if (key == 'unrelated.setting' || key == _marker) continue;
      expect(await persisted(key), isNull);
      expect(await persisted(_q(key)), entry.value);
    }
    final quarantined = Map<String, Object>.from(await backend.getAll());
    await store.quarantineLegacyFamilyData();
    expect(await backend.getAll(), quarantined);
  });

  test('only exact current verified scope plan keys are adopted, without interpreting their bytes', () async {
    await seedPlans();
    final wrongScope = _scope(user: 'user-b');
    await store.saveDraft(_form(wrongScope), 'other owner');
    await store.saveDraft(
      '${_operation(_scope())}.suffix',
      'not the exact pending key',
    );
    await store.saveDraft(
      'plan-form.v1.${_scope()}suffix.form-x',
      'not this scope',
    );
    await preferences.setString(_family, 'not an ownership proof');
    await store.quarantineLegacyFamilyData();
    await store.adoptLegacyPlanDrafts(_scope());
    expect(await store.readDraft(_form(_scope())), _ordinary);
    expect(await store.readDraft(_operation(_scope())), _pending);
    expect(await persisted(_q('$_draft${_form(_scope())}')), isNull);
    expect(await persisted(_q('$_draft${_operation(_scope())}')), isNull);
    expect(await store.readDraft(_form(wrongScope)), isNull);
    expect(await store.readDraft('medicine-unscoped'), isNull);
    expect(await store.readFamily(), isNull);
    expect(await persisted(_q('$_draft${_form(wrongScope)}')), 'other owner');
    expect(
      await persisted(_q('$_draft${_operation(_scope())}.suffix')),
      'not the exact pending key',
    );
    expect(
      await persisted(
        _q(
          '$_draft'
          'plan-form.v1.${_scope()}suffix.form-x',
        ),
      ),
      'not this scope',
    );
    await store.adoptLegacyPlanDrafts(_scope());
    expect(await store.readDraft(_form(_scope())), _ordinary);
    expect(await store.readDraft(_operation(_scope())), _pending);
  });

  test(
    'different API, user, or family cannot restore legacy plan data',
    () async {
      await seedPlans();
      await store.quarantineLegacyFamilyData();
      final before = Map<String, Object>.from(await backend.getAll());
      for (final wrong in [
        _scope(api: 'https://another.invalid'),
        _scope(user: 'other'),
        _scope(family: 'other'),
      ]) {
        await store.adoptLegacyPlanDrafts(wrong);
        expect(await backend.getAll(), before);
      }
    },
  );

  test(
    'current draft wins and its different quarantine copy is retained',
    () async {
      await seedPlans();
      await store.quarantineLegacyFamilyData();
      await store.saveDraft(_form(_scope()), 'CURRENT_DRAFT');
      await store.saveDraft(_operation(_scope()), 'CURRENT_INTENT');
      await store.adoptLegacyPlanDrafts(_scope());
      expect(await store.readDraft(_form(_scope())), 'CURRENT_DRAFT');
      expect(await store.readDraft(_operation(_scope())), 'CURRENT_INTENT');
      expect(await persisted(_q('$_draft${_form(_scope())}')), _ordinary);
      expect(await persisted(_q('$_draft${_operation(_scope())}')), _pending);
    },
  );

  test(
    'an identical persisted active copy permits exact quarantine deletion',
    () async {
      await seedPlans();
      await store.quarantineLegacyFamilyData();
      await store.saveDraft(_form(_scope()), _ordinary);
      await store.adoptLegacyPlanDrafts(_scope());
      expect(await store.readDraft(_form(_scope())), _ordinary);
      expect(await persisted(_q('$_draft${_form(_scope())}')), isNull);
      expect(
        await persisted(_q('${_draft}medicine-unscoped')),
        'SYNTHETIC_OLD_MEDICINE',
      );
    },
  );

  test(
    'family cleanup preserves unknown quarantine and unscoped medical bytes',
    () async {
      await seedPlans();
      await preferences.setString(_inventory, 'OLD_INVENTORY');
      await store.quarantineLegacyFamilyData();
      final before = Map<String, Object>.from(await backend.getAll());
      await store.clearFamilyData();
      expect(await backend.getAll(), before);
      await store.adoptLegacyPlanDrafts(_scope());
      await store.clearFamilyData();
      expect(await store.readDraft(_form(_scope())), isNull);
      expect(
        await persisted(_q('${_draft}medicine-unscoped')),
        'SYNTHETIC_OLD_MEDICINE',
      );
      expect(await persisted(_q(_inventory)), 'OLD_INVENTORY');
      expect(await store.readInventory(), isNull);
    },
  );

  test(
    'quarantine conflict preserves previous bytes and every original',
    () async {
      await seedPlans();
      final source = '$_draft${_operation(_scope())}';
      await preferences.setString(_q(source), 'PREVIOUS_QUARANTINE');
      await expectLater(store.quarantineLegacyFamilyData(), throwsStateError);
      expect(await persisted(source), _pending);
      expect(await persisted('$_draft${_form(_scope())}'), _ordinary);
      expect(
        await persisted('${_draft}medicine-unscoped'),
        'SYNTHETIC_OLD_MEDICINE',
      );
      expect(await persisted(_q(source)), 'PREVIOUS_QUARANTINE');
      expect(backend.removed, isEmpty);
    },
  );

  for (final fault in _Fault.values) {
    test('quarantine $fault copy never deletes original bytes', () async {
      await seedPlans();
      final source = '$_draft${_form(_scope())}';
      backend.setKey = 'flutter.${_q(source)}';
      backend.setFault = fault;
      await expectLater(store.quarantineLegacyFamilyData(), throwsStateError);
      expect(await persisted(source), _ordinary);
      expect(await persisted('$_draft${_operation(_scope())}'), _pending);
      expect(backend.removed, isEmpty);
      if (fault != _Fault.corruptAfterSuccess) {
        backend.setFault = null;
        await store.quarantineLegacyFamilyData();
        expect(await persisted(source), isNull);
        expect(await persisted(_q(source)), _ordinary);
      } else {
        backend.setFault = null;
        await expectLater(store.quarantineLegacyFamilyData(), throwsStateError);
        expect(await persisted(source), _ordinary);
        expect(await persisted(_q(source)), 'SYNTHETIC_CORRUPT_COPY');
      }
    });
  }

  for (final fault in [
    _Fault.falseBeforeWrite,
    _Fault.falseAfterWrite,
    _Fault.successWithoutWrite,
    _Fault.throwBeforeWrite,
  ]) {
    test('quarantine $fault removal retries from persisted copies', () async {
      await seedPlans();
      final source = '$_draft${_form(_scope())}';
      backend.removeKey = 'flutter.$source';
      backend.removeFault = fault;
      await expectLater(store.quarantineLegacyFamilyData(), throwsStateError);
      expect(await persisted(_q(source)), _ordinary);
      expect(await persisted(_q('$_draft${_operation(_scope())}')), _pending);
      backend.removeFault = null;
      SharedPreferences.resetStatic();
      store = await SharedPreferencesAppStore.create();
      await store.quarantineLegacyFamilyData();
      expect(await persisted(source), isNull);
      await store.adoptLegacyPlanDrafts(_scope());
      expect(await store.readDraft(_form(_scope())), _ordinary);
      expect(await store.readDraft(_operation(_scope())), _pending);
    });
  }

  for (final fault in _Fault.values) {
    test('adoption $fault copy retains original quarantined bytes', () async {
      await seedPlans();
      await store.quarantineLegacyFamilyData();
      backend.removed.clear();
      final active = '$_draft${_form(_scope())}';
      backend.setKey = 'flutter.$active';
      backend.setFault = fault;
      await expectLater(
        store.adoptLegacyPlanDrafts(_scope()),
        throwsStateError,
      );
      expect(await persisted(_q(active)), _ordinary);
      expect(await persisted(_q('$_draft${_operation(_scope())}')), _pending);
      expect(backend.removed, isEmpty);
      backend.setFault = null;
      await store.adoptLegacyPlanDrafts(_scope());
      if (fault == _Fault.corruptAfterSuccess) {
        expect(await persisted(active), 'SYNTHETIC_CORRUPT_COPY');
        expect(await persisted(_q(active)), _ordinary);
      } else {
        expect(await persisted(active), _ordinary);
        expect(await persisted(_q(active)), isNull);
      }
    });
  }

  for (final fault in [
    _Fault.falseBeforeWrite,
    _Fault.falseAfterWrite,
    _Fault.successWithoutWrite,
    _Fault.throwBeforeWrite,
  ]) {
    test('adoption $fault removal never loses verified active bytes', () async {
      await seedPlans();
      await store.quarantineLegacyFamilyData();
      final active = '$_draft${_form(_scope())}';
      backend.removeKey = 'flutter.${_q(active)}';
      backend.removeFault = fault;
      await expectLater(
        store.adoptLegacyPlanDrafts(_scope()),
        throwsStateError,
      );
      expect(await persisted(active), _ordinary);
      backend.removeFault = null;
      SharedPreferences.resetStatic();
      store = await SharedPreferencesAppStore.create();
      await store.adoptLegacyPlanDrafts(_scope());
      expect(await store.readDraft(_form(_scope())), _ordinary);
      expect(await store.readDraft(_operation(_scope())), _pending);
      expect(await persisted(_q(active)), isNull);
    });
  }

  test(
    'matching malformed plan type remains quarantined and fails closed',
    () async {
      final key = '$_draft${_form(_scope())}';
      await preferences.setInt(key, 123);
      await store.quarantineLegacyFamilyData();
      await expectLater(
        store.adoptLegacyPlanDrafts(_scope()),
        throwsStateError,
      );
      expect(await persisted(key), isNull);
      expect(await persisted(_q(key)), 123);
    },
  );

  test('empty or ambiguous scope components cannot expand adoption', () async {
    await seedPlans();
    await store.quarantineLegacyFamilyData();
    final before = Map<String, Object>.from(await backend.getAll());
    for (final scope in [
      '',
      '.',
      '..',
      'x.y',
      'a/b',
      r'a\b',
      '*',
      'abc===',
      'x' * 8193,
    ]) {
      await expectLater(
        store.adoptLegacyPlanDrafts(scope),
        throwsArgumentError,
      );
    }
    expect(await backend.getAll(), before);
  });

  test(
    'memory store preserves quarantine and adopts only the matching scope',
    () async {
      final memory = MemoryInventoryLocalStore();
      memory.inventory = [
        const MedicineRecord(id: 'synthetic', name: 'synthetic'),
      ];
      memory.lastSyncedAt = DateTime.utc(2026, 10, 3);
      memory.drafts.addAll({
        _form(_scope()): _ordinary,
        _operation(_scope()): _pending,
        'medicine-unscoped': 'private',
      });
      await memory.quarantineLegacyFamilyData();
      final before = Map<String, Object>.of(memory.legacyQuarantine);
      expect(memory.inventory, isNull);
      expect(memory.drafts, isEmpty);
      await memory.clearFamilyData();
      await memory.adoptLegacyPlanDrafts(_scope(user: 'wrong'));
      expect(memory.legacyQuarantine, before);
      await memory.adoptLegacyPlanDrafts(_scope());
      expect(memory.drafts[_form(_scope())], _ordinary);
      expect(memory.drafts[_operation(_scope())], _pending);
      expect(memory.drafts['medicine-unscoped'], isNull);
      expect(memory.legacyQuarantine['${_draft}medicine-unscoped'], 'private');
      expect(memory.legacyQuarantine[_inventory], isNotNull);
      await memory.adoptLegacyPlanDrafts(_scope());
      expect(memory.drafts[_form(_scope())], _ordinary);
    },
  );

  test(
    'memory quarantine conflict preserves both original and prior bytes',
    () async {
      final memory = MemoryInventoryLocalStore();
      memory.drafts['x'] = 'current';
      memory.legacyQuarantine['${_draft}x'] = 'prior';
      await expectLater(memory.quarantineLegacyFamilyData(), throwsStateError);
      expect(memory.drafts['x'], 'current');
      expect(memory.legacyQuarantine['${_draft}x'], 'prior');
    },
  );

  test('identity quarantine drains started writes and invalidates queued old writes', () async {
    final memory = _PausedMemory();
    final wrapped = IdentityLocalStore(memory);
    final started = wrapped.saveDraft(_form(_scope()), _ordinary);
    await memory.entered.future;
    final stale = wrapped.saveDraft('queued-old', 'do not write');
    final quarantine = wrapped.quarantineLegacyFamilyData();
    final reading = wrapped.readDraft(_form(_scope()));
    memory.release.complete();
    await Future.wait([started, stale, quarantine]);
    expect(await reading, isNull);
    expect(memory.legacyQuarantine['$_draft${_form(_scope())}'], _ordinary);
    expect(memory.legacyQuarantine['${_draft}queued-old'], isNull);
    await wrapped.adoptLegacyPlanDrafts(_scope());
    expect(await wrapped.readDraft(_form(_scope())), _ordinary);
  });

  test('identity change invalidates a queued adoption', () async {
    final memory = _PausedMemory();
    memory.legacyQuarantine['$_draft${_form(_scope())}'] = _ordinary;
    final wrapped = IdentityLocalStore(memory);
    final first = wrapped.saveDraft('current', 'current');
    await memory.entered.future;
    final staleAdoption = wrapped.adoptLegacyPlanDrafts(_scope());
    final clear = wrapped.clearFamilyData();
    memory.release.complete();
    await Future.wait([first, staleAdoption, clear]);
    expect(memory.drafts, isEmpty);
    expect(memory.legacyQuarantine['$_draft${_form(_scope())}'], _ordinary);
  });
}

enum _Fault {
  falseBeforeWrite,
  falseAfterWrite,
  successWithoutWrite,
  corruptAfterSuccess,
  throwBeforeWrite,
}

class _Preferences extends InMemorySharedPreferencesStore {
  _Preferences() : super.empty();
  String? setKey;
  String? removeKey;
  _Fault? setFault;
  _Fault? removeFault;
  final List<String> removed = [];

  @override
  Future<bool> setValue(String valueType, String key, Object value) async {
    if (key == setKey && setFault != null) {
      switch (setFault!) {
        case _Fault.falseBeforeWrite:
          return false;
        case _Fault.falseAfterWrite:
          await super.setValue(valueType, key, value);
          return false;
        case _Fault.successWithoutWrite:
          return true;
        case _Fault.corruptAfterSuccess:
          return super.setValue('String', key, 'SYNTHETIC_CORRUPT_COPY');
        case _Fault.throwBeforeWrite:
          throw StateError('Synthetic set failure');
      }
    }
    return super.setValue(valueType, key, value);
  }

  @override
  Future<bool> remove(String key) async {
    removed.add(key);
    if (key == removeKey && removeFault != null) {
      switch (removeFault!) {
        case _Fault.falseBeforeWrite:
          return false;
        case _Fault.falseAfterWrite:
          await super.remove(key);
          return false;
        case _Fault.successWithoutWrite:
          return true;
        case _Fault.corruptAfterSuccess:
          throw StateError('Unsupported synthetic remove fault');
        case _Fault.throwBeforeWrite:
          throw StateError('Synthetic remove failure');
      }
    }
    return super.remove(key);
  }
}

class _PausedMemory extends MemoryInventoryLocalStore {
  final entered = Completer<void>();
  final release = Completer<void>();
  @override
  Future<void> saveDraft(String key, String json) async {
    if (!entered.isCompleted) {
      entered.complete();
      await release.future;
    }
    await super.saveDraft(key, json);
  }
}
