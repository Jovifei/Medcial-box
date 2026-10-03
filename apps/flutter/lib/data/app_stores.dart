import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/medicine_models.dart';

abstract interface class SecretStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class FlutterSecretStore implements SecretStore {
  FlutterSecretStore({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();
  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

class MemorySecretStore implements SecretStore {
  final Map<String, String> values = {};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}

abstract interface class LocalAppStore {
  Future<List<MedicineRecord>?> readInventory();
  Future<void> saveInventory(List<MedicineRecord> medicines);
  Future<FamilyRecord?> readFamily();
  Future<void> saveFamily(FamilyRecord? family);
  Future<DateTime?> readLastSyncedAt();
  Future<void> saveLastSyncedAt(DateTime value);
  Future<String?> readDraft(String key);
  Future<void> saveDraft(String key, String json);
  Future<void> deleteDraft(String key);
  Future<void> clearFamilyData();
}

class SharedPreferencesAppStore implements LocalAppStore {
  SharedPreferencesAppStore(this._preferences);
  final SharedPreferences _preferences;

  static const _inventoryKey = 'home_medicine.inventory.v1';
  static const _familyKey = 'home_medicine.family.v1';
  static const _lastSyncedKey = 'home_medicine.inventory.last_synced_at.v1';
  static const _draftPrefix = 'home_medicine.draft.v1.';

  static Future<SharedPreferencesAppStore> create() async =>
      SharedPreferencesAppStore(await SharedPreferences.getInstance());

  @override
  Future<List<MedicineRecord>?> readInventory() async {
    final json = _preferences.getString(_inventoryKey);
    if (json == null) return null;
    final decoded = jsonDecode(json);
    if (decoded is! List<dynamic>) return null;
    return decoded
        .whereType<Map<String, dynamic>>()
        .map(MedicineRecord.fromCacheJson)
        .toList(growable: false);
  }

  @override
  Future<void> saveInventory(List<MedicineRecord> medicines) async {
    await _preferences.setString(
      _inventoryKey,
      jsonEncode(medicines.map((medicine) => medicine.toCacheJson()).toList()),
    );
  }

  @override
  Future<FamilyRecord?> readFamily() async {
    final json = _preferences.getString(_familyKey);
    if (json == null) return null;
    return FamilyRecord.fromJson(jsonDecode(json) as Map<String, dynamic>);
  }

  @override
  Future<void> saveFamily(FamilyRecord? family) async {
    if (family == null) {
      await _preferences.remove(_familyKey);
    } else {
      await _preferences.setString(
        _familyKey,
        jsonEncode(family.toCacheJson()),
      );
    }
  }

  @override
  Future<DateTime?> readLastSyncedAt() async {
    final value = _preferences.getString(_lastSyncedKey);
    return value == null ? null : DateTime.tryParse(value)?.toLocal();
  }

  @override
  Future<void> saveLastSyncedAt(DateTime value) async {
    await _preferences.setString(
      _lastSyncedKey,
      value.toUtc().toIso8601String(),
    );
  }

  @override
  Future<String?> readDraft(String key) async =>
      _preferences.getString('$_draftPrefix$key');

  @override
  Future<void> saveDraft(String key, String json) async {
    await _preferences.setString('$_draftPrefix$key', json);
  }

  @override
  Future<void> deleteDraft(String key) async {
    await _preferences.remove('$_draftPrefix$key');
  }

  @override
  Future<void> clearFamilyData() async {
    final keys = _preferences.getKeys();
    for (final key in keys) {
      if (key == _inventoryKey ||
          key == _familyKey ||
          key == _lastSyncedKey ||
          key.startsWith(_draftPrefix)) {
        await _preferences.remove(key);
      }
    }
  }
}

class MemoryInventoryLocalStore implements LocalAppStore {
  List<MedicineRecord>? inventory;
  FamilyRecord? family;
  DateTime? lastSyncedAt;
  final Map<String, String> drafts = {};

  @override
  Future<List<MedicineRecord>?> readInventory() async => inventory;

  @override
  Future<void> saveInventory(List<MedicineRecord> medicines) async {
    inventory = List.of(medicines);
  }

  @override
  Future<FamilyRecord?> readFamily() async => family;

  @override
  Future<void> saveFamily(FamilyRecord? value) async => family = value;

  @override
  Future<DateTime?> readLastSyncedAt() async => lastSyncedAt;

  @override
  Future<void> saveLastSyncedAt(DateTime value) async => lastSyncedAt = value;

  @override
  Future<String?> readDraft(String key) async => drafts[key];

  @override
  Future<void> saveDraft(String key, String json) async => drafts[key] = json;

  @override
  Future<void> deleteDraft(String key) async => drafts.remove(key);

  @override
  Future<void> clearFamilyData() async {
    inventory = null;
    family = null;
    lastSyncedAt = null;
    drafts.clear();
  }
}

/// Serialize all identity data operations. Clearing invalidates queued writes,
/// then waits for any already-started write before removing its result.
class IdentityLocalStore implements LocalAppStore {
  IdentityLocalStore(this.delegate);
  final LocalAppStore delegate;
  int _epoch = 0;
  Future<void> _tail = Future.value();
  Future<void> _write(Future<void> Function() action) {
    final epoch = _epoch;
    final next = _tail.then((_) async {
      if (epoch == _epoch) await action();
    });
    _tail = next.catchError((Object _) {});
    return next;
  }

  @override
  Future<void> clearFamilyData() {
    _epoch++;
    final next = _tail.then((_) => delegate.clearFamilyData());
    _tail = next.catchError((Object _) {});
    return next;
  }

  @override
  Future<void> saveInventory(List<MedicineRecord> value) =>
      _write(() => delegate.saveInventory(value));
  @override
  Future<void> saveFamily(FamilyRecord? value) =>
      _write(() => delegate.saveFamily(value));
  @override
  Future<void> saveLastSyncedAt(DateTime value) =>
      _write(() => delegate.saveLastSyncedAt(value));
  @override
  Future<void> saveDraft(String key, String json) =>
      _write(() => delegate.saveDraft(key, json));
  @override
  Future<void> deleteDraft(String key) =>
      _write(() => delegate.deleteDraft(key));
  @override
  Future<List<MedicineRecord>?> readInventory() async {
    await _tail;
    return delegate.readInventory();
  }

  @override
  Future<FamilyRecord?> readFamily() async {
    await _tail;
    return delegate.readFamily();
  }

  @override
  Future<DateTime?> readLastSyncedAt() async {
    await _tail;
    return delegate.readLastSyncedAt();
  }

  @override
  Future<String?> readDraft(String key) async {
    await _tail;
    return delegate.readDraft(key);
  }
}
