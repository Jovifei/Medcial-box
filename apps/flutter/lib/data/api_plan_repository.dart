import '../models/plan_models.dart';
import 'api_client.dart';

/// 用药计划 / 今日安排 / 服药确认 / 历史 / 照护对象 / 权限。
/// 端点与后端 routes/medication-plans、routes/care-profiles 对齐；
/// 只走 ApiClient，返回类型化模型（R10：这些是无状态读取，不回填共享库存快照）。
class ApiPlanRepository {
  ApiPlanRepository({required this.api});

  final ApiClient api;

  Future<List<MedicationPlanSummary>> listPlans({String? status}) async {
    final suffix = status == null ? '' : '?status=${Uri.encodeComponent(status)}';
    final json =
        await api.get('/api/v1/medication-plans$suffix')
            as Map<String, dynamic>;
    return (json['plans'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .map(MedicationPlanSummary.fromJson)
        .toList(growable: false);
  }

  Future<PlanDetail> getPlan(String planId) async {
    final json = await api.get('/api/v1/medication-plans/$planId')
        as Map<String, dynamic>;
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
  }

  Future<void> changeStatus(
    String planId, {
    required String action,
    required int version,
  }) async {
    await api.post('/api/v1/medication-plans/$planId/$action', body: {
      'version': version,
    });
  }

  /// 今日安排：不传 date 时由服务端按上海当前日历返回，客户端绝不本地猜日期。
  Future<ScheduleDay> schedule({String? date}) async {
    final suffix = date == null ? '' : '?date=${Uri.encodeComponent(date)}';
    final json = await api.get('/api/v1/medication-plans/schedule$suffix')
        as Map<String, dynamic>;
    return ScheduleDay.fromJson(json);
  }

  Future<void> confirmDose(
    String occurrenceId, {
    required String action,
    required String idempotencyKey,
  }) async {
    await api.post('/api/v1/dose-occurrences/$occurrenceId/confirm', body: {
      'action': action,
      'idempotencyKey': idempotencyKey,
    });
  }

  Future<PlanHistory> planHistory(String planId) async {
    final json = await api.get('/api/v1/medication-plans/$planId/history')
        as Map<String, dynamic>;
    return PlanHistory.fromJson(json);
  }

  // —— 照护对象与权限 ——

  Future<List<CareProfileSummary>> listCareProfiles() async {
    final json = await api.get('/api/v1/care-profiles')
        as Map<String, dynamic>;
    return (json['careProfiles'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .map(CareProfileSummary.fromJson)
        .toList(growable: false);
  }

  Future<CareProfileSummary> createCareProfile({
    required String displayName,
    String? linkedUserId,
  }) async {
    final json = await api.post('/api/v1/care-profiles', body: {
      'displayName': displayName,
      if (linkedUserId != null) 'linkedUserId': linkedUserId,
    }) as Map<String, dynamic>;
    return CareProfileSummary.fromJson(json);
  }

  /// B10：本人档案由服务端绑定当前身份（幂等），客户端不传 linkedUserId。
  Future<CareProfileSummary> ensureSelfCareProfile({String? displayName}) async {
    final json = await api.post(
      '/api/v1/care-profiles/self',
      body: displayName == null || displayName.isEmpty
          ? const {}
          : {'displayName': displayName},
    ) as Map<String, dynamic>;
    return CareProfileSummary.fromJson(json);
  }

  Future<CareGrantList> listCareGrants(String careProfileId) async {
    final json = await api.get('/api/v1/care-profiles/$careProfileId/grants')
        as Map<String, dynamic>;
    return CareGrantList.fromJson(json);
  }

  Future<void> createCareGrant(
    String careProfileId, {
    required String memberUserId,
    required bool canManage,
  }) async {
    await api.post('/api/v1/care-profiles/$careProfileId/grants', body: {
      'memberUserId': memberUserId,
      'canManage': canManage,
    });
  }

  Future<void> revokeCareGrant(String careProfileId, String memberUserId) async {
    await api.delete('/api/v1/care-profiles/$careProfileId/grants/$memberUserId');
  }
}
