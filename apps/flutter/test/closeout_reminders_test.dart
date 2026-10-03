import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:home_medicine_flutter/data/local_reminder_service.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';
import 'package:home_medicine_flutter/models/plan_models.dart';
import 'package:timezone/timezone.dart' as tz;

class FakeNotifications implements FlutterLocalNotificationsPlugin {
  final Map<int, String?> bodies = {};
  Completer<void>? pause;
  @override
  Future<bool?> initialize({
    required InitializationSettings settings,
    DidReceiveNotificationResponseCallback? onDidReceiveNotificationResponse,
    DidReceiveBackgroundNotificationResponseCallback?
    onDidReceiveBackgroundNotificationResponse,
  }) async => true;
  @override
  Future<NotificationAppLaunchDetails?> getNotificationAppLaunchDetails() async => null;

  @override
  Future<void> cancelAll() async => bodies.clear();
  @override
  Future<void> zonedSchedule({
    required int id,
    required tz.TZDateTime scheduledDate,
    required NotificationDetails notificationDetails,
    required AndroidScheduleMode androidScheduleMode,
    String? title,
    String? body,
    String? payload,
    DateTimeComponents? matchDateTimeComponents,
  }) async {
    await pause?.future;
    bodies[id] = body;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  test('identity reset clears buffered tap from former account', () async {
    SharedPreferences.setMockInitialValues({});
    final service = LocalReminderService(plugin: FakeNotifications());
    service.handleNotificationTap('dose:former-account');
    await service.resetForIdentity();
    final received = <String?>[];
    service.onNotificationTap = received.add;
    expect(received, isEmpty);
  });
  test('cold notification tap is buffered until binding and consumed once', () {
    final service = LocalReminderService(plugin: FakeNotifications());
    service.handleNotificationTap('dose:synthetic-plan');
    final received = <String?>[];
    service.onNotificationTap = received.add;
    service.onNotificationTap = received.add;
    expect(received, ['dose:synthetic-plan']);
  });
  TestWidgetsFlutterBinding.ensureInitialized();
  test('disable waits for an in-flight schedule then cancels all', () async {
    SharedPreferences.setMockInitialValues({
      'home_medicine.local_reminders.enabled': true,
    });
    final plugin = FakeNotifications()..pause = Completer<void>();
    final service = LocalReminderService(plugin: plugin);
    final pending = service.sync([
      const MedicineRecord(
        id: 'm',
        name: 'private',
        batches: [BatchRecord(id: 'b', managementExpiryDate: '2099-12-31')],
      ),
    ]);
    await Future<void>.delayed(Duration.zero);
    final disabled = service.disable();
    plugin.pause!.complete();
    await Future.wait([pending, disabled]);
    expect(plugin.bodies, isEmpty);
    expect(service.enabled, false);
  });
  test('identity reset rejects late day schedules and generic bodies omit private data', () async {
    SharedPreferences.setMockInitialValues({
      'home_medicine.local_reminders.enabled': true,
    });
    final plugin = FakeNotifications();
    final service = LocalReminderService(plugin: plugin);
    await service.sync(const []);
    final epoch = service.identityEpoch;
    final schedule = ScheduleDay(
      date: '2099-12-31',
      entries: [
        const ScheduleEntry(
          occurrenceId: 'o',
          planId: 'p',
          careProfileId: 'c',
          careProfileName: 'Private Person',
          medicineName: 'Private Drug',
          dosageText: 'Private Dose',
          time: '09:00',
          status: 'pending',
          receiveDoseReminders: true,
        ),
      ],
    );
    service.setSchedules([schedule], identityEpoch: epoch);
    await service.sync(const []);
    expect(plugin.bodies.values.single, '有一项用药安排待核对，请打开药箱查看。');
    await service.resetForIdentity();
    service.setSchedules([schedule], identityEpoch: epoch);
    await service.sync(const []);
    expect(plugin.bodies, isEmpty);
  });
}
