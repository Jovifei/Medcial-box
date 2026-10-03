import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/plan_models.dart';
import 'api_client.dart';
import 'app_stores.dart';
import 'plan_creation_operations.dart';
import 'plan_form_drafts.dart';

/// 用药计划 / 今日安排 / 服药确认 / 历史 / 照护对象 / 权限。
/// 端点与后端 routes/medication-plans、routes/care-profiles 对齐；
/// 只走 ApiClient，返回类型化模型（R10：这些是无状态读取，不回填共享库存快照）。
class ApiPlanRepository extends ChangeNotifier {
  ApiPlanRepository({required this.api, LocalAppStore? localStore}) {
    final store = localStore ?? MemoryInventoryLocalStore();
    creations = PlanCreationOperations(api: api, store: store);
    formDrafts = PlanFormDrafts(api: api, store: store, creations: creations);
    creations.formDrafts = formDrafts;
  }

  late final PlanCreationOperations creations;
  late final PlanFormDrafts formDrafts;

  final ApiClient api;
  Future<void> Function()? onChanged;
  Future<void> Function(int identityEpoch)? onMutationAcknowledged;
  Future<void> _changed(int epoch) async {
    if (epoch != api.identityEpoch) return;
    notifyListeners();
    await onMutationAcknowledged?.call(epoch);
    if (epoch != api.identityEpoch) return;
    await onChanged?.call();
  }

  /// Generic receiver projection. Never use the private canView schedule for alarms.
  Future<List<DoseReminderEntry>> reminderSchedules() async {
    final json = await api.get(
      '/api/v1/medication-plans/reminder-schedule',
    ) as Map<String, dynamic>;
    return (json['entries'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .map(DoseReminderEntry.fromJson)
        .toList(growable: false);
  }

  Future<List<MedicationPlanSummary>> listPlans({String? status}) async {
    final suffix = status == null
        ? ''
        : '?status=${Uri.encodeComponent(status)}';
    final json = await api.get(
      '/api/v1/medication-plans$suffix',
    ) as Map<String, dynamic>;
    return (json['plans'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .map(MedicationPlanSummary.fromJson)
        .toList(growable: false);
  }

  Future<PlanDetail> getPlan(String planId) async {
    final json = await api.get(
      '/api/v1/medication-plans/$planId',
    ) as Map<String, dynamic>;
    return PlanDetail.fromJson(json);
  }

  Future<PlanCreationReceipt> createPlan(
    MedicationPlanDraft draft, {
    PlanCreationSession? session,
    PlanFormDraftHandle? formDraft,
    bool Function()? isCurrent,
  }) async {
    final origin = session ?? await creations.open(isCurrent: isCurrent);
    final receipt = await creations.submit(
      origin,
      draft: draft,
      formDraft: formDraft,
      retry: false,
      isCurrent: isCurrent,
    );
    unawaited(_creationChanged(origin.identityEpoch));
    return receipt;
  }

  Future<PlanCreationReceipt> retryPlanCreation(
    PlanCreationSession session, {
    bool Function()? isCurrent,
  }) async {
    final receipt = await creations.submit(
      session,
      retry: true,
      isCurrent: isCurrent,
    );
    unawaited(_creationChanged(session.identityEpoch));
    return receipt;
  }

  Future<void> _creationChanged(int epoch) async {
    try {
      // Preserve the acknowledged-mutation hook and identity cleanup behavior.
      // Refresh failure cannot turn an acknowledged create into a write failure.
      await _changed(epoch);
    } catch (_) {}
  }

  Future<void> updatePlan(
    String planId, {
    required MedicationPlanDraft draft,
    required int version,
    PlanFormDraftHandle? formDraft,
    bool Function()? isCurrent,
  }) async {
    if (formDraft?.session.offlineReadOnly == true) {
      throw const PlanFormDraftException('当前为离线本机草稿，请联网重新加载后保存计划。');
    }
    final epoch = api.identityEpoch;
    PlanFormDraftReference? reference;
    var acknowledged = false;
    try {
      if (formDraft != null) {
        if (formDraft.planId != planId) {
          throw const PlanFormDraftException('计划草稿不属于当前计划。');
        }
        reference = await formDrafts.freeze(formDraft);
      }
      final result = await api.put(
        '/api/v1/medication-plans/$planId',
        draft.toUpdatePayload(version: version),
        isCurrent: () =>
            epoch == api.identityEpoch &&
            (isCurrent?.call() ?? true) &&
            (formDraft == null || formDrafts.isCurrent(formDraft)),
      );
      if (result is! Map ||
          result['planId'] != planId ||
          result['version'] != version + 1) {
        throw const PlanFormDraftException('保存结果无法确认，请重新加载计划核对。');
      }
      acknowledged = true;
      if (formDraft != null) {
        try {
          await formDrafts.acknowledgeReference(formDraft.session, reference);
        } catch (_) {
          // Known server success remains success; stale edit revision still
          // uses the original optimistic version and cannot silently overwrite.
        }
      }
      unawaited(_creationChanged(epoch));
    } finally {
      if (!acknowledged && formDraft != null) formDrafts.resume(formDraft);
    }
  }

  Future<void> changeStatus(
    String planId, {
    required String action,
    required int version,
  }) async {
    final epoch = api.identityEpoch;
    await api.post(
      '/api/v1/medication-plans/$planId/$action',
      body: {'version': version},
    );
    await _changed(epoch);
  }

  /// 今日安排：不传 date 时由服务端按上海当前日历返回，客户端绝不本地猜日期。
  Future<ScheduleDay> schedule({String? date}) async {
    final suffix = date == null ? '' : '?date=${Uri.encodeComponent(date)}';
    final json = await api.get(
      '/api/v1/medication-plans/schedule$suffix',
    ) as Map<String, dynamic>;
    return ScheduleDay.fromJson(json);
  }

  Future<void> confirmDose(
    String occurrenceId, {
    required String action,
    required String idempotencyKey,
    void Function(String status)? onConfirmed,
  }) async {
    final epoch = api.identityEpoch;
    final result = await api.post(
      '/api/v1/dose-occurrences/$occurrenceId/confirm',
      body: {'action': action, 'idempotencyKey': idempotencyKey},
    );
    final status = result is Map<String, dynamic> ? result['status'] : null;
    if (status != 'taken' && status != 'skipped') {
      throw const ApiException(
        statusCode: 502,
        code: 'INVALID_RESPONSE',
        message: '记录返回结果无法识别，请重试上次记录以核对结果。',
      );
    }
    // The server write is acknowledged before notification/schedule refreshes.
    // Their failure must not turn a known success into an uncertain new write.
    onConfirmed?.call(status as String);
    await _changed(epoch);
  }

  Future<PlanHistory> planHistory(String planId) async {
    final json = await api.get(
      '/api/v1/medication-plans/$planId/history',
    ) as Map<String, dynamic>;
    return PlanHistory.fromJson(json);
  }

  // —— 照护对象与权限 ——

  Future<List<CareProfileSummary>> listCareProfiles() async {
    final json = await api.get('/api/v1/care-profiles') as Map<String, dynamic>;
    return (json['careProfiles'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .map(CareProfileSummary.fromJson)
        .toList(growable: false);
  }

  Future<CareProfileSummary> createCareProfile({
    required String displayName,
    String? linkedUserId,
  }) async {
    final json = await api.post(
      '/api/v1/care-profiles',
      body: {'displayName': displayName, 'linkedUserId': ?linkedUserId},
    ) as Map<String, dynamic>;
    return CareProfileSummary.fromJson(json);
  }

  /// B10：本人档案由服务端绑定当前身份（幂等），客户端不传 linkedUserId。
  Future<CareProfileSummary> ensureSelfCareProfile({
    String? displayName,
  }) async {
    final json = await api.post(
      '/api/v1/care-profiles/self',
      body: displayName == null || displayName.isEmpty
          ? const {}
          : {'displayName': displayName},
    ) as Map<String, dynamic>;
    return CareProfileSummary.fromJson(json);
  }

  Future<CareGrantList> listCareGrants(String careProfileId) async {
    final json = await api.get(
      '/api/v1/care-profiles/$careProfileId/grants',
    ) as Map<String, dynamic>;
    return CareGrantList.fromJson(json);
  }

  Future<void> createCareGrant(
    String careProfileId, {
    required String memberUserId,
    required bool canManage,
    bool canView = true,
    bool receiveDoseReminders = false,
  }) async {
    final epoch = api.identityEpoch;
    await api.post(
      '/api/v1/care-profiles/$careProfileId/grants',
      body: {
        'memberUserId': memberUserId,
        'canView': canManage || canView,
        'canManage': canManage,
        'receiveDoseReminders': receiveDoseReminders,
      },
    );
    await _changed(epoch);
  }

  Future<void> transferCareManagement(
    String careProfileId,
    String memberUserId,
  ) async {
    final epoch = api.identityEpoch;
    await api.post(
      '/api/v1/care-profiles/$careProfileId/transfer-management',
      body: {'memberUserId': memberUserId},
    );
    await _changed(epoch);
  }

  Future<void> archiveCareProfile(String careProfileId) async {
    final epoch = api.identityEpoch;
    await api.post('/api/v1/care-profiles/$careProfileId/archive');
    await _changed(epoch);
  }

  Future<void> revokeCareGrant(
    String careProfileId,
    String memberUserId,
  ) async {
    final epoch = api.identityEpoch;
    await api.delete(
      '/api/v1/care-profiles/$careProfileId/grants/$memberUserId',
    );
    await _changed(epoch);
  }
}
