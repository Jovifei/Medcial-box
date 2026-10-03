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
  final Map<int, String?> titles = {};
  final Map<int, String?> payloads = {};
  Completer<void>? pause;
  String? launchPayload;
  DidReceiveNotificationResponseCallback? callback;
  @override
  Future<bool?> initialize({
    required InitializationSettings settings,
    DidReceiveNotificationResponseCallback? onDidReceiveNotificationResponse,
    DidReceiveBackgroundNotificationResponseCallback?
    onDidReceiveBackgroundNotificationResponse,
  }) async {
    callback = onDidReceiveNotificationResponse;
    return true;
  }

  @override
  Future<NotificationAppLaunchDetails?>
  getNotificationAppLaunchDetails() async => launchPayload == null
      ? null
      : NotificationAppLaunchDetails(
          true,
          notificationResponse: NotificationResponse(
            notificationResponseType:
                NotificationResponseType.selectedNotification,
            payload: launchPayload,
          ),
        );

  @override
  Future<void> cancelAll() async {
    bodies.clear();
    titles.clear();
    payloads.clear();
  }

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
    titles[id] = title;
    payloads[id] = payload;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  test('identity reset ignores a plugin cold launch callback even with a bound handler', () async {
    SharedPreferences.setMockInitialValues({});
    final plugin = FakeNotifications()..launchPayload = 'dose:former-account';
    final received = <String?>[];
    final service = LocalReminderService(
      plugin: plugin,
      onNotificationTap: received.add,
    );
    await service.resetForIdentity();
    expect(received, isEmpty);
  });

  test(
    'cold plugin launch and foreground callback use the same buffered handler',
    () async {
      SharedPreferences.setMockInitialValues({});
      final plugin = FakeNotifications()..launchPayload = 'dose:synthetic';
      final service = LocalReminderService(plugin: plugin);
      await service.sync(const []);
      final received = <String?>[];
      service.onNotificationTap = received.add;
      service.onNotificationTap = received.add;
      plugin.callback!(
        const NotificationResponse(
          notificationResponseType:
              NotificationResponseType.selectedNotification,
          payload: 'pending',
        ),
      );
      expect(received, ['dose:synthetic', 'pending']);
    },
  );

  test(
    'revoking care reception removes only dose alarms and retains stock alarms',
    () async {
      SharedPreferences.setMockInitialValues({
        'home_medicine.local_reminders.enabled': true,
      });
      final plugin = FakeNotifications();
      final service = LocalReminderService(plugin: plugin);
      const medicines = [
        MedicineRecord(
          id: 'm',
          name: 'Private drug',
          batches: [BatchRecord(id: 'b', managementExpiryDate: '2099-12-31')],
        ),
      ];
      await service.sync(medicines);
      final stockIds = plugin.payloads.keys.toSet();
      expect(stockIds.length, 4);
      await service.setSchedules(const [
        DoseReminderEntry(
          occurrenceId: 'opaque',
          date: '2099-12-31',
          time: '09:00',
        ),
      ], identityEpoch: service.identityEpoch);
      expect(plugin.payloads.length, 5);
      await service.setSchedules(
        const [],
        identityEpoch: service.identityEpoch,
      );
      expect(plugin.payloads.keys.toSet(), stockIds);
      expect(plugin.payloads.values.toSet(), {'pending'});
      expect(service.enabled, isTrue);
      await service.disable();
      expect(plugin.payloads, isEmpty);
    },
  );

  test(
    'local permission opt-out never schedules generic receive-only occurrences',
    () async {
      SharedPreferences.setMockInitialValues({});
      final plugin = FakeNotifications();
      final service = LocalReminderService(plugin: plugin);
      await service.setSchedules(const [
        DoseReminderEntry(
          occurrenceId: 'opaque',
          date: '2099-12-31',
          time: '09:00',
        ),
      ], identityEpoch: service.identityEpoch);
      await service.sync(const []);
      expect(plugin.payloads, isEmpty);
    },
  );

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
    const schedule = DoseReminderEntry(
      occurrenceId: '11111111-1111-4111-8111-111111111111',
      date: '2099-12-31',
      time: '09:00',
    );
    service.setSchedules([schedule], identityEpoch: epoch);
    await service.sync(const []);
    expect(plugin.titles.values.single, '用药安排提醒');
    expect(plugin.bodies.values.single, '有一项用药安排待核对，请打开药箱查看。');
    expect(
      plugin.payloads.values.single,
      'dose-occurrence:v1:2099-12-31:11111111-1111-4111-8111-111111111111',
    );
    await service.resetForIdentity();
    service.setSchedules([schedule], identityEpoch: epoch);
    await service.sync(const []);
    expect(plugin.bodies, isEmpty);
  });
}
