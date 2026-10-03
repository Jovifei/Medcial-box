import 'dart:io';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:image_picker/image_picker.dart';

import 'package:home_medicine_flutter/core/widgets/expiry_date_wheel_picker.dart';
import 'package:home_medicine_flutter/data/demo_repositories.dart';
import 'package:home_medicine_flutter/data/medicine_recognition.dart';
import 'package:home_medicine_flutter/features/recognition/recognition_draft_page.dart';

class _ParserRecognitionRepository implements MedicineRecognitionRepository {
  @override
  Future<MedicineRecognitionDraft> recognize(XFile image) async =>
      MedicineTextParser().parse('糠酸莫米松凝胶\n20 g');
}

void main() {
  late Directory imageDirectory;
  late File imageFile;

  setUpAll(() async {
    imageDirectory = await Directory.systemTemp.createTemp(
      'medbox-recognition-',
    );
    imageFile = File('${imageDirectory.path}/medicine.png');
    await imageFile.writeAsBytes(
      Uri.parse(
        'data:image/png;base64,'
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVQIHWP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
      ).data!.contentAsBytes(),
    );
  });

  tearDownAll(() async => imageDirectory.delete(recursive: true));

  test('expiry wheel preserves month-only and full-date precision', () {
    final date = DateTime(2027, 12, 31);
    expect(formatExpiryDate(date, precision: 'month'), '2027-12');
    expect(formatExpiryDate(date, precision: 'day'), '2027-12-31');
    expect(displayExpiryDate('2027-12'), '2027年12月');
    expect(displayExpiryDate('2027-12-31'), '2027年12月31日');
    expect(expiryDateForPicker('2027-12'), DateTime(2027, 12));
  });

  Future<void> pumpDraft(
    WidgetTester tester,
    DemoMedicineRepository repository,
  ) async {
    tester.view.physicalSize = const Size(430, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    await tester.pumpWidget(
      MaterialApp(
        locale: const Locale('zh', 'CN'),
        supportedLocales: const [Locale('zh', 'CN')],
        localizationsDelegates: const [
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: RecognitionDraftPage(
          image: XFile(imageFile.path),
          repository: repository,
          recognitionRepository: _ParserRecognitionRepository(),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('gel OCR fills its name without the manual-entry warning', (
    tester,
  ) async {
    await pumpDraft(tester, DemoMedicineRepository());

    expect(find.text('糠酸莫米松凝胶'), findsOneWidget);
    expect(find.text('没有可靠识别出药品名称，请人工填写。'), findsNothing);
  });

  testWidgets('review draft selects and saves a stock unit and quantity', (
    tester,
  ) async {
    final repository = DemoMedicineRepository();
    await pumpDraft(tester, repository);

    final unitPicker = find.byType(DropdownButtonFormField<String>);
    expect(unitPicker, findsOneWidget);
    await tester.tap(unitPicker);
    await tester.pumpAndSettle();
    await tester.tap(find.text('支').last);
    await tester.pumpAndSettle();

    final quantityField = find.byWidgetPredicate(
      (widget) =>
          widget is TextField && widget.decoration?.labelText == '剩余数量（可选）',
    );
    await tester.ensureVisible(quantityField);
    await tester.enterText(quantityField, '2');
    await tester.tap(find.text('核对后保存'));
    await tester.pumpAndSettle();

    final saved = repository.medicines.first;
    expect(saved.name, '糠酸莫米松凝胶');
    expect(saved.specification, '20 g');
    expect(saved.batches.single.quantity, 2);
    expect(saved.batches.single.unit, 'tube');
  });

  testWidgets(
    'expiry opens a year-month-day wheel and commits only on confirm',
    (tester) async {
      await pumpDraft(tester, DemoMedicineRepository());
      final expiryField = find.byKey(
        const ValueKey('recognition-expiry-field'),
      );
      final expiryValue = find.byKey(
        const ValueKey('recognition-expiry-value'),
      );

      await tester.ensureVisible(expiryField);
      await tester.tap(expiryField);
      await tester.pumpAndSettle();
      expect(find.byType(CupertinoDatePicker), findsOneWidget);
      final picker = tester.widget<CupertinoDatePicker>(
        find.byType(CupertinoDatePicker),
      );
      expect(picker.dateOrder, DatePickerDateOrder.ymd);
      expect(
        Localizations.localeOf(
          tester.element(find.byType(CupertinoDatePicker)),
        ),
        const Locale('zh', 'CN'),
      );
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(tester.widget<Text>(expiryValue).data, '待补充');

      await tester.tap(expiryField);
      await tester.pumpAndSettle();
      await tester.tap(find.text('确定'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<Text>(expiryValue).data,
        matches(RegExp(r'^\d{4}年\d{1,2}月\d{1,2}日$')),
      );
    },
  );
}
