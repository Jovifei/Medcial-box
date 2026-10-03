import 'package:flutter/foundation.dart';

import '../models/plan_models.dart';
import 'api_client.dart';

/// 用药计划 / 今日安排 / 服药确认 / 历史 / 照护对象 / 权限。
/// 端点与后端 routes/medication-plans、routes/care-profiles 对齐；
/// 只走 ApiClient，返回类型化模型（R10：这些是无状态读取，不回填共享库存快照）。
class ApiPlanRepository extends ChangeNotifier {
  ApiPlanRepository({required this.api});

  final ApiClient api;
  Future<void> Function()? onChanged;
  Future<void> _changed() async {
    notifyListeners();
    await onChanged?.call();
  }

  Future<List<ScheduleDay>> reminderSchedules() async {
    final first = await schedule();
    final start = DateTime.parse(first.date);
    final rest = await Future.wait(
      List.generate(6, (index) {
        final day = start.add(Duration(days: index + 1));
        return schedule(date: day.toIso8601String().substring(0, 10));
      }),
    );
    return [first, ...rest];
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

  Future<MedicationPlanSummary> createPlan(MedicationPlanDraft draft) async {
    final json = await api.post(
      '/api/v1/medication-plans',
      body: draft.toCreatePayload(),
    ) as Map<String, dynamic>;
    // 后端创建返回 {planId, careProfileId, status, version}；无完整计划体，回读详情。
    final planId = json['planId'] is String ? json['planId']! as String : '';
    if (planId.isEmpty) {
      throw const ApiException(
        statusCode: 502,
        code: 'INVALID_RESPONSE',
        message: '计划创建成功但未返回标识，请刷新后查看。',
      );
    }
    await _changed();
    final detail = await getPlan(planId);
    return detail.plan;
  }

  Future<void> updatePlan(
    String planId, {
    required MedicationPlanDraft draft,
    required int version,
  }) async {
    await api.put(
      '/api/v1/medication-plans/$planId',
      draft.toUpdatePayload(version: version),
    );
    await _changed();
  }

  Future<void> changeStatus(
    String planId, {
    required String action,
    required int version,
  }) async {
    await api.post(
      '/api/v1/medication-plans/$planId/$action',
      body: {'version': version},
    );
    await _changed();
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
    await _changed();
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
    await api.post(
      '/api/v1/care-profiles/$careProfileId/grants',
      body: {
        'memberUserId': memberUserId,
        'canView': canManage || canView,
        'canManage': canManage,
        'receiveDoseReminders': receiveDoseReminders,
      },
    );
    await _changed();
  }

  Future<void> transferCareManagement(
    String careProfileId,
    String memberUserId,
  ) async {
    await api.post(
      '/api/v1/care-profiles/$careProfileId/transfer-management',
      body: {'memberUserId': memberUserId},
    );
    await _changed();
  }

  Future<void> archiveCareProfile(String careProfileId) async {
    await api.post('/api/v1/care-profiles/$careProfileId/archive');
    await _changed();
  }

  Future<void> revokeCareGrant(
    String careProfileId,
    String memberUserId,
  ) async {
    await api.delete(
      '/api/v1/care-profiles/$careProfileId/grants/$memberUserId',
    );
    await _changed();
  }
}
