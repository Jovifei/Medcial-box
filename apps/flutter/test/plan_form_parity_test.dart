import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:home_medicine_flutter/core/widgets/app_surfaces.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_plan_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/features/plan/plan_form_page.dart';

http.Response jsonResponse(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status);

class FormStore extends MemoryInventoryLocalStore {
  bool failOrdinaryDelete = false;
  bool failOrdinarySave = false;
  @override
  Future<void> deleteDraft(String key) async {
    if (failOrdinaryDelete && key.startsWith('plan-form.')) {
      throw StateError('synthetic ordinary delete failure');
    }
    await super.deleteDraft(key);
  }

  @override
  Future<void> saveDraft(String key, String value) async {
    if (failOrdinarySave && key.startsWith('plan-form.')) {
      throw StateError('synthetic ordinary save failure');
    }
    await super.saveDraft(key, value);
  }
}

class FormHarness {
  FormHarness({LocalAppStore? store}) {
    local = store ?? MemoryInventoryLocalStore();
    api = ApiClient(
      baseUrl: 'https://form.synthetic.invalid',
      tokenProvider: () async => 'synthetic',
      client: MockClient((r) async {
        if (r.url.path == '/api/v1/auth/me') {
          if (offline) throw http.ClientException('synthetic offline');
          return jsonResponse({
            'user': {'id': user, 'hasFamily': true},
            'family': {'id': family},
          });
        }
        if (r.url.path == '/api/v1/care-profiles') {
          return jsonResponse({'careProfiles': profiles});
        }
        if (r.url.path == '/api/v1/medicines') {
          return await inventoryGate?.future ??
              jsonResponse({'medicines': inventory});
        }
        if (r.method == 'GET' &&
            r.url.path == '/api/v1/medication-plans/plan-a') {
          return jsonResponse({'canManage': canManage, 'plan': plan});
        }
        if (r.method == 'POST' || r.method == 'PUT') {
          writes.add(jsonDecode(r.body) as Map<String, dynamic>);
          if (writeGate != null) return await writeGate!.future;
          if (writeResponse != null) return writeResponse!;
          return jsonResponse({
            'planId': 'plan-a',
            'careProfileId': 'profile-a',
            'status': 'active',
            'version': r.method == 'POST' ? 1 : 2,
          }, r.method == 'POST' ? 201 : 200);
        }
        throw StateError('Unexpected ${r.method} ${r.url}');
      }),
    );
    repo = ApiPlanRepository(api: api, localStore: local);
  }
  late final ApiClient api;
  late final ApiPlanRepository repo;
  late final LocalAppStore local;
  String user = 'user-a';
  String family = 'family-a';
  bool canManage = true;
  bool offline = false;
  List<Map<String, Object?>> profiles = [
    {'id': 'profile-a', 'displayName': 'Synthetic person', 'canManage': true},
  ];
  List<Map<String, Object?>> inventory = [
    {'id': 'medicine-a', 'name': 'Inventory medicine', 'batches': []},
  ];
  Map<String, Object?> plan = {
    'id': 'plan-a',
    'careProfileId': 'profile-a',
    'medicineId': 'medicine-a',
    'medicineName': 'Inventory medicine',
    'dosageText': 'Explicit dose',
    'weekdays': ['mon', 'wed'],
    'startDate': '2026-10-03',
    'status': 'active',
    'version': 1,
    'timeSlots': ['09:00'],
  };
  Completer<http.Response>? inventoryGate;
  Completer<http.Response>? writeGate;
  http.Response? writeResponse;
  final writes = <Map<String, dynamic>>[];
}

Future<GoRouter> mountForm(
  WidgetTester tester,
  FormHarness h, {
  bool edit = false,
  Size size = const Size(900, 1500),
  double scale = 1,
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (_, _) => const Scaffold(body: Text('Destination')),
        routes: [
          GoRoute(
            path: 'form',
            builder: (_, _) => PlanFormPage(
              repository: h.repo,
              planId: edit ? 'plan-a' : null,
            ),
          ),
          GoRoute(
            path: 'other',
            builder: (_, _) => const Scaffold(body: Text('Other page')),
          ),
        ],
      ),
    ],
  );
  await tester.pumpWidget(
    MaterialApp.router(
      routerConfig: router,
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(scale)),
        child: child!,
      ),
    ),
  );
  router.push('/form');
  await tester.pumpAndSettle();
  return router;
}

Future<void> tapText(WidgetTester tester, String text) async {
  if (find.text(text).evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      find.text(text),
      180,
      scrollable: find.byType(Scrollable).first,
    );
  }
  final chips = find.widgetWithText(FilterChip, text);
  final choices = find.widgetWithText(ChoiceChip, text);
  final target = chips.evaluate().isNotEmpty
      ? chips.last
      : (choices.evaluate().isNotEmpty ? choices.last : find.text(text).last);
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
  await tester.tap(target);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'weekday sheet applies real tokens and cancel preserves edit values',
    (tester) async {
      final h = FormHarness();
      final router = await mountForm(tester, h, edit: true);
      await tapText(tester, '每周一、三');
      await tapText(tester, '周二');
      await tapText(tester, '取消');
      expect(find.text('每周一、三'), findsOneWidget);
      await tapText(tester, '每周一、三');
      await tapText(tester, '周二');
      await tapText(tester, '应用');
      await tapText(tester, '保存修改');
      expect(h.writes.single['weekdays'], ['mon', 'tue', 'wed']);
      router.dispose();
    },
  );

  testWidgets('inventory chooser binds identity and manual name detaches it', (
    tester,
  ) async {
    final h = FormHarness();
    final router = await mountForm(tester, h, edit: true);
    await tapText(tester, '从药箱选择');
    await tapText(tester, 'Inventory medicine');
    expect(find.text('已关联药箱记录'), findsOneWidget);
    await tester.enterText(find.byType(TextField).first, 'Manual replacement');
    await tester.pumpAndSettle();
    await tapText(tester, '保存修改');
    expect(h.writes.single['medicineId'], isNull);
    expect(h.writes.single['medicineName'], 'Manual replacement');
    router.dispose();
  });

  testWidgets('view-only profile cannot edit or submit', (tester) async {
    final h = FormHarness()..canManage = false;
    final router = await mountForm(tester, h, edit: true);
    expect(
      tester.widget<TextField>(find.byType(TextField).first).enabled,
      false,
    );
    expect(
      tester.widget<PrimaryButton>(find.byType(PrimaryButton)).onPressed,
      isNull,
    );
    expect(h.writes, isEmpty);
    router.dispose();
  });
  test(
    'Shanghai calendar date handles UTC midnight, month and year boundaries',
    () {
      expect(
        planFormShanghaiDate(DateTime.parse('2026-10-03T15:59:59Z')),
        '2026-10-03',
      );
      expect(
        planFormShanghaiDate(DateTime.parse('2026-10-03T16:00:00Z')),
        '2026-10-04',
      );
      expect(
        planFormShanghaiDate(DateTime.parse('2026-12-31T16:00:00Z')),
        '2027-01-01',
      );
      expect(
        planFormShanghaiDate(DateTime.parse('2028-02-28T16:00:00Z')),
        '2028-02-29',
      );
    },
  );

  testWidgets(
    'custom schedule requires one day and daily sends all server tokens',
    (tester) async {
      final h = FormHarness();
      final router = await mountForm(tester, h, edit: true);
      await tapText(tester, '每周一、三');
      await tapText(tester, '周一');
      await tapText(tester, '周三');
      await tapText(tester, '应用');
      expect(find.text('请至少选择一天'), findsOneWidget);
      await tapText(tester, '每天');
      await tapText(tester, '应用');
      await tapText(tester, '保存修改');
      expect(h.writes.single['weekdays'], [
        'mon',
        'tue',
        'wed',
        'thu',
        'fri',
        'sat',
        'sun',
      ]);
      router.dispose();
    },
  );

  testWidgets(
    'inventory selection carries stable ID without inferring dose or time',
    (tester) async {
      final h = FormHarness();
      h.inventory = [
        {'id': 'medicine-b', 'name': 'Chosen inventory', 'batches': []},
      ];
      final router = await mountForm(tester, h, edit: true);
      await tapText(tester, '从药箱选择');
      await tapText(tester, 'Chosen inventory');
      expect(find.text('Explicit dose'), findsOneWidget);
      expect(find.text('09:00'), findsOneWidget);
      await tapText(tester, '保存修改');
      expect(h.writes.single['medicineId'], 'medicine-b');
      expect(h.writes.single['medicineName'], 'Chosen inventory');
      expect(h.writes.single['dosageText'], 'Explicit dose');
      expect(h.writes.single['timeSlots'], ['09:00']);
      router.dispose();
    },
  );

  testWidgets(
    'unrelated edit preserves historical deleted inventory binding by omission',
    (tester) async {
      final h = FormHarness()..inventory = [];
      final router = await mountForm(tester, h, edit: true);
      await tester.enterText(
        find.byType(TextField).at(1),
        'Revised explicit dose',
      );
      await tester.pumpAndSettle();
      await tapText(tester, '保存修改');
      expect(h.writes.single.containsKey('medicineId'), false);
      expect(h.writes.single['dosageText'], 'Revised explicit dose');
      router.dispose();
    },
  );

  testWidgets(
    'new explicit binding deleted before submit requires unlink or reselect',
    (tester) async {
      final h = FormHarness();
      final router = await mountForm(tester, h, edit: true);
      await tapText(tester, '从药箱选择');
      await tapText(tester, 'Inventory medicine');
      h.inventory = [];
      await tapText(tester, '保存修改');
      expect(h.writes, isEmpty);
      expect(find.text('关联药品已不在当前药箱，请重新选择或解除关联后再保存。'), findsOneWidget);
      await tapText(tester, '解除药箱关联');
      await tapText(tester, '保存修改');
      expect(h.writes.single['medicineId'], isNull);
      expect(h.writes.single.containsKey('medicineId'), true);
      router.dispose();
    },
  );

  testWidgets(
    'revoked current management stops preflight write and locks inputs',
    (tester) async {
      final h = FormHarness();
      final router = await mountForm(tester, h, edit: true);
      h.profiles = [
        {
          'id': 'profile-a',
          'displayName': 'Synthetic person',
          'canManage': false,
        },
      ];
      await tapText(tester, '保存修改');
      expect(h.writes, isEmpty);
      expect(
        tester.widget<TextField>(find.byType(TextField).first).enabled,
        false,
      );
      router.dispose();
    },
  );

  testWidgets(
    'late inventory after identity change cannot show or bind old records',
    (tester) async {
      final h = FormHarness();
      final router = await mountForm(tester, h);
      h.inventoryGate = Completer<http.Response>();
      await tester.tap(find.text('从药箱选择'));
      await tester.pump();
      h.api.invalidateIdentity();
      h.inventoryGate!.complete(jsonResponse({'medicines': h.inventory}));
      await tester.pumpAndSettle();
      expect(find.text('选择药箱记录'), findsNothing);
      expect(find.text('Inventory medicine'), findsNothing);
      expect(h.writes, isEmpty);
      router.dispose();
    },
  );

  testWidgets(
    'late inventory after newer navigation cannot cover the new page',
    (tester) async {
      final h = FormHarness();
      final router = await mountForm(tester, h);
      h.inventoryGate = Completer<http.Response>();
      await tester.tap(find.text('从药箱选择'));
      await tester.pump();
      router.push('/other');
      await tester.pumpAndSettle();
      h.inventoryGate!.complete(jsonResponse({'medicines': h.inventory}));
      await tester.pumpAndSettle();
      expect(find.text('Other page'), findsOneWidget);
      expect(find.text('选择药箱记录'), findsNothing);
      router.dispose();
    },
  );

  testWidgets(
    'ordinary draft needs explicit restoration after app-style recreation',
    (tester) async {
      final store = MemoryInventoryLocalStore();
      final h = FormHarness(store: store);
      final router = await mountForm(tester, h);
      await tester.enterText(
        find.byType(TextField).first,
        'Unsaved draft name',
      );
      await tester.enterText(
        find.byType(TextField).at(1),
        'Unsaved draft dose',
      );
      await tester.pumpAndSettle();
      router.go('/other');
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      router.dispose();
      final next = FormHarness(store: store);
      final restarted = await mountForm(tester, next);
      expect(find.text('恢复草稿'), findsOneWidget);
      expect(find.text('Unsaved draft name'), findsNothing);
      expect(next.writes, isEmpty);
      await tapText(tester, '恢复草稿');
      expect(find.text('Unsaved draft name'), findsOneWidget);
      expect(find.text('Unsaved draft dose'), findsOneWidget);
      expect(next.writes, isEmpty);
      restarted.dispose();
    },
  );

  testWidgets('back keep, cancel and discard are explicit and do not submit', (
    tester,
  ) async {
    final h = FormHarness();
    final router = await mountForm(tester, h);
    await tester.enterText(find.byType(TextField).first, 'Back draft');
    await tester.pumpAndSettle();
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tapText(tester, '继续编辑');
    expect(find.text('Back draft'), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tapText(tester, '保留并离开');
    expect(find.text('Destination'), findsOneWidget);
    router.push('/form');
    await tester.pumpAndSettle();
    await tapText(tester, '恢复草稿');
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tapText(tester, '丢弃并离开');
    router.push('/form');
    await tester.pumpAndSettle();
    expect(find.text('恢复草稿'), findsNothing);
    expect(find.text('Back draft'), findsNothing);
    expect(h.writes, isEmpty);
    router.dispose();
  });

  testWidgets(
    'restored edit preserves old version and explicit conflict review retains input',
    (tester) async {
      final store = MemoryInventoryLocalStore();
      final h = FormHarness(store: store);
      final router = await mountForm(tester, h, edit: true);
      await tester.enterText(find.byType(TextField).at(1), 'My retained dose');
      await tester.pumpAndSettle();
      router.go('/other');
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      router.dispose();
      final next = FormHarness(store: store);
      next.plan = {...next.plan, 'version': 3, 'dosageText': 'New server dose'};
      final restarted = await mountForm(tester, next, edit: true);
      await tapText(tester, '恢复草稿');
      expect(find.text('My retained dose'), findsOneWidget);
      expect(
        tester.widget<PrimaryButton>(find.byType(PrimaryButton)).onPressed,
        isNull,
      );
      await tapText(tester, '核对最新计划');
      await tapText(tester, '取消');
      expect(find.text('My retained dose'), findsOneWidget);
      await tapText(tester, '核对最新计划');
      await tapText(tester, '已核对，保留输入');
      await tapText(tester, '保存修改');
      expect(next.writes.single['version'], 3);
      expect(next.writes.single['dosageText'], 'My retained dose');
      restarted.dispose();
    },
  );

  testWidgets('409 preserves input until separate current-version review', (
    tester,
  ) async {
    final h = FormHarness();
    final router = await mountForm(tester, h, edit: true);
    await tester.enterText(find.byType(TextField).at(1), 'Conflict dose');
    await tester.pumpAndSettle();
    h.writeResponse = jsonResponse({
      'error': {'code': 'VERSION_CONFLICT', 'message': 'Synthetic conflict'},
    }, 409);
    await tapText(tester, '保存修改');
    expect(find.text('Conflict dose'), findsOneWidget);
    expect(h.writes.length, 1);
    expect(find.text('核对最新计划'), findsOneWidget);
    h.plan = {...h.plan, 'version': 2, 'dosageText': 'Newer server dose'};
    await tapText(tester, '核对最新计划');
    await tapText(tester, '采用最新内容');
    expect(find.text('Newer server dose'), findsOneWidget);
    expect(h.writes.length, 1);
    h.writeResponse = jsonResponse({'planId': 'plan-a', 'version': 3});
    await tapText(tester, '保存修改');
    expect(h.writes.last['version'], 2);
    router.dispose();
  });

  testWidgets('duplicate time is rejected without changing fixed slots', (
    tester,
  ) async {
    final h = FormHarness();
    final now = TimeOfDay.now();
    final time =
        '${now.hour.toString().padLeft(2, '0')}:${now.minute.toString().padLeft(2, '0')}';
    h.plan = {
      ...h.plan,
      'timeSlots': [time],
    };
    final router = await mountForm(tester, h, edit: true);
    await tapText(tester, '添加');
    await tapText(tester, 'OK');
    expect(find.text('时间点不能重复'), findsOneWidget);
    await tapText(tester, '保存修改');
    expect(h.writes.single['timeSlots'], [time]);
    router.dispose();
  });

  testWidgets(
    '320px and large text keep weekdays and save reachable with keyboard',
    (tester) async {
      final h = FormHarness();
      final router = await mountForm(
        tester,
        h,
        edit: true,
        size: const Size(320, 700),
        scale: 2,
      );
      expect(tester.takeException(), isNull);
      await tapText(tester, '每周一、三');
      await tapText(tester, '周二');
      await tapText(tester, '应用');
      expect(tester.takeException(), isNull);
      final dosage = find.byWidgetPredicate(
        (w) => w is TextField && w.decoration?.labelText == '剂量说明',
      );
      await tester.scrollUntilVisible(
        dosage,
        -180,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.ensureVisible(dosage);
      await tester.showKeyboard(dosage);
      tester.view.viewInsets = const FakeViewPadding(bottom: 240);
      addTearDown(tester.view.resetViewInsets);
      await tester.enterText(dosage, 'Keyboard dose');
      await tester.pumpAndSettle();
      await tapText(tester, '保存修改');
      expect(h.writes.single['dosageText'], 'Keyboard dose');
      expect(tester.takeException(), isNull);
      router.dispose();
    },
  );

  testWidgets(
    'transient offline recreation preserves draft but cannot infer owner or write',
    (tester) async {
      final store = MemoryInventoryLocalStore();
      final first = FormHarness(store: store);
      final router = await mountForm(tester, first);
      await tester.enterText(
        find.byType(TextField).first,
        'Offline-safe draft',
      );
      await tester.pumpAndSettle();
      router.go('/other');
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      router.dispose();
      final persisted = Map.of(store.drafts);
      final next = FormHarness(store: store)..offline = true;
      final restarted = await mountForm(tester, next);
      expect(store.drafts, persisted);
      expect(find.text('Offline-safe draft'), findsNothing);
      expect(find.text('恢复草稿'), findsNothing);
      expect(
        tester.widget<PrimaryButton>(find.byType(PrimaryButton)).onPressed,
        isNull,
      );
      expect(next.writes, isEmpty);
      next.offline = false;
      await tapText(tester, '重新读取');
      await tapText(tester, '恢复草稿');
      expect(find.text('Offline-safe draft'), findsOneWidget);
      expect(next.writes, isEmpty);
      restarted.dispose();
    },
  );
  testWidgets(
    'changing repository during an inventory read does not strand chooser',
    (tester) async {
      final old = FormHarness()..inventoryGate = Completer<http.Response>();
      final current = FormHarness();
      await tester.binding.setSurfaceSize(const Size(900, 1500));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          home: PlanFormPage(repository: old.repo, planId: 'plan-a'),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('从药箱选择'));
      await tester.pump();
      expect(find.text('读取药箱中…'), findsOneWidget);
      await tester.pumpWidget(
        MaterialApp(
          home: PlanFormPage(repository: current.repo, planId: 'plan-a'),
        ),
      );
      await tester.pumpAndSettle();
      old.inventoryGate!.complete(jsonResponse({'medicines': old.inventory}));
      await tester.pumpAndSettle();
      expect(find.text('从药箱选择'), findsOneWidget);
    },
  );

  testWidgets('late edit acknowledgement returns completed locked form', (
    tester,
  ) async {
    final h = FormHarness()..writeGate = Completer<http.Response>();
    final router = await mountForm(tester, h, edit: true);
    await tester.enterText(find.byType(TextField).last, 'First saved dose');
    await tester.pumpAndSettle();
    await tester.tap(find.text('保存修改'));
    await tester.pumpAndSettle();
    expect(h.writes, hasLength(1));
    router.push('/other');
    await tester.pumpAndSettle();
    h.writeGate!.complete(jsonResponse({'planId': 'plan-a', 'version': 2}));
    await tester.pumpAndSettle();
    expect(find.text('Other page'), findsOneWidget);
    router.pop();
    await tester.pumpAndSettle();
    expect(
      tester.widget<TextField>(find.byType(TextField).last).enabled,
      false,
    );
    expect(find.text('计划已更新，返回列表'), findsOneWidget);
    await tapText(tester, '计划已更新，返回列表');
    expect(find.text('Destination'), findsOneWidget);
    expect(h.writes.length, 1);
    router.dispose();
  });
  testWidgets(
    'ACK then ordinary delete failure reopens original key without fresh creation',
    (tester) async {
      final store = FormStore();
      final first = FormHarness(store: store);
      final router = await mountForm(tester, first);
      await tester.enterText(find.byType(TextField).first, 'Creation medicine');
      await tester.enterText(
        find.byType(TextField).at(1),
        'Explicit draft dose',
      );
      await tapText(tester, '添加');
      await tapText(tester, 'OK');
      store.failOrdinaryDelete = true;
      await tapText(tester, '创建计划');
      expect(find.text('Destination'), findsOneWidget);
      expect(first.writes.length, 1);
      final original = first.writes.single;
      await tester.pumpWidget(const SizedBox());
      router.dispose();
      final next = FormHarness(store: store);
      final restarted = await mountForm(tester, next);
      expect(find.text('重试原计划'), findsOneWidget);
      expect(find.text('恢复草稿'), findsNothing);
      expect(
        tester.widget<TextField>(find.byType(TextField).first).enabled,
        false,
      );
      expect(next.writes, isEmpty);
      store.failOrdinaryDelete = false;
      await tapText(tester, '重试原计划');
      expect(next.writes.single, original);
      expect(store.drafts, isEmpty);
      restarted.dispose();
    },
  );

  testWidgets(
    'malformed ordinary draft can be explicitly discarded without network write',
    (tester) async {
      final store = FormStore();
      final h = FormHarness(store: store);
      final router = await mountForm(tester, h);
      await tester.enterText(find.byType(TextField).first, 'Corrupt later');
      await tester.pumpAndSettle();
      final key = store.drafts.keys.single;
      router.go('/other');
      await tester.pumpAndSettle();
      store.drafts[key] = '{broken';
      router.push('/form');
      await tester.pumpAndSettle();
      expect(find.text('本机草稿无法读取，请重新读取或明确丢弃后继续。'), findsOneWidget);
      expect(
        tester.widget<TextField>(find.byType(TextField).first).enabled,
        false,
      );
      await tapText(tester, '丢弃草稿');
      expect(
        tester.widget<TextField>(find.byType(TextField).first).enabled,
        true,
      );
      expect(store.drafts, isEmpty);
      expect(h.writes, isEmpty);
      router.dispose();
    },
  );

  testWidgets(
    'failed ordinary save blocks submit until explicit successful local retry',
    (tester) async {
      final store = FormStore()..failOrdinarySave = true;
      final h = FormHarness(store: store);
      final router = await mountForm(tester, h);
      await tester.enterText(find.byType(TextField).first, 'Failed local save');
      await tester.enterText(find.byType(TextField).at(1), 'Explicit dose');
      await tapText(tester, '添加');
      await tapText(tester, 'OK');
      expect(find.text('本机草稿保存失败，输入仍保留在此页。'), findsOneWidget);
      await tapText(tester, '创建计划');
      expect(h.writes, isEmpty);
      store.failOrdinarySave = false;
      await tapText(tester, '重试保存草稿');
      await tapText(tester, '创建计划');
      expect(h.writes.length, 1);
      router.dispose();
    },
  );

  testWidgets('care chooser omits view-only and reminder-only profiles', (
    tester,
  ) async {
    final h = FormHarness();
    h.profiles = [
      {'id': 'view', 'displayName': 'View only', 'canManage': false},
      {'id': 'profile-a', 'displayName': 'Manageable', 'canManage': true},
      {'id': 'receive', 'displayName': 'Reminders only', 'canManage': false},
    ];
    final router = await mountForm(tester, h);
    await tapText(tester, 'Manageable');
    expect(find.text('View only'), findsNothing);
    expect(find.text('Reminders only'), findsNothing);
    await tapText(tester, 'Manageable');
    expect(h.writes, isEmpty);
    router.dispose();
  });

  testWidgets(
    'explicit name detachment remains explicit after durable edit restore',
    (tester) async {
      final store = FormStore();
      final first = FormHarness(store: store);
      final router = await mountForm(tester, first, edit: true);
      await tester.enterText(
        find.byType(TextField).first,
        'Deliberate renamed medicine',
      );
      await tester.pumpAndSettle();
      router.go('/other');
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      router.dispose();
      final next = FormHarness(store: store)..inventory = [];
      final restarted = await mountForm(tester, next, edit: true);
      await tapText(tester, '恢复草稿');
      await tapText(tester, '保存修改');
      expect(next.writes.single.containsKey('medicineId'), true);
      expect(next.writes.single['medicineId'], isNull);
      expect(next.writes.single['medicineName'], 'Deliberate renamed medicine');
      restarted.dispose();
    },
  );
}
