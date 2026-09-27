import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:home_medicine_flutter/app.dart';

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

  testWidgets('primary controls expose button semantics', (tester) async {
    await tester.pumpWidget(const HomeMedicineApp());
    await tester.pumpAndSettle();
    expect(find.bySemanticsLabel('开始体验'), findsWidgets);
  });
}
