import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_plan_repository.dart';
import 'package:home_medicine_flutter/features/plan/plan_history_page.dart';

void main() {
  testWidgets(
    'production history displays immutable names and superseded status',
    (tester) async {
      final repo = ApiPlanRepository(
        api: ApiClient(
          baseUrl: 'https://medicine.example',
          tokenProvider: () async => 'token',
          client: MockClient(
            (r) async => http.Response.bytes(
              utf8.encode(
                jsonEncode({
                  'planId': 'p',
                  'medicineName': 'Current Drug',
                  'history': [
                    {
                      'occurrenceId': 'o',
                      'date': '2026-10-01',
                      'time': '09:00',
                      'medicineName': 'Original Drug',
                      'dosageText': 'Original Dose',
                      'snapshotComplete': true,
                      'status': 'pending',
                      'superseded': true,
                      'events': [],
                    },
                  ],
                }),
              ),
              200,
            ),
          ),
        ),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: PlanHistoryPage(repository: repo, planId: 'p'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Original Drug · Original Dose'), findsOneWidget);
      expect(find.text('已因改期作废'), findsOneWidget);
      expect(find.text('待确认'), findsNothing);
    },
  );
}
