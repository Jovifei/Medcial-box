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
}
