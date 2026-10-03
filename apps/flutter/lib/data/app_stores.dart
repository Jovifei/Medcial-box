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
  // Opaque safety markers contain no medication payload and survive private
  // family cleanup, preventing unresolved creates from silently becoming new.
  Future<String?> readPlanCreationMarker(String scope);
  Future<void> savePlanCreationMarker(String scope, String key);
  Future<void> deletePlanCreationMarker(String scope);
  Future<void> clearFamilyData();
  // Legacy bytes are not an identity claim. Quarantine before reconnecting;
  // adopt only a scope proved by the current authenticated server context.
  Future<void> quarantineLegacyFamilyData({String? preserveVerifiedPlanScope});
  Future<void> adoptLegacyPlanDrafts(String verifiedScope);
}

bool _sameStoredValue(Object? left, Object? right) {
  if (left is List<String> && right is List<String>) {
    if (left.length != right.length) return false;
    for (var index = 0; index < left.length; index++) {
      if (left[index] != right[index]) return false;
    }
    return true;
  }
  return left.runtimeType == right.runtimeType && left == right;
}

Object _copyStoredValue(Object value) =>
    value is List<String> ? List<String>.of(value) : value;

void _validateVerifiedScope(String scope) {
  // This validates a key component, never ownership. Do not decode draft
  // fields to infer an API, user, or family; the caller supplies that proof.
  if (scope.length > 8192 ||
      !RegExp(r'^[A-Za-z0-9_-]+={0,2}$').hasMatch(scope)) {
    throw ArgumentError.value(
      scope,
      'verifiedScope',
      'Invalid scope component.',
    );
  }
}

bool _isScopedLegacyPlanKey(String key, String scope) {
  final prefix = SharedPreferencesAppStore._draftPrefix;
  return key == '${prefix}plan-creation.v1.$scope' ||
      key.startsWith('${prefix}plan-form.v1.$scope.');
}

class SharedPreferencesAppStore implements LocalAppStore {
  SharedPreferencesAppStore(this._preferences);
  final SharedPreferences _preferences;

  static const _inventoryKey = 'home_medicine.inventory.v1';
  static const _familyKey = 'home_medicine.family.v1';
  static const _lastSyncedKey = 'home_medicine.inventory.last_synced_at.v1';
  static const _draftPrefix = 'home_medicine.draft.v1.';
  static const _planMarkerPrefix = 'home_medicine.plan_creation_marker.v1.';
  // Deliberately outside _draftPrefix and normal family cleanup. Unknown
  // ownership cannot justify exposing or silently destroying legacy bytes.
  static const _legacyPrefix = 'home_medicine.legacy_quarantine.v1.';

  static bool _isPrivateFamilyKey(String key) =>
      key == _inventoryKey ||
      key == _familyKey ||
      key == _lastSyncedKey ||
      key.startsWith(_draftPrefix);

  Future<bool> _writeRaw(String key, Object value) {
    if (value is String) return _preferences.setString(key, value);
    if (value is bool) return _preferences.setBool(key, value);
    if (value is int) return _preferences.setInt(key, value);
    if (value is double) return _preferences.setDouble(key, value);
    if (value is List<String>) {
      return _preferences.setStringList(key, List<String>.of(value));
    }
    throw StateError('旧版本机数据无法安全保留，请勿清除应用数据。');
  }

  void _requireValue(String key, Object expected) {
    if (!_preferences.containsKey(key) ||
        !_sameStoredValue(_preferences.get(key), expected)) {
      throw StateError('旧版本机数据保留未确认，请重试。');
    }
  }

  Future<void> _removeVerifiedCopy({
    required String source,
    required String destination,
    required Object value,
  }) async {
    // SharedPreferences mutates its cache even when a platform write reports
    // failure. Read persisted values again before every destructive step.
    await _preferences.reload();
    _requireValue(destination, value);
    if (!_preferences.containsKey(source)) return;
    _requireValue(source, value);
    if (!await _preferences.remove(source)) {
      throw StateError('旧版本机数据移动未完成，请重试。');
    }
    await _preferences.reload();
    _requireValue(destination, value);
    if (_preferences.containsKey(source)) {
      throw StateError('旧版本机数据移动未确认，请重试。');
    }
  }

  @override
  Future<void> quarantineLegacyFamilyData({
    String? preserveVerifiedPlanScope,
  }) async {
    await _preferences.reload();
    if (preserveVerifiedPlanScope != null) {
      _validateVerifiedScope(preserveVerifiedPlanScope);
    }
    final originals = <String, Object>{};
    for (final key in _preferences.getKeys().where(_isPrivateFamilyKey)) {
      if (preserveVerifiedPlanScope != null &&
          _isScopedLegacyPlanKey(key, preserveVerifiedPlanScope)) {
        continue;
      }
      final value = _preferences.get(key);
      if (value == null) {
        throw StateError('旧版本机数据无法安全保留，请勿清除应用数据。');
      }
      originals[key] = _copyStoredValue(value);
    }
    // First copy the whole snapshot. A copy failure/conflict never causes
    // deletion of an original, including unrelated records later in the batch.
    for (final entry in originals.entries) {
      final destination = '$_legacyPrefix${entry.key}';
      if (_preferences.containsKey(destination)) {
        _requireValue(destination, entry.value);
      } else if (!await _writeRaw(destination, entry.value)) {
        throw StateError('旧版本机数据保留失败，请重试。');
      }
    }
    await _preferences.reload();
    for (final entry in originals.entries) {
      _requireValue('$_legacyPrefix${entry.key}', entry.value);
    }
    for (final entry in originals.entries) {
      await _removeVerifiedCopy(
        source: entry.key,
        destination: '$_legacyPrefix${entry.key}',
        value: entry.value,
      );
    }
  }

  @override
  Future<void> adoptLegacyPlanDrafts(String verifiedScope) async {
    _validateVerifiedScope(verifiedScope);
    await _preferences.reload();
    final adopted = <String, String>{};
    for (final key in _preferences.getKeys().toList()) {
      if (!key.startsWith(_legacyPrefix)) continue;
      final active = key.substring(_legacyPrefix.length);
      if (!_isScopedLegacyPlanKey(active, verifiedScope)) continue;
      final value = _preferences.get(key);
      // These two known formats store strings. A malformed type is preserved
      // in quarantine rather than being exposed through a string-only reader.
      if (value is! String) {
        throw StateError('旧版计划草稿格式无法确认，请勿清除应用数据。');
      }
      if (_preferences.containsKey(active)) {
        if (!_sameStoredValue(_preferences.get(active), value)) continue;
      } else if (!await _preferences.setString(active, value)) {
        throw StateError('旧版计划草稿恢复失败，请重试。');
      }
      adopted[active] = value;
    }
    await _preferences.reload();
    for (final entry in adopted.entries) {
      _requireValue(entry.key, entry.value);
    }
    for (final entry in adopted.entries) {
      await _removeVerifiedCopy(
        source: '$_legacyPrefix${entry.key}',
        destination: entry.key,
        value: entry.value,
      );
    }
  }

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
    if (!await _preferences.setString('$_draftPrefix$key', json)) {
      throw StateError('无法保存本机草稿，请重试。');
    }
  }

  @override
  Future<void> deleteDraft(String key) async {
    if (!await _preferences.remove('$_draftPrefix$key')) {
      throw StateError('无法清理本机草稿，请重试。');
    }
  }

  @override
  Future<String?> readPlanCreationMarker(String scope) async =>
      _preferences.getString('$_planMarkerPrefix$scope');

  @override
  Future<void> savePlanCreationMarker(String scope, String key) async {
    if (!await _preferences.setString('$_planMarkerPrefix$scope', key)) {
      throw StateError('无法保存计划重试标记，请重试。');
    }
  }

  @override
  Future<void> deletePlanCreationMarker(String scope) async {
    if (!await _preferences.remove('$_planMarkerPrefix$scope')) {
      throw StateError('无法清理计划重试标记，请重试。');
    }
  }

  @override
  Future<void> clearFamilyData() async {
    // A failed remove can already have changed the plugin's memory cache.
    // Reload before every cleanup/retry so persisted private keys are retried.
    await _preferences.reload();
    final keys = _preferences.getKeys();
    for (final key in keys) {
      if (_isPrivateFamilyKey(key)) {
        if (!await _preferences.remove(key)) {
          throw StateError('无法清理本机家庭数据，请重试。');
        }
      }
    }
  }
}

class MemoryInventoryLocalStore implements LocalAppStore {
  List<MedicineRecord>? inventory;
  FamilyRecord? family;
  DateTime? lastSyncedAt;
  final Map<String, String> drafts = {};
  final Map<String, String> planCreationMarkers = {};
  // Synthetic equivalent of the persisted quarantine, keyed by original key.
  final Map<String, Object> legacyQuarantine = {};

  @override
  Future<void> quarantineLegacyFamilyData({
    String? preserveVerifiedPlanScope,
  }) async {
    if (preserveVerifiedPlanScope != null) {
      _validateVerifiedScope(preserveVerifiedPlanScope);
    }
    final originals = <String, Object>{
      if (inventory != null)
        SharedPreferencesAppStore._inventoryKey: jsonEncode(
          inventory!.map((medicine) => medicine.toCacheJson()).toList(),
        ),
      if (family != null)
        SharedPreferencesAppStore._familyKey: jsonEncode(family!.toCacheJson()),
      if (lastSyncedAt != null)
        SharedPreferencesAppStore._lastSyncedKey: lastSyncedAt!
            .toUtc()
            .toIso8601String(),
      for (final entry in drafts.entries)
        if (preserveVerifiedPlanScope == null ||
            !_isScopedLegacyPlanKey(
              '${SharedPreferencesAppStore._draftPrefix}${entry.key}',
              preserveVerifiedPlanScope,
            ))
          '${SharedPreferencesAppStore._draftPrefix}${entry.key}': entry.value,
    };
    for (final entry in originals.entries) {
      if (legacyQuarantine.containsKey(entry.key) &&
          !_sameStoredValue(legacyQuarantine[entry.key], entry.value)) {
        throw StateError('旧版本机数据已有不同保留副本，请勿清除应用数据。');
      }
    }
    legacyQuarantine.addAll(originals);
    inventory = null;
    family = null;
    lastSyncedAt = null;
    drafts.removeWhere(
      (key, _) => originals.containsKey(
        '${SharedPreferencesAppStore._draftPrefix}$key',
      ),
    );
  }

  @override
  Future<void> adoptLegacyPlanDrafts(String verifiedScope) async {
    _validateVerifiedScope(verifiedScope);
    for (final entry in legacyQuarantine.entries.toList()) {
      if (!_isScopedLegacyPlanKey(entry.key, verifiedScope)) continue;
      final value = entry.value;
      if (value is! String) {
        throw StateError('旧版计划草稿格式无法确认，请勿清除应用数据。');
      }
      final active = entry.key.substring(
        SharedPreferencesAppStore._draftPrefix.length,
      );
      if (drafts.containsKey(active) && drafts[active] != value) continue;
      drafts[active] = value;
      legacyQuarantine.remove(entry.key);
    }
  }

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
  Future<String?> readPlanCreationMarker(String scope) async =>
      planCreationMarkers[scope];
  @override
  Future<void> savePlanCreationMarker(String scope, String key) async =>
      planCreationMarkers[scope] = key;
  @override
  Future<void> deletePlanCreationMarker(String scope) async =>
      planCreationMarkers.remove(scope);

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
  Future<void> quarantineLegacyFamilyData({String? preserveVerifiedPlanScope}) {
    _epoch++;
    final next = _tail.then(
      (_) => delegate.quarantineLegacyFamilyData(
        preserveVerifiedPlanScope: preserveVerifiedPlanScope,
      ),
    );
    _tail = next.catchError((Object _) {});
    return next;
  }

  @override
  Future<void> adoptLegacyPlanDrafts(String verifiedScope) =>
      _write(() => delegate.adoptLegacyPlanDrafts(verifiedScope));

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
  Future<void> savePlanCreationMarker(String scope, String key) =>
      _write(() => delegate.savePlanCreationMarker(scope, key));
  @override
  Future<void> deletePlanCreationMarker(String scope) =>
      _write(() => delegate.deletePlanCreationMarker(scope));
  @override
  Future<String?> readPlanCreationMarker(String scope) async {
    await _tail;
    return delegate.readPlanCreationMarker(scope);
  }

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
