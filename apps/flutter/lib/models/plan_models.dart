String _stringOr(Object? value, [String fallback = '']) =>
    value is String ? value : fallback;

String? _stringOrNull(Object? value) =>
    value is String && value.isNotEmpty ? value : null;

List<String> _stringList(Object? value) =>
    (value as List<dynamic>? ?? []).whereType<String>().toList(growable: false);

int _intOr(Object? value, int fallback) => value is int ? value : fallback;

bool _boolOr(Object? value, bool fallback) => value is bool ? value : fallback;

Map<String, dynamic> _asMap(Object? value) =>
    value is Map<String, dynamic> ? value : const <String, dynamic>{};

/// 用药计划摘要（与后端 routes/medication-plans.ts 的 MedicationPlanSummary 对齐）。
class MedicationPlanSummary {
  const MedicationPlanSummary({
    required this.id,
    required this.careProfileId,
    required this.careProfileName,
    this.medicineId,
    required this.medicineName,
    required this.dosageText,
    required this.weekdays,
    required this.startDate,
    this.endDate,
    required this.status,
    required this.version,
    required this.timeSlots,
  });

  final String id;
  final String careProfileId;
  final String careProfileName;
  final String? medicineId;
  final String medicineName;
  final String dosageText;
  final List<String> weekdays;
  final String startDate;
  final String? endDate;
  final String status;
  final int version;
  final List<String> timeSlots;

  bool get isOngoing => status != 'ended';

  String get statusLabel => switch (status) {
    'active' => '进行中',
    'paused' => '已暂停',
    'ended' => '已结束',
    _ => status,
  };

  String get scheduleLabel {
    final days = weekdays.isEmpty ? '每天' : '每周 ${weekdays.join('、')}';
    final times = timeSlots.isEmpty ? '未设时间' : timeSlots.join(' / ');
    return '$days · $times';
  }

  factory MedicationPlanSummary.fromJson(Map<String, dynamic> json) =>
      MedicationPlanSummary(
        id: _stringOr(json['id']),
        careProfileId: _stringOr(json['careProfileId']),
        careProfileName: _stringOr(json['careProfileName']),
        medicineId: _stringOrNull(json['medicineId']),
        medicineName: _stringOr(json['medicineName']),
        dosageText: _stringOr(json['dosageText']),
        weekdays: _stringList(json['weekdays']),
        startDate: _stringOr(json['startDate']),
        endDate: _stringOrNull(json['endDate']),
        status: _stringOr(json['status'], 'active'),
        version: _intOr(json['version'], 1),
        timeSlots: _stringList(json['timeSlots']),
      );
}

class PlanDetail {
  const PlanDetail({required this.plan, required this.canManage});
  final MedicationPlanSummary plan;
  final bool canManage;

  factory PlanDetail.fromJson(Map<String, dynamic> json) => PlanDetail(
    plan: MedicationPlanSummary.fromJson(_asMap(json['plan'])),
    canManage: _boolOr(json['canManage'], false),
  );
}

/// 今日安排的一条服药实例。日期由服务端上海日历决定（客户端不猜日期，对齐 R11）。
class ScheduleEntry {
  const ScheduleEntry({
    required this.occurrenceId,
    required this.planId,
    required this.careProfileId,
    required this.careProfileName,
    required this.medicineName,
    required this.dosageText,
    required this.time,
    required this.status,
    this.receiveDoseReminders = false,
  });

  final String occurrenceId;
  final String planId;
  final String careProfileId;
  final String careProfileName;
  final String medicineName;
  final String dosageText;
  final String time;
  final String status;
  final bool receiveDoseReminders;

  bool get isPending => status == 'pending';

  String get statusLabel => switch (status) {
    'taken' => '已服用',
    'skipped' => '已跳过',
    _ => '待确认',
  };

  factory ScheduleEntry.fromJson(Map<String, dynamic> json) => ScheduleEntry(
    occurrenceId: _stringOr(json['occurrenceId']),
    planId: _stringOr(json['planId']),
    careProfileId: _stringOr(json['careProfileId']),
    careProfileName: _stringOr(json['careProfileName']),
    medicineName: _stringOr(json['medicineName']),
    dosageText: _stringOr(json['dosageText']),
    time: _stringOr(json['time']),
    status: _stringOr(json['status'], 'pending'),
    receiveDoseReminders: _boolOr(json['receiveDoseReminders'], false),
  );
}

class ScheduleDay {
  const ScheduleDay({required this.date, required this.entries});
  final String date;
  final List<ScheduleEntry> entries;

  factory ScheduleDay.fromJson(Map<String, dynamic> json) => ScheduleDay(
    date: _stringOr(json['date']),
    entries: (json['entries'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .map(ScheduleEntry.fromJson)
        .toList(growable: false),
  );
}

/// Server-authoritative, least-privilege reminder data. No private plan metadata.
class DoseReminderEntry {
  const DoseReminderEntry({
    required this.occurrenceId,
    required this.date,
    required this.time,
  });

  final String occurrenceId;
  final String date;
  final String time;

  factory DoseReminderEntry.fromJson(Map<String, dynamic> json) =>
      DoseReminderEntry(
        occurrenceId: _stringOr(json['occurrenceId']),
        date: _stringOr(json['date']),
        time: _stringOr(json['time']),
      );

  String get notificationPayload => 'dose-occurrence:v1:$date:$occurrenceId';
}

class PlanHistoryEvent {
  const PlanHistoryEvent({required this.action, this.actor, required this.at});
  final String action;
  final String? actor;
  final String at;

  String get actionLabel => switch (action) {
    'taken' => '确认服用',
    'skipped' => '标记跳过',
    _ => action,
  };

  factory PlanHistoryEvent.fromJson(Map<String, dynamic> json) =>
      PlanHistoryEvent(
        action: _stringOr(json['action']),
        actor: _stringOrNull(json['actor']),
        at: _stringOr(json['at']),
      );
}

class PlanHistoryRecord {
  const PlanHistoryRecord({
    required this.occurrenceId,
    required this.date,
    required this.time,
    required this.status,
    required this.corrected,
    required this.events,
    this.medicineName = '',
    this.dosageText = '',
    this.snapshotComplete = false,
    this.superseded = false,
  });

  final String medicineName;
  final String dosageText;
  final bool snapshotComplete;
  final bool superseded;
  String get statusLabel => superseded
      ? '已因改期作废'
      : switch (status) {
          'taken' => '已服用',
          'skipped' => '已跳过',
          _ => '未确认',
        };

  final String occurrenceId;
  final String date;
  final String time;
  final String status;
  final bool corrected;
  final List<PlanHistoryEvent> events;

  factory PlanHistoryRecord.fromJson(Map<String, dynamic> json) =>
      PlanHistoryRecord(
        medicineName: _stringOr(json['medicineName']),
        dosageText: _stringOr(json['dosageText']),
        snapshotComplete: _boolOr(json['snapshotComplete'], false),
        superseded: _boolOr(json['superseded'], false),
        occurrenceId: _stringOr(json['occurrenceId']),
        date: _stringOr(json['date']),
        time: _stringOr(json['time']),
        status: _stringOr(json['status'], 'pending'),
        corrected: _boolOr(json['corrected'], false),
        events: (json['events'] as List<dynamic>? ?? [])
            .whereType<Map<String, dynamic>>()
            .map(PlanHistoryEvent.fromJson)
            .toList(growable: false),
      );
}

class PlanHistory {
  const PlanHistory({
    required this.planId,
    required this.medicineName,
    required this.records,
  });
  final String planId;
  final String medicineName;
  final List<PlanHistoryRecord> records;

  factory PlanHistory.fromJson(Map<String, dynamic> json) => PlanHistory(
    planId: _stringOr(json['planId']),
    medicineName: _stringOr(json['medicineName']),
    records: (json['history'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .map(PlanHistoryRecord.fromJson)
        .toList(growable: false),
  );
}

class CareProfileSummary {
  const CareProfileSummary({
    required this.id,
    required this.displayName,
    this.linkedUserId,
    required this.canManage,
    required this.isPrivate,
  });

  final String id;
  final String displayName;
  final String? linkedUserId;
  final bool canManage;
  final bool isPrivate;

  bool get isSelf => linkedUserId != null;

  factory CareProfileSummary.fromJson(Map<String, dynamic> json) =>
      CareProfileSummary(
        id: _stringOr(json['id']),
        displayName: _stringOr(json['displayName']),
        linkedUserId: _stringOrNull(json['linkedUserId']),
        canManage: _boolOr(json['canManage'], false),
        isPrivate: _boolOr(json['isPrivate'], false),
      );
}

class CareGrant {
  const CareGrant({
    required this.memberUserId,
    required this.displayName,
    required this.canView,
    required this.canManage,
    this.receiveDoseReminders = false,
  });
  final String memberUserId;
  final String displayName;
  final bool canView;
  final bool canManage;
  final bool receiveDoseReminders;

  String get levelLabel => canManage ? '可查看与管理' : (canView ? '仅查看' : '无权限');

  factory CareGrant.fromJson(Map<String, dynamic> json) => CareGrant(
    memberUserId: _stringOr(json['memberUserId']),
    displayName: _stringOr(json['displayName']),
    canView: _boolOr(json['canView'], false),
    canManage: _boolOr(json['canManage'], false),
    receiveDoseReminders: _boolOr(json['receiveDoseReminders'], false),
  );
}

class CareGrantList {
  const CareGrantList({
    required this.careProfileId,
    required this.displayName,
    required this.grants,
  });
  final String careProfileId;
  final String displayName;
  final List<CareGrant> grants;

  factory CareGrantList.fromJson(Map<String, dynamic> json) => CareGrantList(
    careProfileId: _stringOr(json['careProfileId']),
    displayName: _stringOr(json['displayName']),
    grants: (json['grants'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .map(CareGrant.fromJson)
        .toList(growable: false),
  );
}

/// 建/改计划时提交的载荷；字段与后端 MedicationPlanPayload / UpdatePayload 对齐。
class MedicationPlanDraft {
  const MedicationPlanDraft({
    required this.careProfileId,
    this.medicineId,
    required this.medicineName,
    required this.dosageText,
    required this.timeSlots,
    required this.weekdays,
    required this.startDate,
    this.endDate,
  });

  final String careProfileId;
  final String? medicineId;
  final String medicineName;
  final String dosageText;
  final List<String> timeSlots;
  final List<String> weekdays;
  final String startDate;
  final String? endDate;

  Map<String, Object?> toCreatePayload() => {
    'careProfileId': careProfileId,
    'medicineId': medicineId,
    'medicineName': medicineName.trim(),
    'dosageText': dosageText.trim(),
    'timeSlots': timeSlots,
    if (weekdays.isNotEmpty) 'weekdays': weekdays,
    'startDate': startDate,
    'endDate': endDate,
  };

  Map<String, Object?> toUpdatePayload({required int version}) => {
    'medicineName': medicineName.trim(),
    'dosageText': dosageText.trim(),
    'timeSlots': timeSlots,
    'weekdays': weekdays,
    'startDate': startDate,
    'endDate': endDate,
    'version': version,
  };
}
