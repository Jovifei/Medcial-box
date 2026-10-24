import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:home_medicine_flutter/data/api_auth_repository.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/features/auth/device_link_page.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'family_notification_cleanup_test.dart' as h;

// Exercise real auth/client/identity cleanup and actual routing. Only HTTP and
// native notifications are synthetic; no production credentials or writes.
http.Response unselected() => h.jsonResponse({
  'user': {'id': 'synthetic-user', 'hasFamily': true},
  'family': null,
});

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  AndroidFlutterLocalNotificationsPlugin.registerWith();
  const channel = MethodChannel('dexterous.com/flutter/local_notifications');
  late h.NotificationAdapter notifications;
  late MemorySecretStore secrets;
  late MemoryInventoryLocalStore local;

  setUp(() {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    SharedPreferences.setMockInitialValues({
      'home_medicine.local_reminders.enabled': true,
    });
    notifications = h.NotificationAdapter();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, notifications.handle);
    secrets = MemorySecretStore()
      ..values[ApiAuthRepository.accessTokenKey] = 'synthetic-session-a';
    local = MemoryInventoryLocalStore();
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
    debugDefaultTargetPlatformOverride = null;
  });

  test('C2C-02 memberships without selection preserve same-owner drafts but clear projections', () async {
    final services = await h.serviceWith(
      (r) async => r.url.path == '/api/v1/medicines' ? h.inventory() : unselected(),
      secrets: secrets,
      local: local,
    );
    await h.seedFamily(services);
    await services.localStore.saveDraft('owned-b-original', 'B original input');
    final drafts = Map<String, String>.from(local.drafts);
    expect(notifications.pending, isNotEmpty);
    final profile = await services.auth!.getCurrentUser();
    expect(profile.hasFamily, isTrue);
    expect(profile.family, isNull);
    expect(await services.auth!.readAccessToken(), 'synthetic-session-a');
    expect(local.family, isNull);
    expect(local.inventory, isNull);
    expect(services.medicines!.medicines, isEmpty);
    expect(notifications.pending, isEmpty);
    expect(local.drafts, drafts);
    expect(services.api!.identityState!.owner!.familyId, isNull);
    expect(services.familyInvalidated.value, isTrue);
    expect(services.sessionInvalidated.value, isFalse);
  });

  test('C2C-02 stale unselected profile cannot clear a newer selected household', () async {
    final entered = Completer<void>();
    final response = Completer<http.Response>();
    final services = await h.serviceWith((r) async {
      if (r.url.path == '/api/v1/medicines') return h.inventory();
      if (r.url.path == '/api/v1/auth/me') {
        entered.complete();
        return response.future;
      }
      return h.jsonResponse({
        'family': {'id': 'family-b', 'name': 'Synthetic B', 'role': 'member'},
      });
    }, secrets: secrets, local: local);
    await h.seedFamily(services);
    final old = expectLater(services.auth!.getCurrentUser(), throwsA(isA<ApiException>()));
    await entered.future;
    await services.families!.switchFamily('family-b');
    response.complete(unselected());
    await old;
    expect(local.family!.id, 'family-b');
    expect(services.api!.identityState!.owner!.familyId, 'family-b');
    expect(await services.auth!.readAccessToken(), 'synthetic-session-a');
  });

  testWidgets('C2C-02 cold boot enters family choice for legal unselected membership', (tester) async {
    final services = await h.serviceWith((r) async => unselected(), secrets: secrets, local: local);
    final router = GoRouter(routes: [
      GoRoute(path: '/', builder: (_, state) => BootGatePage(services: services)),
      GoRoute(path: '/family-choice', builder: (_, state) => const Scaffold(body: Text('CHOOSER'))),
      GoRoute(path: '/home', builder: (_, state) => const Scaffold(body: Text('UNEXPECTED HOME'))),
      GoRoute(path: '/connect', builder: (_, state) => const Scaffold(body: Text('UNEXPECTED LOGOUT'))),
    ]);
    addTearDown(router.dispose);
    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    await tester.pumpAndSettle();
    expect(find.text('CHOOSER'), findsOneWidget);
    expect(find.text('UNEXPECTED HOME'), findsNothing);
    expect(find.text('UNEXPECTED LOGOUT'), findsNothing);
    expect(await services.auth!.readAccessToken(), 'synthetic-session-a');
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpAndSettle();
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('C2C-02 approved device link reaches chooser, never INVALID_RESPONSE or home', (tester) async {
    secrets = MemorySecretStore();
    var exchanges = 0;
    final services = await h.serviceWith((r) async {
      if (r.url.path == '/api/v1/auth/device-links') {
        return h.jsonResponse({
          'code': '12345678', 'pollToken': 'synthetic-private-poll',
          'expiresAt': '2099-01-01T00:00:00Z',
        });
      }
      if (r.url.path == '/api/v1/auth/device-links/exchange') {
        exchanges++;
        return h.jsonResponse({'state': 'approved', 'token': 'synthetic-linked-session'});
      }
      if (r.url.path == '/api/v1/auth/me') return unselected();
      throw StateError('unexpected test route: ${r.url.path}');
    }, secrets: secrets, local: local);
    final router = GoRouter(routes: [
      GoRoute(path: '/', builder: (_, state) => DeviceLinkPage(services: services)),
      GoRoute(path: '/family-choice', builder: (_, state) => const Scaffold(body: Text('CHOOSER'))),
      GoRoute(path: '/home', builder: (_, state) => const Scaffold(body: Text('UNEXPECTED HOME'))),
    ]);
    addTearDown(router.dispose);
    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    await tester.pumpAndSettle();
    expect(find.text('12345678'), findsOneWidget);
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();
    expect(find.text('CHOOSER'), findsOneWidget);
    expect(find.text('UNEXPECTED HOME'), findsNothing);
    expect(exchanges, 1);
    expect(await services.auth!.readAccessToken(), 'synthetic-linked-session');
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpAndSettle();
    debugDefaultTargetPlatformOverride = null;
  });
}
