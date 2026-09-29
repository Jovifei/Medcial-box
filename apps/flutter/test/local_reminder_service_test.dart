import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/local_reminder_service.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';

void main() {
  test('local expiry notices skip handled or unknown-deadline batches', () {
    expect(
      shouldScheduleLocalExpiryReminder(const BatchRecord(
        id: 'active',
        managementExpiryDate: '2026-12-31',
      )),
      isTrue,
    );
    expect(
      shouldScheduleLocalExpiryReminder(const BatchRecord(
        id: 'handled',
        managementExpiryDate: '2026-12-31',
        dispositionStatus: 'handled',
      )),
      isFalse,
    );
    expect(
      shouldScheduleLocalExpiryReminder(const BatchRecord(id: 'unknown')),
      isFalse,
    );
  });
}
