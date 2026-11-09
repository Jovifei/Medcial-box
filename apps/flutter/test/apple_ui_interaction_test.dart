// Production widgets with synthetic API responses. Optional PNG output records
// host-engine rendering; it is not a device, signing or service acceptance test.
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/core/theme/app_theme.dart';
import 'package:home_medicine_flutter/core/widgets/apple_list_row.dart';
import 'package:home_medicine_flutter/data/api_auth_repository.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/api_plan_repository.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/features/home/production_shell.dart';
import 'package:home_medicine_flutter/features/plan/plans_page.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'support/chinese_font_fixture.dart';

const _captureKey = ValueKey('apple-ui-capture');
const _output = String.fromEnvironment('APPLE_UI_OUTPUT');

http.Response _json(Object value, [int status = 200]) => http.Response.bytes(
  utf8.encode(jsonEncode(value)),
  status,
  headers: {'content-type': 'application/json'},
);

class _CabinetFixture {
  bool familyUnavailable = false;
  int familyReads = 0;
  late final ApiClient api = ApiClient(
    baseUrl: 'https://synthetic.invalid',
    tokenProvider: () async => 'synthetic-token',
    client: MockClient((request) async {
      switch (request.url.path) {
        case '/api/v1/families/current':
          familyReads++;
          if (familyUnavailable) {
            return _json({
              'error': {'code': 'UNAVAILABLE', 'message': '暂时无法同步家庭'},
            }, 503);
          }
          return _json({
            'family': {'id': 'family-a', 'name': '小家的药箱', 'role': 'owner'},
          });
        case '/api/v1/notifications/pending':
          return _json({
            'items': [
              {'type': 'low_stock', 'medicineId': 'low'},
            ],
          });
        case '/api/v1/medicines':
          return _json({
            'medicines': [
              _medicine('normal', '合成常备药品', 'normal', knownDate: true),
              _medicine('low', '合成库存不足药品', 'low', knownDate: true),
              _medicine('unknown', '合成很长药品名称用于验证大字号完整阅读', 'normal'),
            ],
          });
        default:
          throw StateError('Unexpected synthetic request ${request.url}');
      }
    }),
  );
  final store = MemoryInventoryLocalStore();
  late final medicines = ApiMedicineRepository(api: api, localStore: store);

  Widget get page => CabinetHomePage(
    repository: medicines,
    familyRepository: ApiFamilyRepository(api: api, localStore: store),
    workflow: ApiWorkflowRepository(api: api),
  );

  Map<String, Object?> _medicine(
    String id,
    String name,
    String stock, {
    bool knownDate = false,
  }) => {
    'id': id,
    'name': name,
    'specification': '合成规格 20 粒 / 盒',
    'manufacturer': '合成厂家',
    'activeIngredients': ['合成成分'],
    'leaflet': {'reviewStatus': 'verified'},
    'stockStatus': {'state': stock},
    'expiryState': {'state': knownDate ? 'normal' : 'unknown'},
    'batches': [
      {
        'id': 'batch-$id',
        'quantity': 1,
        'unit': 'box',
        'storageLocation': '客厅药箱',
        if (knownDate) 'expiry': {'value': '2027-12-31', 'precision': 'day'},
        if (knownDate) 'managementExpiryDate': '2027-12-31',
        'managementExpiryState': {'state': knownDate ? 'normal' : 'unknown'},
      },
    ],
  };
}

Future<void> _mount(
  WidgetTester tester,
  Widget page, {
  double width = 390,
  double scale = 1,
  Brightness brightness = Brightness.light,
}) async {
  tester.view.physicalSize = Size(width, 844);
  tester.view.devicePixelRatio = 1;
  tester.platformDispatcher.textScaleFactorTestValue = scale;
  tester.platformDispatcher.platformBrightnessTestValue = brightness;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
  await tester.pumpWidget(
    RepaintBoundary(
      key: _captureKey,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: appTheme(brightness: brightness),
        builder: (context, child) => CupertinoTheme(
          data: cupertinoTheme(brightness: brightness),
          child: child!,
        ),
        home: Scaffold(
          backgroundColor: appTheme(brightness: brightness)
              .scaffoldBackgroundColor,
          body: page,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  expect(tester.takeException(), isNull);
}

Future<void> _capture(WidgetTester tester, String name) async {
  if (_output.isEmpty) return;
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    find.byKey(_captureKey),
  );
  await tester.runAsync(() async {
    final image = await boundary.toImage(pixelRatio: 2);
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    final file = File('$_output/$name.png');
    await file.parent.create(recursive: true);
    await file.writeAsBytes(data!.buffer.asUint8List());
    image.dispose();
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    // Cupertino font family names are provided by the native platform in an
    // installed app. The host renderer needs explicit fixture aliases.
    for (final family in [
      'sans',
      'CupertinoSystemText',
      'CupertinoSystemDisplay',
      '.SF UI Text',
      '.SF UI Display',
    ]) {
      await (FontLoader(family)..addFont(loadChineseFontFixture())).load();
    }
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    await (FontLoader('packages/cupertino_icons/CupertinoIcons')..addFont(
          rootBundle.load('packages/cupertino_icons/assets/CupertinoIcons.ttf'),
        ))
        .load();
  });

  testWidgets(
    'active conditions explain actual results and clearing restores the cabinet',
    (tester) async {
      final fixture = _CabinetFixture();
      addTearDown(fixture.api.close);
      await _mount(tester, fixture.page);
      expect(find.text('共 3 种 · 到期优先'), findsOneWidget);
      expect(find.text('日期待补充'), findsOneWidget);
      await _capture(tester, '01-cabinet-390');
      await tester.enterText(find.byType(CupertinoSearchTextField), '客厅');
      await tester.pumpAndSettle();
      expect(find.text('显示 3 / 3 种 · 到期优先'), findsOneWidget);
      await tester.tap(find.byTooltip('筛选与排序'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(AppleListRow, '库存不足'));
      await tester.tap(find.text('完成'));
      await tester.pumpAndSettle();
      expect(find.text('搜索“客厅” · 库存不足'), findsOneWidget);
      expect(find.text('显示 1 / 3 种 · 到期优先'), findsOneWidget);
      expect(find.text('合成库存不足药品'), findsOneWidget);
      expect(find.text('合成常备药品'), findsNothing);
      await tester.tap(find.byKey(const Key('cabinet-clear-filters')));
      await tester.pumpAndSettle();
      expect(find.text('共 3 种 · 到期优先'), findsOneWidget);
      expect(find.text('合成常备药品'), findsOneWidget);
      expect(
        tester
            .widget<CupertinoSearchTextField>(
              find.byType(CupertinoSearchTextField),
            )
            .controller!
            .text,
        isEmpty,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'narrow 200 percent text keeps filters operable without overflow',
    (tester) async {
      final fixture = _CabinetFixture();
      addTearDown(fixture.api.close);
      await _mount(tester, fixture.page, width: 320, scale: 2);
      await tester.tap(find.byTooltip('筛选与排序'));
      await tester.pumpAndSettle();
      await _capture(tester, '02-filter-320-text200');
      final unknown = find.widgetWithText(AppleListRow, '数量/日期未知');
      await tester.ensureVisible(unknown);
      await tester.tap(unknown);
      await tester.pumpAndSettle();
      final done = find.widgetWithText(CupertinoButton, '完成');
      expect(tester.getSize(done).height, greaterThanOrEqualTo(48));
      await tester.tap(done);
      await tester.pumpAndSettle();
      expect(find.text('显示 1 / 3 种 · 到期优先'), findsOneWidget);
      await tester.tap(find.byKey(const Key('cabinet-clear-filters')));
      await tester.pumpAndSettle();
      expect(find.text('共 3 种 · 到期优先'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'refresh failure preserves inventory and exposes a working retry',
    (tester) async {
      final fixture = _CabinetFixture();
      addTearDown(fixture.api.close);
      await _mount(tester, fixture.page);
      fixture.familyUnavailable = true;
      final refresh = tester
          .state<RefreshIndicatorState>(find.byType(RefreshIndicator))
          .show();
      await tester.pumpAndSettle();
      await refresh;
      expect(find.text('暂时无法更新，正在显示上次读取的药箱。'), findsOneWidget);
      expect(find.text('还没有记录药品'), findsNothing);
      expect(fixture.medicines.medicines.length, 3);
      fixture.familyUnavailable = false;
      await tester.tap(find.text('重新加载'));
      await tester.pumpAndSettle();
      expect(fixture.familyReads, 3);
      expect(find.text('暂时无法同步家庭'), findsNothing);
      expect(find.text('合成常备药品'), findsOneWidget);
    },
  );

  testWidgets(
    'settings rows wrap instructions and long actions at 200 percent',
    (tester) async {
      var taps = 0;
      await _mount(
        tester,
        Scaffold(
          body: SafeArea(
            child: ListView(
              children: [
                CupertinoListSection.insetGrouped(
                  children: [
                    AppleListRow(
                      leading: const Icon(CupertinoIcons.house),
                      title: const Text('切换、创建或加入家庭'),
                      subtitle: const Text('选择家庭后，只显示该家庭的药品和成员。'),
                      trailing: const CupertinoListTileChevron(),
                      onTap: () => taps++,
                    ),
                    AppleListRow(
                      title: const Text('Android App · 已登录设备'),
                      subtitle: const Text('可撤销此设备的授权'),
                      trailing: CupertinoButton(
                        minimumSize: const Size(48, 48),
                        onPressed: () => taps++,
                        child: const Text('撤销授权'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
        width: 320,
        scale: 2,
        brightness: Brightness.dark,
      );
      await tester.tap(find.text('切换、创建或加入家庭'));
      await tester.ensureVisible(find.text('撤销授权'));
      await tester.tap(find.text('撤销授权'));
      await tester.pumpAndSettle();
      expect(taps, 2);
      for (final element in find.byType(RichText).evaluate()) {
        final render = element.renderObject;
        if (render is RenderParagraph) {
          expect(render.didExceedMaxLines, isFalse);
        }
      }
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('failed plan load cannot masquerade as an empty plan list', (
    tester,
  ) async {
    var unavailable = true;
    var scheduleReads = 0;
    final api = ApiClient(
      baseUrl: 'https://synthetic.invalid',
      tokenProvider: () async => 'synthetic-token',
      client: MockClient((request) async {
        if (request.url.path.endsWith('/schedule')) {
          scheduleReads++;
          return unavailable
              ? _json({
                  'error': {'code': 'UNAVAILABLE', 'message': '安排暂不可用'},
                }, 503)
              : _json({
                  'date': '2026-11-09',
                  'entries': [
                    {
                      'occurrenceId': 'synthetic-dose',
                      'planId': 'synthetic-plan',
                      'careProfileId': 'synthetic-profile',
                      'careProfileName': '家人 A',
                      'medicineName': '合成药品计划',
                      'dosageText': '按已核对的计划记录',
                      'time': '08:30',
                      'status': 'pending',
                    },
                  ],
                });
        }
        return _json({'plans': []});
      }),
    );
    addTearDown(api.close);
    final repository = ApiPlanRepository(api: api);
    addTearDown(repository.dispose);
    await _mount(
      tester,
      PlansPage(repository: repository),
      brightness: Brightness.dark,
    );
    await tester.tap(find.text('全部计划'));
    await tester.pumpAndSettle();
    expect(find.textContaining('还没有用药计划'), findsNothing);
    expect(find.text('安排暂不可用'), findsOneWidget);
    unavailable = false;
    await tester.tap(find.text('重新加载安排'));
    await tester.pumpAndSettle();
    expect(scheduleReads, 2);
    expect(find.text('安排暂不可用'), findsNothing);
    expect(find.textContaining('还没有用药计划'), findsOneWidget);
    await tester.tap(find.text('今天'));
    await tester.pumpAndSettle();
    expect(find.text('待确认 1 次 · 已记录 0 次'), findsOneWidget);
    await _capture(tester, '03-plans-dark-390');
    expect(tester.takeException(), isNull);
  });
}
