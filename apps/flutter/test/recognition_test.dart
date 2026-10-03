import 'package:flutter_test/flutter_test.dart';

import 'package:home_medicine_flutter/data/medicine_recognition.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';

void main() {
  test(
    'Chinese medicine text parser extracts name, specification and expiry',
    () {
      final draft = MedicineTextParser().parse(
        '复方对乙酰氨基酚片\n0.5g × 12片\n有效期至：2027年12月31日',
      );
      expect(draft.name, '复方对乙酰氨基酚片');
      expect(draft.specification, contains('0.5g'));
      expect(draft.expiry, '2027-12-31');
      expect(draft.warnings, isEmpty);
    },
  );

  test('empty OCR output keeps manual recovery warnings', () {
    final draft = MedicineTextParser().parse('');
    expect(draft.name, isEmpty);
    expect(draft.expiry, '待补充');
    expect(draft.warnings, hasLength(3));
  });

  test('unrelated OCR text does not become a medicine name', () {
    final draft = MedicineTextParser().parse('家庭药箱\n2027年12月31日');

    expect(draft.name, isEmpty);
    expect(draft.warnings, contains('没有可靠识别出药品名称，请人工填写。'));
  });

  test('topical gel name is recognized from the photographed label', () {
    final draft = MedicineTextParser().parse('糠酸莫米松凝胶\n20 g');

    expect(draft.name, '糠酸莫米松凝胶');
    expect(draft.specification, contains('20 g'));
    expect(draft.warnings, isNot(contains('没有可靠识别出药品名称，请人工填写。')));
  });

  test('gel name survives trailing OCR noise and an English label on the same line', () {
    for (final rawText in [
      '糠酸莫米松凝胶交',
      '糠酸莫米松凝胶 MOMETASONE FUROATE GEL\n20 g',
    ]) {
      final draft = MedicineTextParser().parse(rawText);

      expect(draft.name, '糠酸莫米松凝胶');
      expect(draft.warnings, isNot(contains('没有可靠识别出药品名称，请人工填写。')));
    }
  });

  test('tube quantity unit keeps its API value and Chinese label', () {
    expect(unitApiValue('支'), 'tube');
    expect(unitLabel('tube'), '支');
  });

  test('a manufacture date is never mistaken for an expiry date', () {
    final draft = MedicineTextParser().parse(
      '布洛芬缓释胶囊\n生产日期：2025年03月01日\n批号：20250301',
    );

    expect(draft.expiry, '待补充');
    expect(draft.warnings, contains('没有识别出有效期，请对照药盒手动补充。'));
  });

  test('expiry label wins if manufacture and expiry dates appear together', () {
    final draft = MedicineTextParser().parse(
      '布洛芬缓释胶囊\n生产日期：2025年03月01日\n有效期至：2027年03月01日',
    );

    expect(draft.expiry, '2027-03-01');
  });
}
