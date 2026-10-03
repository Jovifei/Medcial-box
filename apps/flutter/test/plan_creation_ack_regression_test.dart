// Baseline-compatible regressions: actual repository and production form.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:home_medicine_flutter/core/widgets/app_surfaces.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_plan_repository.dart';
import 'package:home_medicine_flutter/features/plan/plan_form_page.dart';
import 'package:home_medicine_flutter/models/plan_models.dart';

const draft = MedicationPlanDraft(
  careProfileId: 'profile-a',
  medicineName: 'Synthetic medicine',
  dosageText: 'Recorded dose',
  timeSlots: ['09:00'],
  weekdays: [],
  startDate: '2026-10-03',
);
http.Response response(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status);

ApiPlanRepository repository({
  void Function(http.Request)? observe,
  bool refreshFailure = false,
}) {
  final repo = ApiPlanRepository(
    api: ApiClient(
      baseUrl: 'https://synthetic.invalid',
      tokenProvider: () async => 'synthetic',
      client: MockClient((r) async {
        observe?.call(r);
        if (r.url.path == '/api/v1/auth/me') {
          return response({
            'user': {'id': 'user-a', 'hasFamily': true},
            'family': {'id': 'family-a', 'name': 'Synthetic', 'role': 'owner'},
          });
        }
        if (r.url.path == '/api/v1/care-profiles') {
          return response({
            'careProfiles': [
              {
                'id': 'profile-a',
                'displayName': 'Synthetic person',
                'canManage': true,
              },
            ],
          });
        }
        if (r.method == 'POST') {
          return response({
            'planId': 'created-plan',
            'careProfileId': 'profile-a',
            'status': 'active',
            'version': 1,
          }, 201);
        }
        return response({
          'error': {'code': 'TEMPORARY', 'message': 'Offline read'},
        }, 503);
      }),
    ),
  );
  if (refreshFailure) {
    repo.onMutationAcknowledged = (_) async =>
        throw StateError('synthetic refresh failure');
  }
  return repo;
}

Future<GoRouter> openForm(WidgetTester tester, ApiPlanRepository repo) async {
  await tester.binding.setSurfaceSize(const Size(900, 1400));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (_, _) => const Scaffold(body: Text('Return destination')),
        routes: [
          GoRoute(
            path: 'create',
            builder: (_, _) => PlanFormPage(repository: repo),
          ),
        ],
      ),
    ],
  );
  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  router.push('/create');
  await tester.pumpAndSettle();
  await tester.enterText(find.byType(TextField).at(0), 'Synthetic medicine');
  await tester.enterText(find.byType(TextField).at(1), 'Recorded dose');
  await tester.tap(find.text('添加'));
  await tester.pumpAndSettle();
  await tester.tap(find.text('OK'));
  await tester.pumpAndSettle();
  return router;
}

void main() {
  test('create POST carries a valid operation key', () async {
    Map<String, dynamic>? payload;
    final repo = repository(
      observe: (r) {
        if (r.method == 'POST') {
          payload = jsonDecode(r.body) as Map<String, dynamic>;
        }
      },
    );
    try {
      await repo.createPlan(draft);
    } catch (_) {}
    expect(
      payload?['idempotencyKey'],
      matches(RegExp(r'^[A-Za-z0-9_-]{16,128}$')),
    );
  });
  test('create ACK survives reminder cleanup failure', () async {
    await expectLater(
      repository(refreshFailure: true).createPlan(draft),
      completes,
    );
  });
  test('create ACK does not depend on a detail read', () async {
    final paths = <String>[];
    await expectLater(
      repository(observe: (r) => paths.add(r.url.path)).createPlan(draft),
      completes,
    );
    expect(paths, isNot(contains('/api/v1/medication-plans/created-plan')));
  });
  for (final refreshFailure in [false, true]) {
    testWidgets(
      'production form keeps acknowledged creation successful; refresh failure=$refreshFailure',
      (tester) async {
        final router = await openForm(
          tester,
          repository(refreshFailure: refreshFailure),
        );
        await tester.ensureVisible(find.byType(PrimaryButton));
        await tester.tap(find.byType(PrimaryButton));
        await tester.pumpAndSettle();
        expect(find.text('Return destination'), findsOneWidget);
        expect(find.text('计划已创建'), findsOneWidget);
        router.dispose();
      },
    );
  }
}
