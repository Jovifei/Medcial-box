import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:home_medicine_flutter/app.dart';
import 'package:home_medicine_flutter/data/demo_repositories.dart';
import 'package:home_medicine_flutter/features/export/export_page.dart';
import 'package:home_medicine_flutter/features/medicine/medicine_detail_page.dart';

Future<void> openHome(WidgetTester tester) async {
  await tester.pumpWidget(const HomeMedicineApp());
  await tester.pumpAndSettle();
  await tester.tap(find.text('开始体验'));
  await tester.pumpAndSettle();
  await tester.tap(find.text('创建家庭药箱'));
  await tester.pumpAndSettle();
  await tester.tap(find.text('创建并进入药箱'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('welcome enters family choice and create sheet enters home', (
    tester,
  ) async {
    await tester.pumpWidget(const HomeMedicineApp());
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
    await tester.pageBack();
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

  testWidgets('primary controls expose button semantics', (tester) async {
    await tester.pumpWidget(const HomeMedicineApp());
    await tester.pumpAndSettle();
    expect(find.bySemanticsLabel('开始体验'), findsWidgets);
  });
}
