import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_plan_repository.dart';

http.Response _json(Object body, [int status = 200]) => http.Response.bytes(
  utf8.encode(jsonEncode(body)),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

void main() {
  test('history round-trip preserves original snapshots and ordered append-only events', () async {
    var corrected = false;
    final writes = <Map<String, dynamic>>[];
    final repository = ApiPlanRepository(
      api: ApiClient(
        baseUrl: 'https://medicine.example',
        tokenProvider: () async => 'test-session',
        client: MockClient((request) async {
          if (request.method == 'POST') {
            expect(
              request.url.path,
              '/api/v1/dose-occurrences/old-occurrence/confirm',
            );
            writes.add(jsonDecode(request.body) as Map<String, dynamic>);
            corrected = true;
            return _json({
              'occurrenceId': 'old-occurrence',
              'status': 'skipped',
              'replayed': false,
            });
          }
          expect(request.url.path, '/api/v1/medication-plans/plan/history');
          return _json({
            'planId': 'plan',
            'medicineName': 'New plan medicine',
            'history': [
              {
                'occurrenceId': 'old-occurrence',
                'date': '2026-09-30',
                'time': '09:00',
                'medicineName': 'Original snapshot medicine',
                'dosageText': 'Manually entered old dose',
                'status': corrected ? 'skipped' : 'taken',
                'corrected': corrected,
                'snapshotComplete': true,
                'superseded': false,
                'events': [
                  {
                    'action': 'taken',
                    'actor': 'Original member',
                    'at': '2026-09-30 09:05',
                  },
                  if (corrected)
                    {
                      'action': 'skipped',
                      'actor': 'Correction member',
                      'at': '2026-10-03 09:12',
                    },
                ],
              },
            ],
          });
        }),
      ),
    );
    final before = (await repository.planHistory('plan')).records.single;
    await repository.confirmDose(
      'old-occurrence',
      action: 'skipped',
      idempotencyKey: 'explicit-user-correction',
    );
    final after = (await repository.planHistory('plan')).records.single;
    expect(writes.single, {
      'action': 'skipped',
      'idempotencyKey': 'explicit-user-correction',
    });
    expect(after.medicineName, before.medicineName);
    expect(after.dosageText, before.dosageText);
    expect(after.date, before.date);
    expect(after.time, before.time);
    expect(after.snapshotComplete, isTrue);
    expect(after.corrected, isTrue);
    expect(after.events.map((e) => e.action), ['taken', 'skipped']);
    expect(after.events.first.actor, before.events.first.actor);
    expect(after.events.first.at, before.events.first.at);
    expect(before.events, hasLength(1));
    expect(before.status, 'taken');
  });

  for (final code in ['FORBIDDEN', 'OCCURRENCE_SUPERSEDED']) {
    test(
      'repository preserves $code error and emits no mutation notification',
      () async {
        var notifications = 0;
        var acknowledgements = 0;
        final repository = ApiPlanRepository(
          api: ApiClient(
            baseUrl: 'https://medicine.example',
            tokenProvider: () async => 'test-session',
            client: MockClient(
              (request) async => _json({
                'error': {
                  'code': code,
                  'message': 'Server rejected correction',
                },
              }, code == 'FORBIDDEN' ? 403 : 409),
            ),
          ),
        )..addListener(() => notifications++);
        await expectLater(
          repository.confirmDose(
            'old-occurrence',
            action: 'skipped',
            idempotencyKey: 'explicit-correction',
            onConfirmed: (_) => acknowledgements++,
          ),
          throwsA(isA<ApiException>().having((e) => e.code, 'code', code)),
        );
        expect(notifications, 0);
        expect(acknowledgements, 0);
      },
    );
  }
}
