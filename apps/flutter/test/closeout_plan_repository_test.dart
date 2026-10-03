import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_plan_repository.dart';
import 'package:home_medicine_flutter/models/plan_models.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';

void main() {
  test('reminder range uses server date across month boundary, mutations notify once', () async {
    final requested = <String>[];
    var changed = 0;
    final repo =
        ApiPlanRepository(
            api: ApiClient(
              baseUrl: 'https://medicine.example',
              tokenProvider: () async => 'token',
              client: MockClient((r) async {
                requested.add(r.url.toString());
                if (r.method == 'POST') return http.Response('{"status":"taken"}', 200);
                return http.Response(
                  jsonEncode({
                    'date': r.url.queryParameters['date'] ?? '2026-12-29',
                    'entries': [],
                  }),
                  200,
                );
              }),
            ),
          )
          ..onChanged = () async {
            changed++;
          };
    final range = await repo.reminderSchedules();
    expect(range.map((d) => d.date), [
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
      '2027-01-03',
      '2027-01-04',
    ]);
    expect(requested.length, 7);
    await repo.changeStatus('p', action: 'pause', version: 1);
    expect(changed, 1);
    await repo.confirmDose('o', action: 'taken', idempotencyKey: 'key');
    expect(changed, 2);
  });
  test(
    'history and quantity model preserve authoritative immutable fields',
    () {
      final history = PlanHistoryRecord.fromJson({
        'occurrenceId': 'old',
        'medicineName': 'Previous Drug',
        'dosageText': 'Previous Dose',
        'snapshotComplete': true,
        'superseded': true,
        'status': 'pending',
      });
      expect(history.medicineName, 'Previous Drug');
      expect(history.dosageText, 'Previous Dose');
      expect(history.snapshotComplete, true);
      expect(history.statusLabel, '已因改期作废');
      final batch = BatchRecord.fromJson({
        'id': 'b',
        'unit': 'bottle',
        'confirmedUnitsPerPackage': 12.5,
        'conversionUnit': 'ml',
      });
      final cached = BatchRecord.fromCacheJson(
        batch.copyWith(quantity: 0).toCacheJson(),
      );
      expect(cached.conversionUnit, 'ml');
      expect(cached.confirmedUnitsPerPackage, 12.5);
      expect(unitLabel('ml'), '毫升');
      expect(unitLabel('blister'), '板');
    },
  );
}
