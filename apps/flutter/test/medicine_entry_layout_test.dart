// Host-engine layout regression tests using production widgets and synthetic data.
// The bundled Chinese font is loaded as sans for deterministic host rendering;
// this does not validate native font substitution or an actual software keyboard.
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/core/theme/app_theme.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/features/medicine/medicine_entry_api_page.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const captureKey = ValueKey('audit-capture');
const output = String.fromEnvironment('ENTRY_LAYOUT_OUTPUT');
final observed = <Map<String, Object?>>[];

Future<void> capture(WidgetTester tester, String name) async {
  await tester.pumpAndSettle();
  expect(tester.takeException(), isNull, reason: name);
  if (output.isEmpty) return;
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    find.byKey(captureKey),
  );
  await tester.runAsync(() async {
    final image = await boundary.toImage(pixelRatio: 2);
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    final file = File('$output/$name.png');
    await file.parent.create(recursive: true);
    await file.writeAsBytes(data!.buffer.asUint8List());
    image.dispose();
  });
}

void logCheck(String assertion, Object? actual) {
  observed.add({'assertion': assertion, 'actual': actual});
}

Future<ApiMedicineRepository> openEntry(
  WidgetTester tester,
  MemoryInventoryLocalStore store, {
  double width = 360,
  double scale = 1,
  List<Map<String, dynamic>>? payloads,
}) async {
  tester.view.physicalSize = Size(width, 800);
  tester.view.devicePixelRatio = 1;
  tester.platformDispatcher.textScaleFactorTestValue = scale;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  final api = ApiClient(
    baseUrl: 'https://synthetic.invalid',
    tokenProvider: () async => null,
    client: MockClient((request) async {
      if (request.method == 'POST' && request.url.path == '/api/v1/medicines') {
        final data = jsonDecode(request.body) as Map<String, dynamic>;
        payloads?.add(data);
        return http.Response(
          jsonEncode({
            'id': 'audit-synthetic-medicine',
            ...data,
            'batches': (data['batches'] as List)
                .map((b) => {'id': 'audit-batch', ...b as Map})
                .toList(),
            'version': 1,
          }),
          201,
          headers: {'content-type': 'application/json'},
        );
      }
      throw StateError(
        'Unexpected mocked request: ${request.method} ${request.url.path}',
      );
    }),
  );
  final repository = ApiMedicineRepository(api: api, localStore: store);
  await tester.pumpWidget(
    RepaintBoundary(
      key: captureKey,
      child: MaterialApp(
        theme: appTheme,
        debugShowCheckedModeBanner: false,
        home: Scaffold(
          body: Builder(
            builder: (context) => Center(
              child: FilledButton(
                child: const Text('打开录入页（合成测试入口）'),
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => MedicineEntryApiPage(
                      repository: repository,
                      workflow: ApiWorkflowRepository(api: api),
                      localStore: store,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('打开录入页（合成测试入口）'));
  await tester.pumpAndSettle();
  return repository;
}

Future<void> showField(WidgetTester tester, Finder field) async {
  if (field.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      field,
      100,
      scrollable: find.byType(Scrollable).first,
    );
  }
  await Scrollable.ensureVisible(tester.element(field), alignment: 0.15);
  await tester.pumpAndSettle();
}

Finder fieldWithLabel(String label) => find.byWidgetPredicate(
  (widget) =>
      widget is TextField &&
      (widget.decoration?.labelText == label ||
          (widget.decoration?.label is Text &&
              (widget.decoration!.label! as Text).data == label)),
);

void expectFullLabel(
  WidgetTester tester,
  Finder finder, {
  double? scale,
  bool allowWrap = false,
}) {
  expect(finder, findsOneWidget);
  final paragraph = tester.renderObject<RenderParagraph>(finder);
  final label = paragraph.text.toPlainText();
  expect(paragraph.didExceedMaxLines, isFalse, reason: label);
  if (!allowWrap) {
    expect(
      paragraph.size.width + 0.1,
      greaterThanOrEqualTo(paragraph.getMaxIntrinsicWidth(double.infinity)),
      reason: '$label must fit on one line without clipping or ellipsis',
    );
  }
  final boxes = paragraph.getBoxesForSelection(
    TextSelection(baseOffset: 0, extentOffset: label.length),
  );
  expect(boxes, isNotEmpty, reason: label);
  for (final box in boxes) {
    expect(box.left, greaterThanOrEqualTo(-0.1), reason: label);
    expect(
      box.right,
      lessThanOrEqualTo(paragraph.size.width + 1),
      reason: label,
    );
  }
  if (scale != null) {
    expect(
      paragraph.textScaler.scale(16),
      closeTo(16 * scale, 0.01),
      reason: '$label retains the requested text scaling',
    );
  }
}

Future<void> chooseUnit(
  WidgetTester tester,
  Finder dropdown,
  String label,
  double scale,
) async {
  await showField(tester, dropdown);
  await tester.tap(dropdown);
  await tester.pumpAndSettle();
  final option = find.text(label).last;
  await showField(tester, option);
  expectFullLabel(tester, option, scale: scale);
  await tester.tap(option);
  await tester.pumpAndSettle();
  expect(tester.takeException(), isNull);
}

Finder get openingState => find.byWidgetPredicate(
  (widget) =>
      widget is SegmentedButton<String> &&
      widget.segments.first.value == 'unknown',
);
Finder get openingKind => find.byWidgetPredicate(
  (widget) =>
      widget is SegmentedButton<String> &&
      widget.segments.first.value == 'duration',
);

void expectSegments(
  WidgetTester tester,
  Finder finder,
  String selected,
  double scale,
) {
  final control = tester.widget<SegmentedButton<String>>(finder);
  expect(control.selected, {selected});
  expect(control.showSelectedIcon, isTrue);
  for (final segment in control.segments) {
    final label = (segment.label! as Text).data!;
    final text = find.descendant(of: finder, matching: find.text(label));
    expectFullLabel(tester, text, scale: scale);
    final controlRect = tester.getRect(finder);
    final labelRect = tester.getRect(text);
    expect(controlRect.contains(labelRect.topLeft), isTrue, reason: label);
    expect(
      controlRect.contains(labelRect.bottomRight - const Offset(.01, .01)),
      isTrue,
      reason: label,
    );
  }
}

Future<void> selectSegment(
  WidgetTester tester,
  Finder group,
  String label,
) async {
  final target = find.descendant(of: group, matching: find.text(label));
  await showField(tester, target);
  await tester.tap(target);
  await tester.pumpAndSettle();
  expect(tester.takeException(), isNull);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    final loader = FontLoader('sans')
      ..addFont(rootBundle.load('assets/fonts/MedBoxSansSC-Regular.ttf'));
    await loader.load();
    final icons = FontLoader('MaterialIcons')
      ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
    await icons.load();
  });
  tearDownAll(() async {
    if (output.isEmpty) return;
    final file = File('$output/assertions.json');
    await file.parent.create(recursive: true);
    await file.writeAsString(
      const JsonEncoder.withIndent('  ').convert(observed),
    );
  });

  for (final width in [320.0, 360.0, 430.0]) {
    for (final scale in [1.0, 2.0]) {
      final variant = '${width.toInt()}-${(100 * scale).toInt()}';
      testWidgets('entry field and opening labels fit at $variant', (
        tester,
      ) async {
        await openEntry(
          tester,
          MemoryInventoryLocalStore(),
          width: width,
          scale: scale,
        );
        expect(tester.takeException(), isNull);
        final quantity = fieldWithLabel('剩余数量');
        await showField(tester, quantity);
        expectFullLabel(tester, find.text('剩余数量'));
        for (final unit in kQuantityUnitValues) {
          await chooseUnit(
            tester,
            find.byType(DropdownButtonFormField<String>).first,
            unitLabel(unit),
            scale,
          );
          final dropdown = find.byKey(ValueKey(unit));
          expect(dropdown, findsOneWidget);
          expectFullLabel(
            tester,
            find.descendant(of: dropdown, matching: find.text(unitLabel(unit))),
            scale: scale,
          );
        }
        // Capture the longest unit after proving every supported menu item
        // and selected label fits at the user's full scale.
        await chooseUnit(
          tester,
          find.byType(DropdownButtonFormField<String>).first,
          unitLabel('ml'),
          scale,
        );
        await showField(tester, quantity);
        await capture(tester, 'fields-$variant');
        logCheck('$variant all quantity units fit', kQuantityUnitValues);
        await tester.scrollUntilVisible(
          find.text('开封信息（选填）'),
          150,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.tap(find.text('开封信息（选填）'));
        await tester.pumpAndSettle();
        await showField(tester, openingState);
        for (final entry in const {
          'unknown': '未记录',
          'unopened': '未开封',
          'opened': '已开封',
        }.entries) {
          await selectSegment(tester, openingState, entry.value);
          expectSegments(tester, openingState, entry.key, scale);
          await showField(tester, openingState);
          if (scale == 2 || entry.key == 'opened') {
            await capture(tester, 'opening-${entry.key}-$variant');
          }
        }
        await showField(tester, openingKind);
        expectSegments(tester, openingKind, 'duration', scale);
        final duration = fieldWithLabel('开封后期限');
        await showField(tester, duration);
        expectFullLabel(tester, find.text('开封后期限'));
        expectFullLabel(tester, find.text('选择'), scale: scale);
        for (final label in ['天', '月']) {
          await chooseUnit(
            tester,
            find.byType(DropdownButtonFormField<String>).last,
            label,
            scale,
          );
          expectFullLabel(tester, find.text(label), scale: scale);
        }
        await showField(tester, openingKind);
        await capture(tester, 'duration-$variant');
        await selectSegment(tester, openingKind, '截止日期');
        expectSegments(tester, openingKind, 'date', scale);
        await showField(tester, fieldWithLabel('开封后截止日期'));
        expectFullLabel(tester, find.text('开封后截止日期'), allowWrap: true);
        await capture(tester, 'date-$variant');
        final deadline = fieldWithLabel('开封后截止日期');
        await tester.enterText(deadline, '2027-10-03');
        tester.view.viewInsets = const FakeViewPadding(bottom: 300);
        await tester.pumpAndSettle();
        await showField(tester, deadline);
        expectFullLabel(tester, find.text('开封后截止日期'), allowWrap: true);
        final save = find.widgetWithText(FilledButton, '核对后保存');
        expect(
          tester.getRect(deadline).bottom,
          lessThan(tester.getRect(save).top),
        );
        expect(tester.getRect(save).bottom, lessThanOrEqualTo(500));
        if (scale == 2) await capture(tester, 'date-keyboard-$variant');
        tester.view.viewInsets = FakeViewPadding.zero;
        await tester.pumpAndSettle();
        await selectSegment(tester, openingKind, '经过时长');
        expectSegments(tester, openingKind, 'duration', scale);
        await showField(tester, fieldWithLabel('开封后期限'));
        expect(
          tester
              .widget<DropdownButtonFormField<String>>(
                find.byType(DropdownButtonFormField<String>).last,
              )
              .initialValue,
          'month',
        );
        logCheck('$variant opening states and both limit kinds fit', true);
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpAndSettle();
      });

      testWidgets(
        'entry simulated keyboard and Tab remain usable at $variant',
        (tester) async {
          await openEntry(
            tester,
            MemoryInventoryLocalStore(),
            width: width,
            scale: scale,
          );
          final name = find.byWidgetPredicate(
            (widget) =>
                widget is TextField &&
                widget.decoration?.hintText == '例如：布洛芬缓释胶囊',
          );
          await showField(tester, name);
          await tester.tap(name);
          tester.view.viewInsets = const FakeViewPadding(bottom: 300);
          await tester.pumpAndSettle();
          await showField(tester, name);
          final save = find.widgetWithText(FilledButton, '核对后保存');
          expect(
            tester.getRect(name).bottom,
            lessThan(tester.getRect(save).top),
          );
          expect(tester.getRect(save).bottom, lessThanOrEqualTo(500));
          await tester.sendKeyEvent(LogicalKeyboardKey.tab);
          await tester.pumpAndSettle();
          final quantity = fieldWithLabel('剩余数量');
          final editable = tester.widget<EditableText>(
            find.descendant(of: quantity, matching: find.byType(EditableText)),
          );
          expect(editable.focusNode.hasFocus, isTrue);
          await showField(tester, quantity);
          expect(
            tester.getRect(quantity).bottom,
            lessThan(tester.getRect(save).top),
          );
          await capture(tester, 'keyboard-quantity-$variant');
          final expiry = fieldWithLabel('包装有效期');
          await showField(tester, expiry);
          await tester.tap(expiry);
          await tester.pumpAndSettle();
          expect(
            tester.getRect(expiry).bottom,
            lessThan(tester.getRect(save).top),
          );
          expect(tester.takeException(), isNull);
          logCheck('$variant simulated keyboard', {
            'inset': 300,
            'nameQuantityExpiryReachable': true,
            'tabFocusesQuantity': true,
            'saveAboveInset': true,
          });
          tester.view.viewInsets = FakeViewPadding.zero;
          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pumpAndSettle();
        },
      );
    }
  }

  testWidgets('entry 200 percent name-only save still validates and returns', (
    tester,
  ) async {
    final store = MemoryInventoryLocalStore();
    final payloads = <Map<String, dynamic>>[];
    final repository = await openEntry(
      tester,
      store,
      width: 320,
      scale: 2,
      payloads: payloads,
    );
    await tester.tap(find.text('核对后保存'));
    await tester.pumpAndSettle();
    expect(payloads, isEmpty);
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
    final name = find.byWidgetPredicate(
      (widget) =>
          widget is TextField && widget.decoration?.hintText == '例如：布洛芬缓释胶囊',
    );
    await showField(tester, name);
    await tester.enterText(name, '合成测试药品');
    await tester.pumpAndSettle();
    await tester.tap(find.text('核对后保存'));
    await tester.pumpAndSettle();
    expect(payloads, hasLength(1));
    expect(repository.medicines.single.name, '合成测试药品');
    expect(find.byType(MedicineEntryApiPage), findsNothing);
    expect(await store.readDraft('medicine-entry'), isNull);
    expect(
      jsonDecode((await store.readDraft('medicine-entry-queue.v1'))!),
      isEmpty,
    );
    expect(tester.takeException(), isNull);
    logCheck('320-200 name-only save', {
      'postCount': 1,
      'returned': true,
      'draftCleared': true,
    });
  });

  testWidgets(
    'entry 200 percent Back keeps restores and discards chosen values',
    (tester) async {
      final store = MemoryInventoryLocalStore();
      await openEntry(tester, store, width: 320, scale: 2);
      final name = find.byWidgetPredicate(
        (widget) =>
            widget is TextField && widget.decoration?.hintText == '例如：布洛芬缓释胶囊',
      );
      await showField(tester, name);
      await tester.enterText(name, '合成草稿药品');
      await tester.enterText(fieldWithLabel('剩余数量'), '4');
      await chooseUnit(
        tester,
        find.byType(DropdownButtonFormField<String>).first,
        '毫升',
        2,
      );
      await tester.tap(find.byType(BackButton));
      await tester.pumpAndSettle();
      await capture(tester, 'back-dialog-320-200');
      await tester.tap(find.text('继续编辑'));
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(name).controller!.text, '合成草稿药品');
      await tester.tap(find.byType(BackButton));
      await tester.pumpAndSettle();
      await tester.tap(find.text('保留草稿'));
      await tester.pumpAndSettle();
      expect(await store.readDraft('medicine-entry'), isNotNull);
      await tester.tap(find.text('打开录入页（合成测试入口）'));
      await tester.pumpAndSettle();
      await showField(tester, name);
      expect(tester.widget<TextField>(name).controller!.text, '合成草稿药品');
      expect(
        tester.widget<TextField>(fieldWithLabel('剩余数量')).controller!.text,
        '4',
      );
      expect(find.byKey(const ValueKey('ml')), findsOneWidget);
      await tester.tap(find.byType(BackButton));
      await tester.pumpAndSettle();
      await tester.tap(find.text('放弃修改'));
      await tester.pumpAndSettle();
      expect(await store.readDraft('medicine-entry'), isNull);
      expect(
        jsonDecode((await store.readDraft('medicine-entry-queue.v1'))!),
        isEmpty,
      );
      expect(tester.takeException(), isNull);
      logCheck('320-200 Back / continue / keep / restore / discard', true);
    },
  );
}
