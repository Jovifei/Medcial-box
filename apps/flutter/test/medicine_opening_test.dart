import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/features/medicine/medicine_detail_api_page.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';

void main() {
  test('only explicitly unopened batches can be split', () {
    final unopened = BatchRecord(
      id: 'unopened',
      quantity: 5,
      unit: 'bottle',
      openedState: 'unopened',
    );
    final unknown = BatchRecord(
      id: 'unknown',
      quantity: 5,
      unit: 'bottle',
      openedState: 'unknown',
    );
    final opened = BatchRecord(
      id: 'opened',
      quantity: 5,
      unit: 'bottle',
      openedState: 'opened',
    );

    expect(shouldSplitBatchOpening(unopened, 1), isTrue);
    expect(shouldSplitBatchOpening(unopened, 0), isFalse);
    expect(shouldSplitBatchOpening(unopened, 5), isFalse);
    expect(shouldSplitBatchOpening(unknown, 1), isFalse);
    expect(shouldSplitBatchOpening(opened, 1), isFalse);
  });

  test('quantity helpers parse by unit and format fixed-point (R08)', () {
    // 计件单位：非负整数；小数/负数/非数字/空 → null
    expect(parseQuantityByUnit('12', 'tablet'), 12.0);
    expect(parseQuantityByUnit('0', 'box'), 0.0);
    expect(parseQuantityByUnit('12.5', 'tablet'), isNull);
    expect(parseQuantityByUnit('-1', 'tablet'), isNull);
    expect(parseQuantityByUnit('abc', 'tablet'), isNull);
    expect(parseQuantityByUnit('', 'tablet'), isNull);
    // 毫升：最多 3 位小数
    expect(parseQuantityByUnit('12.5', 'ml'), 12.5);
    expect(parseQuantityByUnit('0.001', 'ml'), 0.001);
    expect(parseQuantityByUnit('12.5001', 'ml'), isNull);
    expect(parseQuantityByUnit('12', 'ml'), 12.0);
    expect(unitAllowsDecimals('ml'), isTrue);
    expect(unitAllowsDecimals('blister'), isFalse);
    // 定点格式化：整数余量显示“12”而不是“12.0”
    expect(quantityText(12.0), '12');
    expect(quantityText(12.5), '12.5');
    expect(quantityText(null), '数量未知');
    // 规范单位表必须包含新单位，避免选择器 initialValue 找不到 item
    expect(kQuantityUnitValues.contains('ml'), isTrue);
    expect(kQuantityUnitValues.contains('blister'), isTrue);
  });

  test('millilitre batches split with decimals and keep a positive remainder (R08)', () {
    final ml = BatchRecord(id: 'ml', quantity: 12.5, unit: 'ml', openedState: 'unopened');
    expect(shouldSplitBatchOpening(ml, 2.5), isTrue);
    expect(shouldSplitBatchOpening(ml, 12.5), isFalse, reason: '拆出全部会留 0 余量，必须拒绝');
    expect(shouldSplitBatchOpening(ml, 0), isFalse);
  });
}
