import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:home_medicine_flutter/app.dart';
import 'package:home_medicine_flutter/data/demo_repositories.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:home_medicine_flutter/features/export/export_page.dart';
import 'package:home_medicine_flutter/domain/ingredient_match.dart';
import 'package:home_medicine_flutter/features/medicine/medicine_detail_page.dart';
import 'package:home_medicine_flutter/features/medicine/medicine_entry_api_page.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Future<void> openHome(WidgetTester tester) async {
  await tester.pumpWidget(_demoApp());
  await tester.pumpAndSettle();
  await tester.tap(find.text('开始体验'));
  await tester.pumpAndSettle();
  await tester.tap(find.text('创建家庭药箱'));
  await tester.pumpAndSettle();
  await tester.tap(find.text('创建并进入药箱'));
  await tester.pumpAndSettle();
}

Widget _demoApp() => HomeMedicineApp(
  initialLocation: '/demo/welcome',
  secretStore: MemorySecretStore(),
  localStore: MemoryInventoryLocalStore(),
);

Future<ApiMedicineRepository> _openProductionEntry(
  WidgetTester tester,
  MemoryInventoryLocalStore localStore, {
  http.Client? client,
}) async {
  final api = ApiClient(
    baseUrl: 'https://medicine.example',
    tokenProvider: () async => 'test-token',
    client: client ?? MockClient((_) async => http.Response('{}', 200)),
  );
  final repository = ApiMedicineRepository(api: api, localStore: localStore);
  final workflow = ApiWorkflowRepository(api: api);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => Center(
            child: ElevatedButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => MedicineEntryApiPage(
                    repository: repository,
                    workflow: workflow,
                    localStore: localStore,
                  ),
                ),
              ),
              child: const Text('打开真实录入页'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('打开真实录入页'));
  await tester.pumpAndSettle();
  return repository;
}

void main() {
  testWidgets('welcome enters family choice and create sheet enters home', (
    tester,
  ) async {
    await tester.pumpWidget(_demoApp());
    await tester.pumpAndSettle();
    expect(find.textContaining('把家里的药'), findsOneWidget);
    expect(find.textContaining('交互原型'), findsOneWidget);

    await tester.tap(find.text('开始体验'));
    await tester.pumpAndSettle();
    expect(find.text('先选择你的家庭'), findsOneWidget);

    await tester.tap(find.text('创建家庭药箱'));
    await tester.pumpAndSettle();
    expect(find.text('创建演示家庭'), findsOneWidget);
    await tester.tap(find.text('创建并进入药箱'));
    await tester.pumpAndSettle();
    expect(find.text('家里的药，心里有数。'), findsOneWidget);
  });

  testWidgets('medicine card navigates to detail and preserves back route', (
    tester,
  ) async {
    await openHome(tester);
    await tester.tap(find.text('对乙酰氨基酚片'));
    await tester.pumpAndSettle();
    expect(find.text('药品详情'), findsOneWidget);
    expect(find.text('批次与有效期'), findsOneWidget);
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    expect(find.text('库存状态'), findsOneWidget);
  });

  testWidgets('export options update markdown preview', (tester) async {
    await openHome(tester);
    await tester.tap(find.byTooltip('导出 Markdown'));
    await tester.pumpAndSettle();
    expect(find.text('导出前确认'), findsOneWidget);
    expect(find.textContaining('个人剂量备注：不包含'), findsOneWidget);
    await tester.tap(find.byType(SwitchListTile).first);
    await tester.pumpAndSettle();
    expect(find.textContaining('个人剂量备注：包含'), findsOneWidget);
  });

  testWidgets('export switches change the actual preview content', (
    tester,
  ) async {
    final repository = DemoMedicineRepository();
    await tester.pumpWidget(
      MaterialApp(home: ExportPage(repository: repository)),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('家人备注：成人一次 1 片，仅作记录。'), findsNothing);
    expect(find.textContaining('客厅药箱'), findsOneWidget);

    await tester.tap(find.byType(SwitchListTile).first);
    await tester.pumpAndSettle();
    expect(find.textContaining('家人备注：成人一次 1 片，仅作记录。'), findsOneWidget);

    await tester.tap(find.byType(SwitchListTile).last);
    await tester.pumpAndSettle();
    expect(find.textContaining('客厅药箱'), findsNothing);
  });

  testWidgets('medicine detail persists an edited personal note', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(800, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final repository = DemoMedicineRepository();
    await tester.pumpWidget(
      MaterialApp(
        home: MedicineDetailPage(
          repository: repository,
          medicineId: 'paracetamol',
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(find.byType(TextButton), 300);
    await tester.tap(find.byType(TextButton));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '新的家庭备注');
    await tester.tap(find.text('保存备注'));
    await tester.pumpAndSettle();

    expect(find.text('新的家庭备注'), findsOneWidget);
    expect(
      (await repository.getMedicine('paracetamol')).personalNote,
      '新的家庭备注',
    );
  });

  testWidgets('medicine detail persists a new batch', (tester) async {
    tester.view.physicalSize = const Size(800, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final repository = DemoMedicineRepository();
    await tester.pumpWidget(
      MaterialApp(
        home: MedicineDetailPage(
          repository: repository,
          medicineId: 'paracetamol',
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(find.text('添加一个批次'), 300);
    await tester.tap(find.text('添加一个批次'));
    await tester.pumpAndSettle();
    final fields = find.byType(TextField);
    await tester.enterText(fields.at(0), '3');
    await tester.enterText(fields.at(1), '盒');
    await tester.enterText(fields.at(2), '2028-01-31');
    await tester.tap(find.text('保存演示批次'));
    await tester.pumpAndSettle();

    final medicine = await repository.getMedicine('paracetamol');
    expect(medicine.batches, hasLength(2));
    expect(medicine.batches.last.quantity, 3);
    expect(medicine.batches.last.expiry, '2028-01-31');
  });

  testWidgets('invalid medicine id shows a recoverable error state', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: MedicineDetailPage(
          repository: DemoMedicineRepository(),
          medicineId: 'missing',
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('找不到这项药品'), findsOneWidget);
    expect(find.text('返回药箱'), findsOneWidget);
  });

  testWidgets('manual medicine entry writes a new demo record', (tester) async {
    await openHome(tester);
    await tester.tap(find.text('录入药品'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('手动录入'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, '测试录入药');
    await tester.tap(find.text('保存到演示药箱'));
    await tester.pumpAndSettle();
    expect(find.text('测试录入药'), findsOneWidget);
    expect(find.text('库存状态'), findsOneWidget);
  });

  testWidgets('entry back can keep a local draft and restore its fields', (
    tester,
  ) async {
    final localStore = MemoryInventoryLocalStore();
    await _openProductionEntry(tester, localStore);
    await tester.enterText(find.byType(TextField).first, '草稿测试药');
    await tester.enterText(
      find.byWidgetPredicate(
        (widget) =>
            widget is TextField && widget.decoration?.labelText == '剩余数量',
      ),
      '4',
    );
    await tester.pump();
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    expect(find.text('保留这次录入？'), findsOneWidget);

    await tester.tap(find.text('保留草稿'));
    await tester.pumpAndSettle();
    expect(await localStore.readDraft('medicine-entry'), isNotNull);

    await tester.tap(find.text('打开真实录入页'));
    await tester.pumpAndSettle();
    expect(find.text('已恢复这份未完成录入，核对后保存再添加下一种。'), findsOneWidget);
    expect(
      tester.widget<TextField>(find.byType(TextField).first).controller!.text,
      '草稿测试药',
    );
    expect(
      tester
          .widget<TextField>(
            find.byWidgetPredicate(
              (widget) =>
                  widget is TextField && widget.decoration?.labelText == '剩余数量',
            ),
          )
          .controller!
          .text,
      '4',
    );
  });

  testWidgets('entry back can discard edits and clear a kept local draft', (
    tester,
  ) async {
    final localStore = MemoryInventoryLocalStore();
    await localStore.saveDraft('medicine-entry', '{"name":"previous"}');
    await _openProductionEntry(tester, localStore);
    await tester.enterText(find.byType(TextField).first, '临时输入');
    await tester.pump();
    expect(
      tester
          .widget<PopScope<Object?>>(
            find.byKey(const ValueKey('medicine-entry-pop-scope')),
          )
          .canPop,
      isFalse,
    );
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    await tester.tap(find.text('放弃修改'));
    await tester.pumpAndSettle();

    expect(await localStore.readDraft('medicine-entry'), isNull);
    expect(find.text('打开真实录入页'), findsOneWidget);
  });

  testWidgets('entry back can continue editing without changing the draft', (
    tester,
  ) async {
    final localStore = MemoryInventoryLocalStore();
    await _openProductionEntry(tester, localStore);
    await tester.enterText(find.byType(TextField).first, '继续编辑药');
    await tester.pump();
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.text('继续编辑'));
    await tester.pumpAndSettle();

    expect(find.text('添加药品'), findsOneWidget);
    expect(
      tester.widget<TextField>(find.byType(TextField).first).controller!.text,
      '继续编辑药',
    );
    expect(await localStore.readDraft('medicine-entry'), isNull);
  });

  testWidgets(
    'verified ingredient overlap asks before saving the household record',
    (tester) async {
      final requests = <http.Request>[];
      final client = MockClient((request) async {
        requests.add(request);
        if (request.method == 'GET' &&
            request.url.path == '/api/v1/medicines') {
          return http.Response(
            jsonEncode({
              'medicines': [
                {
                  'id': 'same-ingredient',
                  'name': '家中已核验药',
                  'specification': null,
                  'manufacturer': null,
                  'approvalNumber': null,
                  'activeIngredients': ['咖啡因'],
                  'purposeCategory': null,
                  'leaflet': {
                    'purposeSummary': null,
                    'packageUsageSummary': null,
                    'contraindicationsSummary': null,
                    'precautionsSummary': null,
                    'source': '包装说明书',
                    'reviewStatus': 'user_confirmed',
                  },
                  'batches': [],
                  'lowStockThreshold': null,
                  'stockStatus': {
                    'state': 'unknown',
                    'quantity': null,
                    'unit': null,
                  },
                  'expiryState': {'state': 'unknown', 'label': '有效期待补充'},
                  'isArchived': false,
                  'version': 1,
                },
              ],
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        if (request.method == 'POST' &&
            request.url.path == '/api/v1/medicines') {
          return http.Response(
            jsonEncode({
              'id': 'new-medicine',
              'name': '新录入药',
              'activeIngredients': ['咖啡因'],
              'leaflet': {'reviewStatus': 'user_confirmed'},
              'batches': [],
              'version': 1,
            }),
            201,
          );
        }
        return http.Response('{}', 200);
      });
      final repository = await _openProductionEntry(
        tester,
        MemoryInventoryLocalStore(),
        client: client,
      );
      await tester.enterText(find.byType(TextField).first, '新录入药');
      await tester.scrollUntilVisible(
        find.text('更多资料（选填）'),
        240,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.ensureVisible(find.text('更多资料（选填）'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('更多资料（选填）'));
      await tester.pumpAndSettle();
      final ingredientsField = find.byWidgetPredicate(
        (widget) =>
            widget is TextField &&
            widget.decoration?.labelText == '成分（多个请用逗号分开）',
      );
      await tester.ensureVisible(ingredientsField);
      await tester.enterText(ingredientsField, '咖啡因');
      expect(
        tester.widget<TextField>(ingredientsField).controller!.text,
        '咖啡因',
      );
      await tester.scrollUntilVisible(
        find.text('已对照包装核对有效成分'),
        240,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.ensureVisible(find.text('已对照包装核对有效成分'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('已对照包装核对有效成分'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<CheckboxListTile>(find.byType(CheckboxListTile)).value,
        true,
      );
      await tester.tap(find.text('核对后保存'));
      await tester.pumpAndSettle();

      expect(
        requests.map((request) => '${request.method} ${request.url.path}'),
        contains('GET /api/v1/medicines'),
      );
      expect(
        repository.medicines.single.leaflet.reviewStatus,
        'user_confirmed',
      );
      expect(
        findVerifiedIngredientMatches(
          candidateIngredients: const ['咖啡因'],
          medicines: repository.medicines,
          candidateIngredientsVerified: true,
        ),
        hasLength(1),
      );
      expect(requests.any((request) => request.method == 'GET'), isTrue);
      expect(find.text('家中已有相同成分记录'), findsOneWidget);
      expect(requests.where((request) => request.method == 'POST'), isEmpty);
      expect(find.textContaining('这只是重复成分提醒，不是选药建议。'), findsOneWidget);

      await tester.tap(find.text('返回核对'));
      await tester.pumpAndSettle();
      expect(find.text('添加药品'), findsOneWidget);
      expect(requests.where((request) => request.method == 'POST'), isEmpty);
      await tester.tap(find.text('核对后保存'));
      await tester.pumpAndSettle();
      expect(find.text('家中已有相同成分记录'), findsOneWidget);
      await tester.tap(find.text('仍然保存'));
      await tester.pumpAndSettle();
      final createRequest = requests.singleWhere(
        (request) => request.method == 'POST',
      );
      final payload = jsonDecode(createRequest.body) as Map<String, dynamic>;
      expect(payload['activeIngredients'], ['咖啡因']);
      expect(
        (payload['leaflet'] as Map<String, dynamic>)['reviewStatus'],
        'user_confirmed',
      );
    },
  );

  testWidgets('uncertain create locks draft and retries identical request', (
    tester,
  ) async {
    final payloads = <String>[];
    final store = MemoryInventoryLocalStore();
    await _openProductionEntry(
      tester,
      store,
      client: MockClient((request) async {
        if (request.method == 'POST' &&
            request.url.path == '/api/v1/medicines') {
          payloads.add(request.body);
          if (payloads.length == 1) return http.Response('{}', 503);
          return http.Response(
            jsonEncode({
              'id': 'saved',
              'name': 'synthetic medicine',
              'batches': [],
              'version': 1,
            }),
            201,
          );
        }
        return http.Response(jsonEncode({'medicines': []}), 200);
      }),
    );
    await tester.enterText(find.byType(TextField).first, '待确认药');
    await tester.tap(find.text('核对后保存'));
    await tester.pumpAndSettle();
    expect(find.text('重试原提交'), findsOneWidget);
    final queue = await store.readDraft('medicine-entry-queue.v1');
    expect(jsonDecode(queue!) as List, hasLength(1));
    expect(
      (jsonDecode(queue) as List).single['attemptedPayload']['name'],
      '待确认药',
    );
    await tester.tap(find.text('重试原提交'));
    await tester.pumpAndSettle();
    expect(payloads, hasLength(2));
    expect(payloads[1], payloads[0]);
    expect(find.text('打开真实录入页'), findsOneWidget);
  });

  testWidgets('primary controls expose button semantics', (tester) async {
    await tester.pumpWidget(_demoApp());
    await tester.pumpAndSettle();
    expect(find.bySemanticsLabel('开始体验'), findsWidgets);
  });
}
