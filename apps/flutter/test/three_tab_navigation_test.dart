import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/app.dart';
import 'package:home_medicine_flutter/data/api_auth_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/identity_fixture.dart';

Future<void> _mount(
  WidgetTester tester,
  String location, {
  List<Map<String, Object?>> pending = const [],
  List<Map<String, Object?>> families = const [],
  void Function()? onSwitch,
}) async {
  SharedPreferences.setMockInitialValues({});
  final secrets = MemorySecretStore()
    ..values[ApiAuthRepository.accessTokenKey] = 'synthetic-token';
  final local = MemoryInventoryLocalStore();
  await local.saveFamily(
    FamilyRecord(id: 'family-a', name: '测试家庭', role: 'member'),
  );
  final identity = await identityFixture(secrets, localStore: local);
  await http.runWithClient(
    () async {
      await tester.pumpWidget(
        HomeMedicineApp(
          apiBaseUrl: 'https://medicine.example',
          secretStore: secrets,
          localStore: local,
          identityStore: identity,
          initialLocation: location,
        ),
      );
      await tester.pumpAndSettle();
    },
    () => MockClient((request) async {
      if (request.url.path.endsWith('/switch')) {
        onSwitch?.call();
        return http.Response(
          jsonEncode({
            'error': {'code': 'SWITCH_FAILED', 'message': '切换失败'},
          }),
          500,
          headers: {'content-type': 'application/json'},
        );
      }
      final data = switch (request.url.path) {
        '/api/v1/medicines' => {'medicines': []},
        '/api/v1/families/current' => {
          'family': {
            'id': 'family-a',
            'name': '测试家庭',
            'role': 'member',
            'members': [],
          },
        },
        '/api/v1/families' => {'families': families},
        '/api/v1/notifications/pending' => {'items': pending},
        '/api/v1/families/settings' => {'settings': {}},
        '/api/v1/notification-preferences' => {'channels': []},
        '/api/v1/medication-plans' => {'plans': []},
        '/api/v1/medication-plans/schedule' => {
          'date': '2026-10-27',
          'entries': [],
        },
        _ => <String, Object>{},
      };
      return http.Response(
        jsonEncode(data),
        200,
        headers: {'content-type': 'application/json'},
      );
    }),
  );
}

void main() {
  testWidgets('home exposes only the three primary destinations', (
    tester,
  ) async {
    await _mount(tester, '/home');
    final bar = tester.widget<NavigationBar>(find.byType(NavigationBar));
    expect(bar.destinations.length, 3);
    expect(bar.selectedIndex, 0);
    expect(find.text('录入第一种药'), findsNothing);
    expect(find.widgetWithText(FloatingActionButton, '录入'), findsOneWidget);
  });

  testWidgets('old my link selects the third destination', (tester) async {
    await _mount(tester, '/home?tab=my');
    expect(
      tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex,
      2,
    );
    expect(find.text('我的'), findsWidgets);
  });

  testWidgets('old pending link opens attention inside the cabinet', (
    tester,
  ) async {
    await _mount(tester, '/home?tab=pending');
    expect(
      tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex,
      0,
    );
    expect(find.text('待处理事项'), findsOneWidget);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('待处理事项'), findsNothing);
    expect(find.text('JF小药箱'), findsOneWidget);
  });

  testWidgets(
    'attention counts unique medicines and keeps cabinet stocktake separate',
    (tester) async {
      await _mount(
        tester,
        '/home',
        pending: [
          {
            'type': 'expired',
            'medicineId': 'a',
            'medicineName': '药甲',
            'message': '甲已过期',
            'action': 'edit_batch',
          },
          {
            'type': 'low_stock',
            'medicineId': 'a',
            'medicineName': '药甲',
            'message': '甲库存不足',
            'action': 'restock',
          },
          {
            'type': 'needs_check',
            'medicineId': 'b',
            'medicineName': '药乙',
            'message': '乙日期待核对',
            'action': 'edit_batch',
          },
          {
            'type': 'stocktake_due',
            'medicineId': null,
            'medicineName': '家庭药箱',
            'message': '已到盘点时间',
            'action': 'stocktake',
          },
          {
            'type': 'leaflet_missing',
            'medicineId': 'c',
            'medicineName': '药丙',
            'message': '资料待补充',
            'action': 'review_leaflet',
          },
        ],
      );
      expect(find.text('需关注 2 种 · 药箱盘点'), findsOneWidget);
      await tester.tap(find.text('需关注 2 种 · 药箱盘点'));
      await tester.pumpAndSettle();
      expect(find.text('甲已过期'), findsOneWidget);
      expect(find.text('甲库存不足'), findsOneWidget);
      expect(find.text('乙日期待核对'), findsOneWidget);
      expect(find.text('已到盘点时间'), findsOneWidget);
      expect(find.text('资料待补充'), findsNothing);
    },
  );

  testWidgets('returning from attention refreshes the cabinet summary', (tester) async {
    final pending = <Map<String, Object?>>[
      {'type': 'expired', 'medicineId': 'a', 'medicineName': '药甲', 'message': '甲已过期', 'action': 'edit_batch'},
    ];
    await _mount(tester, '/home', pending: pending);
    await tester.tap(find.text('需关注 1 种'));
    await tester.pumpAndSettle();
    pending.clear();
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    expect(find.text('需关注 1 种'), findsNothing);
  });

  testWidgets('plans show today first and switch to the full list in place', (
    tester,
  ) async {
    await _mount(tester, '/home?tab=plans');
    expect(find.text('今日安排'), findsOneWidget);
    expect(find.text('我的用药计划'), findsNothing);
    await tester.tap(find.text('全部计划'));
    await tester.pumpAndSettle();
    expect(find.text('我的用药计划'), findsOneWidget);
    expect(find.text('今日安排'), findsNothing);
  });

  testWidgets('cabinet remains usable at 320 width with double-sized text', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 800);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.reset);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await _mount(tester, '/home');
    expect(find.widgetWithText(FloatingActionButton, '录入'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('my page groups tools and data without hiding their actions', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await _mount(tester, '/home?tab=my');
    expect(find.text('家庭管理'), findsOneWidget);
    expect(find.text('切换、创建或加入家庭'), findsNothing);
    await tester.tap(find.text('家庭管理'));
    await tester.pumpAndSettle();
    expect(find.text('切换、创建或加入家庭'), findsOneWidget);
    expect(find.text('用药的人'), findsOneWidget);
    await tester.tap(find.text('药箱工具'));
    await tester.pumpAndSettle();
    expect(find.text('补货清单'), findsOneWidget);
    await tester.tap(find.text('数据管理'));
    await tester.pumpAndSettle();
    expect(find.text('备份与恢复'), findsOneWidget);
  });

  testWidgets(
    'family management contains switching and a failed switch preserves the current family',
    (tester) async {
      var switches = 0;
      await _mount(
        tester,
        '/home',
        families: [
          {
            'familyId': 'family-a',
            'name': '测试家庭',
            'role': 'member',
            'isCurrent': true,
          },
          {
            'familyId': 'family-b',
            'name': '第二家庭',
            'role': 'owner',
            'isCurrent': false,
          },
        ],
        onSwitch: () => switches++,
      );
      await tester.tap(find.text('测试家庭'));
      await tester.pumpAndSettle();
      expect(tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex, 2);
      expect(find.text('家庭管理'), findsOneWidget);
      expect(find.text('切换、创建或加入家庭'), findsOneWidget);
      expect(find.text('第二家庭'), findsNothing);
      await tester.tap(find.text('家庭管理'));
      await tester.pumpAndSettle();
      expect(find.text('切换、创建或加入家庭'), findsNothing);
      await tester.tap(find.text('药箱'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('测试家庭'));
      await tester.pumpAndSettle();
      expect(find.text('切换、创建或加入家庭'), findsOneWidget);
      await tester.tap(find.text('切换、创建或加入家庭'));
      await tester.pumpAndSettle();
      expect(find.text('第二家庭'), findsOneWidget);
      await tester.tap(find.text('测试家庭'));
      await tester.pumpAndSettle();
      expect(switches, 0);
      await tester.tap(find.text('切换、创建或加入家庭'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('第二家庭'));
      await tester.pumpAndSettle();
      expect(switches, 1);
      expect(find.text('先选择你的家庭'), findsOneWidget);
      expect(find.text('切换失败'), findsOneWidget);
      await tester.tap(find.byType(BackButton));
      await tester.pumpAndSettle();
      expect(find.text('测试家庭'), findsOneWidget);
      expect(find.text('切换、创建或加入家庭'), findsOneWidget);
    },
  );

  testWidgets('family management deep link opens the management group', (tester) async {
    await _mount(tester, '/home?tab=my&section=family');
    expect(tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex, 2);
    expect(find.text('切换、创建或加入家庭'), findsOneWidget);
  });
}
