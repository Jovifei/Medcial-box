import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';

void main() {
  test('brand remains separate from manufacturer through cache and edits', () {
    final medicine = MedicineRecord.fromJson({
      'id': 'synthetic-brand',
      'name': '测试药品',
      'brand': '测试品牌',
      'manufacturer': '测试厂家',
      'purposeTags': ['itch', 'oral'],
    });
    final restored = MedicineRecord.fromCacheJson(medicine.toCacheJson());
    expect(restored.brand, '测试品牌');
    expect(restored.manufacturer, '测试厂家');
    expect(restored.copyWith(name: '修改名称').brand, '测试品牌');
    expect(restored.purposeTags, ['itch', 'oral']);
    expect(MedicineRecord.fromJson({'id': 'old', 'name': '旧药品'}).brand, isNull);
  });
}
