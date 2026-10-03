import 'dart:convert';
import 'dart:math';

import '../models/plan_models.dart';
import 'api_client.dart';
import 'app_stores.dart';

/// The original submitted payload, not a mutable form draft. Stored in the
/// existing private family-data lifecycle; never contains credentials.
class PendingPlanCreation {
  PendingPlanCreation._(this.key, this._payloadJson);
  final String key;
  final String _payloadJson;
  Map<String, Object?> get payload =>
      Map<String, Object?>.from(jsonDecode(_payloadJson) as Map);
  MedicationPlanDraft get draft {
    final body = payload;
    return MedicationPlanDraft(
      careProfileId: body['careProfileId']! as String,
      medicineId: body['medicineId'] as String?,
      medicineName: body['medicineName']! as String,
      dosageText: body['dosageText']! as String,
      timeSlots: (body['timeSlots']! as List).cast<String>(),
      weekdays: (body['weekdays'] as List? ?? []).cast<String>(),
      startDate: body['startDate']! as String,
      endDate: body['endDate'] as String?,
    );
  }
}

class PlanCreationSession {
  PlanCreationSession._(this.scope, this.identityEpoch);
  final String scope;
  final int identityEpoch;
}

class PlanCreationReceipt {
  const PlanCreationReceipt({
    required this.planId,
    required this.careProfileId,
    required this.status,
    required this.version,
  });
  final String planId;
  final String careProfileId;
  final String status;
  final int version;
}

/// A successful, current list inspection. It does not prove the old request
/// absent or cancelled; retirement requires a separate explicit confirmation.
class PlanCreationRecovery {
  PlanCreationRecovery._(this.session, this.key, this.plans);
  final PlanCreationSession session;
  final String key;
  final List<MedicationPlanSummary> plans;
}

class PlanCreationException implements Exception {
  const PlanCreationException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// One unresolved creation per authenticated user/family/API. No automatic
/// replay, expiry, discard, or replacement by changed form fields. Reopening
/// merely reads; retry requires a separate explicit call with the old intent.
class PlanCreationOperations {
  PlanCreationOperations({required this.api, required this.store});
  final ApiClient api;
  final LocalAppStore store;
  final _pending = <String, PendingPlanCreation>{};
  final _orphans = <String, String>{};
  final _loaded = <String>{};
  final _busy = <String>{};
  final _random = Random.secure();
  int? _epoch;
  Future<void> _tail = Future.value();

  static String storageKey(PlanCreationSession session) =>
      'plan-creation.v1.${session.scope}';

  Future<T> _serialized<T>(Future<T> Function() action) {
    final next = _tail.then((_) => action());
    _tail = next.then<void>((_) {}, onError: (Object _) {});
    return next;
  }

  void _requireCurrent(int epoch, [bool Function()? isCurrent]) {
    if (epoch != api.identityEpoch || (isCurrent != null && !isCurrent())) {
      throw const PlanCreationException('页面或家庭身份已变更，请重新打开计划。');
    }
    if (_epoch != epoch) {
      _epoch = epoch;
      _pending.clear();
      _orphans.clear();
      _loaded.clear();
    }
  }

  Future<PlanCreationSession> open({bool Function()? isCurrent}) async {
    final epoch = api.identityEpoch;
    _requireCurrent(epoch, isCurrent);
    await api.waitForIdentityCleanup();
    _requireCurrent(epoch, isCurrent);
    final result = await api.get('/api/v1/auth/me');
    _requireCurrent(epoch, isCurrent);
    final user = result is Map ? result['user'] : null;
    final family = result is Map ? result['family'] : null;
    if (user is! Map ||
        user['id'] is! String ||
        (user['id'] as String).trim().isEmpty ||
        user['hasFamily'] != true ||
        family is! Map ||
        family['id'] is! String ||
        (family['id'] as String).trim().isEmpty) {
      throw const PlanCreationException('无法确认当前家庭身份，请重新加载。');
    }
    final scope = base64Url.encode(
      utf8.encode(jsonEncode([api.baseUrl, user['id'], family['id']])),
    );
    final session = PlanCreationSession._(scope, epoch);
    await _serialized(() async {
      _requireCurrent(epoch, isCurrent);
      if (_loaded.contains(scope)) return;
      final marker = await store.readPlanCreationMarker(scope);
      _requireCurrent(epoch, isCurrent);
      final raw = await store.readDraft(storageKey(session));
      _requireCurrent(epoch, isCurrent);
      if (raw == null && marker != null) {
        if (!RegExp(r'^[A-Za-z0-9_-]{16,128}$').hasMatch(marker)) {
          throw const PlanCreationException('上次计划的重试标记无法读取，请勿重复创建。');
        }
        _orphans[scope] = marker;
      }
      if (raw != null) {
        // Corrupt/unknown records fail closed; never silently replace their key.
        try {
          final record = jsonDecode(raw) as Map;
          final key = record['key'] as String;
          if (record['version'] != 1 ||
              record['scope'] != scope ||
              !RegExp(r'^[A-Za-z0-9_-]{16,128}$').hasMatch(key)) {
            throw const FormatException();
          }
          if (marker != null && marker != key) throw const FormatException();
          final intent = PendingPlanCreation._(
            key,
            record['payload'] as String,
          );
          final draft = intent.draft;
          if (draft.careProfileId.isEmpty ||
              draft.medicineName.isEmpty ||
              draft.dosageText.isEmpty ||
              draft.timeSlots.isEmpty ||
              draft.startDate.isEmpty ||
              intent.payload.containsKey('idempotencyKey')) {
            throw const FormatException();
          }
          _pending[scope] = intent;
          // Partial ACK cleanup may have removed only the marker. Restore the
          // same opaque key from the original intent, without sending a write.
          if (marker == null) {
            await store.savePlanCreationMarker(scope, key);
            _requireCurrent(epoch, isCurrent);
          }
        } catch (_) {
          throw const PlanCreationException('上次计划的重试记录无法读取，请勿重复创建。');
        }
      }
      _loaded.add(scope);
    });
    return session;
  }

  PendingPlanCreation? pending(PlanCreationSession session) {
    _requireCurrent(session.identityEpoch);
    return _pending[session.scope];
  }

  bool needsRecovery(PlanCreationSession session) {
    _requireCurrent(session.identityEpoch);
    return _orphans.containsKey(session.scope);
  }

  bool _scopeBusy(String scope) =>
      _busy.any((lock) => lock.endsWith(':$scope'));

  Future<PlanCreationRecovery> inspectRecovery(
    PlanCreationSession session, {
    bool Function()? isCurrent,
  }) async {
    _requireCurrent(session.identityEpoch, isCurrent);
    final key = _orphans[session.scope];
    if (key == null || _scopeBusy(session.scope)) {
      throw const PlanCreationException('原请求仍在处理中，或重试记录已变化，请稍后重新核对。');
    }
    final result = await api.get('/api/v1/medication-plans?status=all');
    _requireCurrent(session.identityEpoch, isCurrent);
    if (result is! Map ||
        result['plans'] is! List ||
        !(result['plans'] as List).every(
          (p) =>
              p is Map<String, dynamic> &&
              p['id'] is String &&
              (p['id'] as String).isNotEmpty,
        )) {
      throw const PlanCreationException('无法核对当前计划，请稍后重试。');
    }
    if (_orphans[session.scope] != key || _scopeBusy(session.scope)) {
      throw const PlanCreationException('原请求仍在处理中，或重试记录已变化，请重新核对。');
    }
    return PlanCreationRecovery._(
      session,
      key,
      (result['plans'] as List)
          .cast<Map<String, dynamic>>()
          .map(MedicationPlanSummary.fromJson)
          .toList(),
    );
  }

  /// Called only after the user inspects plans and separately confirms that
  /// starting a NEW intent may duplicate an earlier or later-completing write.
  /// This never dispatches a create and cannot retire an in-flight request.
  Future<void> abandonAfterInspection(
    PlanCreationRecovery inspection, {
    bool Function()? isCurrent,
  }) => _serialized(() async {
    final session = inspection.session;
    _requireCurrent(session.identityEpoch, isCurrent);
    if (_scopeBusy(session.scope) ||
        _orphans[session.scope] != inspection.key) {
      throw const PlanCreationException('原请求仍在处理中，或重试记录已变化，请重新核对。');
    }
    await store.deletePlanCreationMarker(session.scope);
    _requireCurrent(session.identityEpoch, isCurrent);
    _orphans.remove(session.scope);
  });

  Future<PlanCreationReceipt> submit(
    PlanCreationSession session, {
    MedicationPlanDraft? draft,
    required bool retry,
    bool Function()? isCurrent,
  }) async {
    final epoch = session.identityEpoch;
    _requireCurrent(epoch, isCurrent);
    final lock = '$epoch:${session.scope}';
    if (!_busy.add(lock)) {
      throw const PlanCreationException('正在核对这次计划，请稍候。');
    }
    PendingPlanCreation? intent;
    var firstDispatch = false;
    var requestStarted = false;
    try {
      await _serialized(() async {
        _requireCurrent(epoch, isCurrent);
        if (!_loaded.contains(session.scope)) {
          throw const PlanCreationException('请先重新加载计划页面。');
        }
        if (_orphans.containsKey(session.scope)) {
          throw const PlanCreationException('原计划内容已清理，请先查看已有计划并确认是否开始新计划。');
        }
        intent = _pending[session.scope];
        if (retry) {
          if (intent == null) {
            throw const PlanCreationException('没有需要重试的计划，请重新打开页面。');
          }
        } else {
          if (intent != null) {
            throw const PlanCreationException('上次创建结果尚未确定，请先重试原计划。');
          }
          if (draft == null) throw ArgumentError.notNull('draft');
          final key =
              'plan-${List.generate(24, (_) => _random.nextInt(256).toRadixString(16).padLeft(2, '0')).join()}';
          intent = PendingPlanCreation._(
            key,
            jsonEncode(draft.toCreatePayload()),
          );
          _pending[session.scope] = intent!;
          firstDispatch = true;
        }
        // Await accepted local writes BEFORE asking ApiClient to dispatch. The
        // platform preferences API does not guarantee crash-proof disk flush.
        // Resaving an
        // unchanged retry also recovers an earlier partial storage failure.
        await store.savePlanCreationMarker(session.scope, intent!.key);
        _requireCurrent(epoch, isCurrent);
        await store.saveDraft(
          storageKey(session),
          jsonEncode({
            'version': 1,
            'scope': session.scope,
            'key': intent!.key,
            'payload': intent!._payloadJson,
          }),
        );
        _requireCurrent(epoch, isCurrent);
      });
      _requireCurrent(epoch, isCurrent);
      requestStarted = true;
      final result = await api.post(
        '/api/v1/medication-plans',
        body: {...intent!.payload, 'idempotencyKey': intent!.key},
        // Token storage awaits too: this is checked immediately before send.
        isCurrent: () =>
            epoch == api.identityEpoch && (isCurrent?.call() ?? true),
      );
      _requireCurrent(epoch);
      if (result is! Map ||
          result['planId'] is! String ||
          (result['planId'] as String).trim().isEmpty ||
          result['careProfileId'] != intent!.draft.careProfileId ||
          result['status'] != 'active' ||
          result['version'] != 1) {
        throw const PlanCreationException('创建结果无法确认，请重试原计划核对结果。');
      }
      final receipt = PlanCreationReceipt(
        planId: result['planId'] as String,
        careProfileId: result['careProfileId'] as String,
        status: result['status'] as String,
        version: result['version'] as int,
      );
      // Acknowledged success is never reversed by local cleanup. A retained
      // on-disk intent is safe to explicitly replay after process restart.
      await _forget(session, intent!);
      return receipt;
    } catch (error) {
      if (firstDispatch &&
          requestStarted &&
          error is ApiException &&
          const [400, 403, 404, 422].contains(error.statusCode) &&
          epoch == api.identityEpoch) {
        // Only this first, definite rejection proves no create was committed.
        // A rejection after any uncertain attempt does NOT prove that.
        await _forget(session, intent!);
      }
      rethrow;
    } finally {
      _busy.remove(lock);
    }
  }

  Future<void> _forget(
    PlanCreationSession session,
    PendingPlanCreation intent,
  ) async {
    try {
      await _serialized(() async {
        if (session.identityEpoch != api.identityEpoch) return;
        if (!identical(_pending[session.scope], intent)) return;
        // Remove the marker first. If private-intent deletion fails or the
        // process stops, reopening restores the SAME key from that intent.
        await store.deletePlanCreationMarker(session.scope);
        if (session.identityEpoch != api.identityEpoch) return;
        await store.deleteDraft(storageKey(session));
        if (session.identityEpoch == api.identityEpoch &&
            identical(_pending[session.scope], intent)) {
          _pending.remove(session.scope);
        }
      });
    } catch (_) {
      // Keep the original pending intent if cleanup fails. Never mint a new key
      // over that retained operation; an explicit same-key replay is harmless.
    }
  }
}
