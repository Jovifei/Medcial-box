import 'package:flutter_test/flutter_test.dart';

import 'package:home_medicine_flutter/data/medicine_recognition.dart';

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
