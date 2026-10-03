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
  LocalReminderService({
    void Function(String? payload)? onNotificationTap,
    FlutterLocalNotificationsPlugin? plugin,
  }) : _plugin = plugin ?? FlutterLocalNotificationsPlugin() {
    _onNotificationTap = onNotificationTap;
  }
  void Function(String? payload)? _onNotificationTap;
  String? _pendingTap;
  bool _hasPendingTap = false;
  int _identityResets = 0;
  set onNotificationTap(void Function(String? payload)? callback) {
    _onNotificationTap = callback;
    if (callback != null && _hasPendingTap && _identityResets == 0) {
      final payload = _pendingTap;
      _pendingTap = null;
      _hasPendingTap = false;
      callback(payload);
    }
  }

  void handleNotificationTap(String? payload) {
    if (_identityResets > 0) return;
    final callback = _onNotificationTap;
    if (callback == null) {
      _pendingTap = payload;
      _hasPendingTap = true;
    } else {
      callback(payload);
    }
  }

  final FlutterLocalNotificationsPlugin _plugin;
  Future<void> _queue = Future.value();
  int _epoch = 0;
  Future<void>? _initializing;
  bool _initialized = false;
  bool enabled = false;
  String stockReminderTime = '09:00';

  /// 精确闹钟是否可用；不可用时回退到非精确调度，不阻断提醒。
  bool _exactAllowed = false;
  VoidCallback? _inventoryListener;
  List<MedicineRecord> _medicines = const [];
  List<DoseReminderEntry> _schedule = const [];

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
    final epoch = _epoch;
    _medicines = medicines;
    await _initialize();
    if (epoch != _epoch) return false;
    final android = _plugin
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >();
    final granted = await android?.requestNotificationsPermission() ?? false;
    if (!granted || epoch != _epoch) return false;
    // 服药/到期提醒希望按时触发；精确闹钟权限单独申请，拒绝则回退非精确。
    _exactAllowed = await android?.requestExactAlarmsPermission() ?? false;
    if (epoch != _epoch) return false;
    enabled = true;
    await (await SharedPreferences.getInstance()).setBool(_enabledKey, true);
    await _reschedule();
    return true;
  }

  Future<void> setSchedules(
    List<DoseReminderEntry> schedules, {
    required int identityEpoch,
  }) {
    if (identityEpoch != _epoch) return Future.value();
    _schedule = List.unmodifiable(schedules);
    return enabled ? _reschedule() : Future.value();
  }

  int get identityEpoch => _epoch;

  Future<void> sync(List<MedicineRecord> medicines) async {
    _medicines = medicines;
    await _reschedule();
  }

  /// 统一重排：到期/开封提醒 + 今日服药提醒，一次 cancelAll 覆盖两类，避免相互清除。
  Future<void> _reschedule() {
    final epoch = _epoch;
    final next = _queue.then((_) => _scheduleCurrent(epoch));
    _queue = next.catchError((Object _) {});
    return next;
  }

  bool _current(int epoch) => epoch == _epoch && enabled;

  Future<void> _scheduleCurrent(int epoch) async {
    await _initialize();
    if (!_current(epoch)) return;
    await _plugin.cancelAll();
    if (!_current(epoch)) return;
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
            int.parse(stockReminderTime.split(':').first),
            int.parse(stockReminderTime.split(':').last),
          );
          if (!scheduledDate.isAfter(now)) continue;
          final id = _stableId('exp:${medicine.id}:${batch.id}:$daysBefore');
          if (!scheduled.add(id)) continue;
          if (!_current(epoch)) return;
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

    for (final entry in _schedule) {
      final when = _occurrenceTime(entry.date, entry.time);
      if (when == null || !when.isAfter(now)) continue;
      final id = _stableId('dose:${entry.occurrenceId}');
      if (!scheduled.add(id)) continue;
      if (!_current(epoch)) return;
      await _plugin.zonedSchedule(
        id: id,
        title: '用药安排提醒',
        body: '有一项用药安排待核对，请打开药箱查看。',
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
        payload: entry.notificationPayload,
      );
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

  Future<void> resetForIdentity() async {
    _epoch++;
    enabled = false;
    _medicines = const [];
    _schedule = const [];
    _pendingTap = null;
    _hasPendingTap = false;
    _identityResets++;
    try {
      // Initialization can produce an old cold-launch response. It must not
      // reach an already-bound router while the previous identity is cleared.
      await _initialize();
      _pendingTap = null;
      _hasPendingTap = false;
      enabled = false;
      await _queue;
      await _plugin.cancelAll();
      await (await SharedPreferences.getInstance()).setBool(_enabledKey, false);
    } finally {
      _identityResets--;
    }
  }

  Future<void> disable() async {
    _epoch++;
    enabled = false;
    await _initialize();
    enabled = false;
    _exactAllowed = false;
    await (await SharedPreferences.getInstance()).setBool(_enabledKey, false);
    await _queue;
    await _plugin.cancelAll();
  }

  Future<void> _initialize() {
    if (_initialized) return Future.value();
    return _initializing ??= _initializeOnce();
  }

  Future<void> _initializeOnce() async {
    timezone_data.initializeTimeZones();
    tz.setLocalLocation(tz.getLocation('Asia/Shanghai'));
    enabled =
        (await SharedPreferences.getInstance()).getBool(_enabledKey) ?? false;
    await _plugin.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      ),
      onDidReceiveNotificationResponse: (response) =>
          handleNotificationTap(response.payload),
    );
    _initialized = true;
    final launch = await _plugin.getNotificationAppLaunchDetails();
    if (launch?.didNotificationLaunchApp == true) {
      handleNotificationTap(launch?.notificationResponse?.payload);
    }
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
