import 'dart:math' as math;
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:timezone/data/latest_all.dart' as timezone_data;
import 'package:timezone/timezone.dart' as tz;

import '../models/medicine_models.dart';
import 'api_medicine_repository.dart';

class LocalReminderService {
  LocalReminderService({this.onNotificationTap});
  void Function(String? payload)? onNotificationTap;
  final FlutterLocalNotificationsPlugin _plugin = FlutterLocalNotificationsPlugin();
  bool _initialized = false;
  bool enabled = false;
  VoidCallback? _inventoryListener;

  void watch(ApiMedicineRepository repository) {
    _inventoryListener = () {
      if (enabled) unawaited(sync(repository.medicines));
    };
    repository.addListener(_inventoryListener!);
  }

  Future<void> resume(ApiMedicineRepository repository) async {
    await _initialize();
    if (enabled) await sync(repository.medicines);
  }

  Future<bool> enableFor(List<MedicineRecord> medicines) async {
    await _initialize();
    final android = _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    final granted = await android?.requestNotificationsPermission() ?? false;
    if (!granted) return false;
    enabled = true;
    await (await SharedPreferences.getInstance()).setBool('home_medicine.local_reminders.enabled', true);
    await sync(medicines);
    return true;
  }

  Future<void> sync(List<MedicineRecord> medicines) async {
    await _initialize();
    await _plugin.cancelAll();
    final now = tz.TZDateTime.now(tz.local);
    final scheduled = <int>{};
    for (final medicine in medicines) {
      for (final batch in medicine.batches) {
        if (!shouldScheduleLocalExpiryReminder(batch)) continue;
        final expiry = DateTime.tryParse(batch.managementExpiryDate ?? '');
        if (expiry == null) continue;
        for (final daysBefore in const [30, 7, 1, 0]) {
          final date = expiry.subtract(Duration(days: daysBefore));
          final scheduledDate = tz.TZDateTime(tz.local, date.year, date.month, date.day, 9);
          if (!scheduledDate.isAfter(now)) continue;
          final id = _stableId('${medicine.id}:${batch.id}:$daysBefore');
          if (!scheduled.add(id)) continue;
          await _plugin.zonedSchedule(
            id: id,
            title: '家庭药箱有待处理事项',
            body: '有一项库存记录将于${daysBefore == 0 ? '今天' : '$daysBefore 天后'}到期，请打开药箱核对。',
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
            androidScheduleMode: AndroidScheduleMode.inexactAllowWhileIdle,
            payload: 'pending',
          );
        }
      }
    }
  }

  Future<void> disable() async {
    await _initialize();
    enabled = false;
    await (await SharedPreferences.getInstance()).setBool('home_medicine.local_reminders.enabled', false);
    await _plugin.cancelAll();
  }

  Future<void> _initialize() async {
    if (_initialized) return;
    timezone_data.initializeTimeZones();
    tz.setLocalLocation(tz.getLocation('Asia/Shanghai'));
    enabled = (await SharedPreferences.getInstance()).getBool('home_medicine.local_reminders.enabled') ?? false;
    await _plugin.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      ),
      onDidReceiveNotificationResponse: (response) => onNotificationTap?.call(response.payload),
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
