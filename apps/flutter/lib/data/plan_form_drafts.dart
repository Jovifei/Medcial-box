import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'api_client.dart';
import 'app_stores.dart';
import 'plan_creation_operations.dart';

/// Ordinary, possibly incomplete form input. Never a replayable HTTP operation.
class PlanFormDraftSnapshot {
  const PlanFormDraftSnapshot({
    required this.careProfileId,
    this.medicineId,
    this.medicineBindingChanged = false,
    required this.medicineName,
    required this.dosageText,
    required this.timeSlots,
    required this.weekdays,
    required this.specificWeekdays,
    required this.startDate,
    this.endDate,
    required this.version,
  });

  final String careProfileId;
  final String? medicineId;
  final bool medicineBindingChanged;
  final String medicineName;
  final String dosageText;
  final List<String> timeSlots;
  final List<String> weekdays;
  final bool specificWeekdays;
  final String startDate;
  final String? endDate;
  final int version;

  Map<String, Object?> toJson() => {
    'careProfileId': careProfileId,
    'medicineId': medicineId,
    'medicineBindingChanged': medicineBindingChanged,
    'medicineName': medicineName,
    'dosageText': dosageText,
    'timeSlots': List<String>.of(timeSlots),
    'weekdays': List<String>.of(weekdays),
    'specificWeekdays': specificWeekdays,
    'startDate': startDate,
    'endDate': endDate,
    'version': version,
  };

  factory PlanFormDraftSnapshot.fromJson(Object? value) {
    if (value is! Map ||
        value['careProfileId'] is! String ||
        (value['medicineId'] != null && value['medicineId'] is! String) ||
        (value.containsKey('medicineBindingChanged') &&
            value['medicineBindingChanged'] is! bool) ||
        value['medicineName'] is! String ||
        value['dosageText'] is! String ||
        value['timeSlots'] is! List ||
        !(value['timeSlots'] as List).every((v) => v is String) ||
        value['weekdays'] is! List ||
        !(value['weekdays'] as List).every((v) => v is String) ||
        value['specificWeekdays'] is! bool ||
        value['startDate'] is! String ||
        (value['endDate'] != null && value['endDate'] is! String) ||
        value['version'] is! int ||
        (value['version'] as int) < 1) {
      throw const FormatException('Invalid plan form draft');
    }
    final slots = (value['timeSlots'] as List).cast<String>();
    final days = (value['weekdays'] as List).cast<String>();
    const weekdays = {'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'};
    if (slots.length > 6 ||
        slots.toSet().length != slots.length ||
        slots.any(
          (time) =>
              !RegExp(r'^(?:[01][0-9]|2[0-3]):[0-5][0-9]$').hasMatch(time),
        ) ||
        days.length > 7 ||
        days.toSet().length != days.length ||
        days.any((day) => !weekdays.contains(day)) ||
        !_validDate(value['startDate'] as String) ||
        !_validDate(value['endDate'] as String?)) {
      throw const FormatException('Invalid plan form field value');
    }
    return PlanFormDraftSnapshot(
      careProfileId: value['careProfileId'] as String,
      medicineId: value['medicineId'] as String?,
      medicineBindingChanged: value['medicineBindingChanged'] as bool? ?? false,
      medicineName: value['medicineName'] as String,
      dosageText: value['dosageText'] as String,
      timeSlots: List<String>.unmodifiable(value['timeSlots'] as List),
      weekdays: List<String>.unmodifiable(value['weekdays'] as List),
      specificWeekdays: value['specificWeekdays'] as bool,
      startDate: value['startDate'] as String,
      endDate: value['endDate'] as String?,
      version: value['version'] as int,
    );
  }

  static bool _validDate(String? value) {
    if (value == null || value.isEmpty) return true;
    if (!RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(value) ||
        value.startsWith('0000-')) {
      return false;
    }
    final parsed = DateTime.tryParse(value);
    if (parsed == null) return false;
    // DateTime.parse normalizes impossible calendar dates instead of rejecting.
    return parsed.toIso8601String().substring(0, 10) == value;
  }
}

class PlanFormDraftException implements Exception {
  const PlanFormDraftException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Persisted opaque ownership/revision, allowing a late ACK to delete exactly
/// the ordinary form associated with its operation, including after restart.
class PlanFormDraftReference {
  const PlanFormDraftReference._(this.form, this.owner, this.revision);
  final String form;
  final String owner;
  final String revision;

  Map<String, Object?> toJson() => {
    'form': form,
    'owner': owner,
    'revision': revision,
  };

  factory PlanFormDraftReference.fromJson(Object? value) {
    if (value is! Map ||
        value['form'] is! String ||
        !(value['form'] as String).startsWith('form-') ||
        value['owner'] is! String ||
        !_identifier.hasMatch(value['owner'] as String) ||
        value['revision'] is! String ||
        !_identifier.hasMatch(value['revision'] as String)) {
      throw const FormatException('Invalid plan form reference');
    }
    return PlanFormDraftReference._(
      value['form'] as String,
      value['owner'] as String,
      value['revision'] as String,
    );
  }

  bool matches(PlanFormDraftReference other) =>
      form == other.form && owner == other.owner && revision == other.revision;
}

final _identifier = RegExp(r'^[a-f0-9]{32}$');

class PlanFormDraftHandle {
  PlanFormDraftHandle._(
    this.session,
    this.planId,
    this._owner,
    this._guard,
    this._api,
  );
  final ApiClient _api;
  final PlanCreationSession session;
  final String? planId;
  final String _owner;
  final bool Function()? _guard;
  PlanFormDraftSnapshot? _saved;
  PlanFormDraftReference? _reference;
  Object? _error;
  bool _readFailed = false;
  bool _needsDecision = false;
  bool _frozen = false;
  bool _closed = false;
  bool _spectator = false;
  int _generation = 0;

  PlanFormDraftSnapshot? get saved =>
      session.identityEpoch == _api.identityEpoch ? _saved : null;
  Object? get error =>
      session.identityEpoch == _api.identityEpoch ? _error : null;
  bool get frozen => _frozen;
  bool get needsDecision => _needsDecision;
}

/// Shared with the operation owner, scoped by API/user/family and new/edit ID.
/// Every disk access is serialized; page generations invalidate queued writes.
/// Private values use LocalAppStore's existing family cleanup, never secrets.
class PlanFormDrafts {
  PlanFormDrafts({
    required this.api,
    required this.store,
    required this.creations,
  });
  final ApiClient api;
  final LocalAppStore store;
  final PlanCreationOperations creations;
  final _owners = <String, PlanFormDraftHandle>{};
  final _random = Random.secure();
  Future<void> _tail = Future.value();

  String _id() => List.generate(
    16,
    (_) => _random.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();

  static String _form(String? planId) =>
      'form-${base64Url.encode(utf8.encode(jsonEncode(planId)))}';

  static bool isCreationReference(PlanFormDraftReference reference) =>
      reference.form == _form(null);

  static String storageKey(PlanCreationSession session, {String? planId}) =>
      _key(session.scope, _form(planId));

  static String _key(String scope, String form) => 'plan-form.v1.$scope.$form';
  String _handleKey(PlanFormDraftHandle handle) =>
      storageKey(handle.session, planId: handle.planId);

  Future<T> _serialized<T>(Future<T> Function() action) {
    final next = _tail.then((_) => action());
    _tail = next.then<void>((_) {}, onError: (Object _) {});
    return next;
  }

  bool isCurrent(PlanFormDraftHandle handle) =>
      !handle._closed &&
      handle.session.identityEpoch == api.identityEpoch &&
      (handle._guard?.call() ?? true) &&
      (handle._spectator || _owns(handle));

  bool _owns(PlanFormDraftHandle handle) =>
      handle.session.identityEpoch == api.identityEpoch &&
      identical(_owners[_handleKey(handle)], handle);

  void _requireCurrent(PlanFormDraftHandle handle) {
    if (!isCurrent(handle)) {
      throw const PlanFormDraftException('页面或家庭已变更，请重新打开计划。');
    }
  }

  bool _pendingCreation(PlanFormDraftHandle handle) =>
      handle.planId == null &&
      (creations.pending(handle.session) != null ||
          creations.needsRecovery(handle.session));

  void _requireWritable(PlanFormDraftHandle handle) {
    _requireCurrent(handle);
    if (handle._frozen || _pendingCreation(handle)) {
      throw const PlanFormDraftException('原提交尚未完成，请先核对原计划。');
    }
    if (handle._needsDecision || handle._readFailed) {
      throw const PlanFormDraftException('请先恢复或丢弃本机草稿。');
    }
  }

  Future<PlanFormDraftHandle> open(
    PlanCreationSession session, {
    String? planId,
    bool Function()? isCurrent,
  }) async {
    if (session.identityEpoch != api.identityEpoch ||
        !(isCurrent?.call() ?? true)) {
      throw const PlanFormDraftException('页面或家庭已变更，请重新打开计划。');
    }
    final handle = PlanFormDraftHandle._(
      session,
      planId,
      _id(),
      isCurrent,
      api,
    );
    final key = _handleKey(handle);
    await _serialized(() async {
      if (session.identityEpoch != api.identityEpoch ||
          !(isCurrent?.call() ?? true)) {
        throw const PlanFormDraftException('页面或家庭已变更，请重新打开计划。');
      }
      // Frozen original intent outranks even an unreadable ordinary draft and
      // a recovery viewer cannot steal the in-flight operation's owner lease.
      if (_pendingCreation(handle)) {
        handle._frozen = true;
        handle._spectator = true;
        return;
      }
      final old = _owners[key];
      if (old != null) close(old, preserveQueuedWrites: false);
      _owners[key] = handle;
      try {
        final raw = await store.readDraft(key);
        _requireCurrent(handle);
        if (raw == null) return;
        final record = _decode(raw, session.scope, _form(planId));
        handle._reference = record.$1;
        handle._saved = record.$2;
        handle._needsDecision = true;
      } catch (_) {
        _requireCurrent(handle);
        handle._readFailed = true;
        handle._needsDecision = true;
        handle._error = const PlanFormDraftException('本机草稿读取失败，请重新加载或明确丢弃后继续。');
      }
    });
    return handle;
  }

  (PlanFormDraftReference, PlanFormDraftSnapshot) _decode(
    String raw,
    String scope,
    String form,
  ) {
    final record = jsonDecode(raw);
    if (record is! Map || record['schema'] != 1 || record['scope'] != scope) {
      throw const FormatException('Invalid plan form record');
    }
    final reference = PlanFormDraftReference.fromJson(record['reference']);
    if (reference.form != form) {
      throw const FormatException('Wrong plan form');
    }
    return (reference, PlanFormDraftSnapshot.fromJson(record['values']));
  }

  Future<PlanFormDraftSnapshot> restore(PlanFormDraftHandle handle) =>
      _serialized(() async {
        _requireCurrent(handle);
        if (handle._frozen || _pendingCreation(handle)) {
          throw const PlanFormDraftException('请先核对原提交。');
        }
        if (handle._readFailed || handle._saved == null) {
          throw const PlanFormDraftException('本机草稿无法恢复，请重新加载或丢弃。');
        }
        handle._needsDecision = false;
        handle._error = null;
        return handle._saved!;
      });

  Future<void> save(
    PlanFormDraftHandle handle,
    PlanFormDraftSnapshot snapshot,
  ) async {
    _requireWritable(handle);
    final generation = handle._generation;
    // Copy at invocation so a later mutable UI list cannot rewrite history.
    final values = PlanFormDraftSnapshot.fromJson(snapshot.toJson());
    final reference = PlanFormDraftReference._(
      _form(handle.planId),
      handle._owner,
      _id(),
    );
    await _serialized(() async {
      if (!_owns(handle) || generation != handle._generation) return;
      if (_pendingCreation(handle)) return;
      try {
        await store.saveDraft(
          _handleKey(handle),
          jsonEncode({
            'schema': 1,
            'scope': handle.session.scope,
            'reference': reference.toJson(),
            'values': values.toJson(),
          }),
        );
        if (!_owns(handle) || generation != handle._generation) return;
        handle._reference = reference;
        handle._saved = values;
        handle._error = null;
      } catch (_) {
        if (_owns(handle) && generation == handle._generation) {
          handle._error = const PlanFormDraftException('本机草稿保存失败，请重试保存。');
          throw handle._error!;
        }
      }
    });
  }

  Future<void> discard(PlanFormDraftHandle handle) async {
    _requireCurrent(handle);
    if (handle._frozen || _pendingCreation(handle)) {
      throw const PlanFormDraftException('原提交尚未完成，不能丢弃原计划。');
    }
    handle._generation++;
    await _serialized(() async {
      _requireCurrent(handle);
      if (handle._frozen || _pendingCreation(handle)) {
        throw const PlanFormDraftException('原提交尚未完成，不能丢弃原计划。');
      }
      try {
        await store.deleteDraft(_handleKey(handle));
        _requireCurrent(handle);
        handle._saved = null;
        handle._reference = null;
        handle._needsDecision = false;
        handle._readFailed = false;
        handle._error = null;
      } catch (_) {
        _requireCurrent(handle);
        handle._error = const PlanFormDraftException('本机草稿清理失败，请重试。');
        throw handle._error!;
      }
    });
  }

  /// Stop accepting input immediately; drain prior writes before creating an
  /// operation. The record is read back so a partially failed write cannot be
  /// mistaken for the last known revision. The submitter never cleans by key.
  Future<PlanFormDraftReference?> freeze(PlanFormDraftHandle handle) async {
    _requireWritable(handle);
    handle._frozen = true;
    // Already-accepted autosaves drain before readback. New saves are locked.
    try {
      return await _serialized(() async {
        _requireCurrent(handle);
        if (handle._error != null) throw handle._error!;
        final raw = await store.readDraft(_handleKey(handle));
        _requireCurrent(handle);
        if (raw == null) return null;
        final record = _decode(raw, handle.session.scope, _form(handle.planId));
        handle._reference = record.$1;
        return record.$1;
      });
    } catch (_) {
      if (isCurrent(handle)) handle._frozen = false;
      rethrow;
    }
  }

  void resume(PlanFormDraftHandle handle) {
    if (isCurrent(handle) && !_pendingCreation(handle)) handle._frozen = false;
  }

  /// Clear exactly the persisted revision acknowledged by the operation. If
  /// deletion/read fails the caller MUST retain its original creation intent.
  Future<void> acknowledgeReference(
    PlanCreationSession session,
    PlanFormDraftReference? reference,
  ) async {
    if (reference == null) return;
    await _serialized(() async {
      if (session.identityEpoch != api.identityEpoch) {
        throw const PlanFormDraftException('家庭身份已变更。');
      }
      final key = _key(session.scope, reference.form);
      final raw = await store.readDraft(key);
      if (session.identityEpoch != api.identityEpoch) {
        throw const PlanFormDraftException('家庭身份已变更。');
      }
      if (raw == null) return;
      final record = _decode(raw, session.scope, reference.form);
      if (!record.$1.matches(reference)) return;
      await store.deleteDraft(key);
      if (session.identityEpoch != api.identityEpoch) {
        throw const PlanFormDraftException('家庭身份已变更。');
      }
      final owner = _owners[key];
      if (owner != null && owner._reference?.matches(reference) == true) {
        owner._reference = null;
        owner._saved = null;
      }
    });
  }

  void close(PlanFormDraftHandle handle, {bool preserveQueuedWrites = true}) {
    handle._closed = true;
    if (!preserveQueuedWrites) {
      handle._generation++;
      if (identical(_owners[_handleKey(handle)], handle)) {
        _owners.remove(_handleKey(handle));
      }
    } else {
      // Release disposed page callbacks only after its accepted writes drain.
      unawaited(
        _serialized(() async {
          if (identical(_owners[_handleKey(handle)], handle) &&
              handle._closed) {
            _owners.remove(_handleKey(handle));
          }
        }),
      );
    }
  }

  /// Synchronous invalidation precedes LocalAppStore.clearFamilyData. The
  /// IdentityLocalStore barrier then drains/removes already-started disk writes.
  void resetForIdentity() {
    for (final handle in _owners.values.toList()) {
      close(handle, preserveQueuedWrites: false);
      handle._saved = null;
      handle._reference = null;
      handle._error = null;
    }
  }
}
