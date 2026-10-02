import 'dart:math' as math;
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:timezone/data/latest_all.dart' as timezone_data;
import 'package:timezone/timezone.dart' as tz;

import '../models/medicine_models.dart';
import '../models/plan_models.dart';
import 'api_medicine_repository.dart';

class LocalReminderService {
  LocalReminderService({this.onNotificationTap});
  void Function(String? payload)? onNotificationTap;
  final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();
  bool _initialized = false;
  bool enabled = false;

  /// 精确闹钟是否可用；不可用时回退到非精确调度，不阻断提醒。
  bool _exactAllowed = false;
  VoidCallback? _inventoryListener;
  List<MedicineRecord> _medicines = const [];
  ScheduleDay? _today;

  static const String _enabledKey = 'home_medicine.local_reminders.enabled';

  void watch(ApiMedicineRepository repository) {
    _inventoryListener = () {
      _medicines = repository.medicines;
      if (enabled) unawaited(_reschedule());
    };
    repository.addListener(_inventoryListener!);
  }

  Future<void> resume(ApiMedicineRepository repository) async {
    await _initialize();
    _medicines = repository.medicines;
    if (enabled) await _reschedule();
  }

  Future<bool> enableFor(List<MedicineRecord> medicines) async {
    _medicines = medicines;
    await _initialize();
    final android = _plugin.resolvePlatformSpecificImplementation<
      AndroidFlutterLocalNotificationsPlugin
    >();
    final granted = await android?.requestNotificationsPermission() ?? false;
    if (!granted) return false;
    // 服药/到期提醒希望按时触发；精确闹钟权限单独申请，拒绝则回退非精确。
    _exactAllowed = await android?.requestExactAlarmsPermission() ?? false;
    enabled = true;
    await (await SharedPreferences.getInstance()).setBool(_enabledKey, true);
    await _reschedule();
    return true;
  }

  /// 今日待确认服药实例（由用药计划页在加载后回灌）。到点后自动失效（重排会取消旧的）。
  void setTodaySchedule(ScheduleDay schedule) {
    _today = schedule;
    if (enabled) unawaited(_reschedule());
  }

  Future<void> sync(List<MedicineRecord> medicines) async {
    _medicines = medicines;
    await _reschedule();
  }

  /// 统一重排：到期/开封提醒 + 今日服药提醒，一次 cancelAll 覆盖两类，避免相互清除。
  Future<void> _reschedule() async {
    await _initialize();
    await _plugin.cancelAll();
    final now = tz.TZDateTime.now(tz.local);
    final scheduled = <int>{};
    final mode = _exactAllowed
        ? AndroidScheduleMode.exactAllowWhileIdle
        : AndroidScheduleMode.inexactAllowWhileIdle;

    for (final medicine in _medicines) {
      // 归档药品不再提醒（R15）：导出含归档查询也不应让已归档记录触发到期通知。
      if (medicine.isArchived) continue;
      for (final batch in medicine.batches) {
        if (!shouldScheduleLocalExpiryReminder(batch)) continue;
        final expiry = DateTime.tryParse(batch.managementExpiryDate ?? '');
        if (expiry == null) continue;
        for (final daysBefore in const [30, 7, 1, 0]) {
          final date = expiry.subtract(Duration(days: daysBefore));
          final scheduledDate = tz.TZDateTime(
            tz.local,
            date.year,
            date.month,
            date.day,
            9,
          );
          if (!scheduledDate.isAfter(now)) continue;
          final id = _stableId('exp:${medicine.id}:${batch.id}:$daysBefore');
          if (!scheduled.add(id)) continue;
          await _plugin.zonedSchedule(
            id: id,
            title: '家庭药箱有待处理事项',
            body:
                '有一项库存记录将于${daysBefore == 0 ? '今天' : '$daysBefore 天后'}到期，请打开药箱核对。',
            scheduledDate: scheduledDate,
            notificationDetails: const NotificationDetails(
              android: AndroidNotificationDetails(
                'medicine_expiry',
                '药品有效期提醒',
                channelDescription: '提醒家庭成员核对药品有效期和开封期限',
                importance: Importance.defaultImportance,
                priority: Priority.defaultPriority,
              ),
            ),
            androidScheduleMode: mode,
            payload: 'pending',
          );
        }
      }
    }

    final today = _today;
    if (today != null) {
      for (final entry in today.entries) {
        if (!entry.isPending) continue;
        final when = _occurrenceTime(today.date, entry.time);
        if (when == null || !when.isAfter(now)) continue;
        final id = _stableId('dose:${entry.occurrenceId}');
        if (!scheduled.add(id)) continue;
        await _plugin.zonedSchedule(
          id: id,
          title: '该服药了',
          body: '${entry.careProfileName} · ${entry.medicineName} ${entry.dosageText}',
          scheduledDate: when,
          notificationDetails: const NotificationDetails(
            android: AndroidNotificationDetails(
              'medicine_dose',
              '服药提醒',
              channelDescription: '按用药计划提醒按时服药',
              importance: Importance.high,
              priority: Priority.high,
            ),
          ),
          androidScheduleMode: mode,
          payload: 'dose',
        );
      }
    }
  }

  tz.TZDateTime? _occurrenceTime(String date, String time) {
    final parsed = DateTime.tryParse('${date}T$time:00');
    if (parsed == null) return null;
    return tz.TZDateTime(
      tz.local,
      parsed.year,
      parsed.month,
      parsed.day,
      parsed.hour,
      parsed.minute,
    );
  }

  Future<void> disable() async {
    await _initialize();
    enabled = false;
    _exactAllowed = false;
    await (await SharedPreferences.getInstance()).setBool(_enabledKey, false);
    await _plugin.cancelAll();
  }

  Future<void> _initialize() async {
    if (_initialized) return;
    timezone_data.initializeTimeZones();
    tz.setLocalLocation(tz.getLocation('Asia/Shanghai'));
    enabled =
        (await SharedPreferences.getInstance()).getBool(_enabledKey) ?? false;
    await _plugin.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      ),
      onDidReceiveNotificationResponse: (response) =>
          onNotificationTap?.call(response.payload),
    );
    _initialized = true;
  }

  int _stableId(String value) {
    var hash = 0x811c9dc5;
    for (final rune in value.runes) {
      hash = ((hash ^ rune) * 0x01000193) & 0x7fffffff;
    }
    return math.max(hash, 1);
  }
}

bool shouldScheduleLocalExpiryReminder(BatchRecord batch) =>
    batch.dispositionStatus != 'handled' && batch.managementExpiryDate != null;
