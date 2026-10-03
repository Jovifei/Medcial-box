import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:home_medicine_flutter/data/api_auth_repository.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/features/home/production_shell.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class _ObservedRouter extends GoRouter {
  _ObservedRouter({required List<RouteBase> routes, this.failNext = false})
    : super.routingConfig(
        routingConfig: ValueNotifier(RoutingConfig(routes: routes)),
      );
  bool failNext;
  int pushes = 0;
  @override
  Future<T?> push<T extends Object?>(String location, {Object? extra}) {
    pushes++;
    if (failNext) {
      failNext = false;
      return Future<T?>.error(StateError('synthetic route failure'));
    }
    return super.push<T>(location, extra: extra);
  }
}

Future<_ObservedRouter> _mount(
  WidgetTester tester, {
  bool failNext = false,
}) async {
  tester.view.physicalSize = const Size(1000, 1800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final store = MemoryInventoryLocalStore();
  final api = ApiClient(
    baseUrl: 'https://synthetic.invalid',
    tokenProvider: () async => 'synthetic-token',
    client: MockClient((request) async {
      final Object body = switch (request.url.path) {
        '/api/v1/medicines' => {'medicines': []},
        '/api/v1/families/current' => {
          'family': {
            'id': 'family-a',
            'name': 'Synthetic family',
            'role': 'owner',
          },
        },
        _ => throw StateError(
          'Unexpected synthetic request ${request.url.path}',
        ),
      };
      return http.Response(
        jsonEncode(body),
        200,
        headers: {'content-type': 'application/json'},
      );
    }),
  );
  final router = _ObservedRouter(
    failNext: failNext,
    routes: [
      GoRoute(
        path: '/',
        builder: (_, state) => CabinetHomePage(
          repository: ApiMedicineRepository(api: api, localStore: store),
          familyRepository: ApiFamilyRepository(api: api, localStore: store),
          workflow: ApiWorkflowRepository(api: api),
        ),
      ),
      GoRoute(
        path: '/medicine/new',
        builder: (_, state) => Scaffold(
          appBar: AppBar(title: const Text('Synthetic entry route')),
        ),
      ),
    ],
  );
  addTearDown(router.dispose);
  addTearDown(api.close);
  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  await tester.pumpAndSettle();
  return router;
}

void main() {
  testWidgets(
    'both cabinet Add controls share one pending push and unlock after return',
    (tester) async {
      final router = await _mount(tester);
      final floating = find.widgetWithText(FloatingActionButton, '录入');
      final empty = find.text('录入第一种药');
      expect(empty, findsOneWidget);
      await tester.tap(floating);
      await tester.tap(empty);
      await tester.pumpAndSettle();
      expect(router.pushes, 1);
      expect(find.text('Synthetic entry route'), findsOneWidget);
      await tester.tap(find.byType(BackButton));
      await tester.pumpAndSettle();
      await tester.tap(empty);
      await tester.tap(floating);
      await tester.pumpAndSettle();
      expect(router.pushes, 2);
      expect(find.text('Synthetic entry route'), findsOneWidget);
    },
  );

  testWidgets(
    'failed Add push shows feedback and allows retry through the other control',
    (tester) async {
      final router = await _mount(tester, failNext: true);
      await tester.tap(find.widgetWithText(FloatingActionButton, '录入'));
      await tester.pumpAndSettle();
      expect(find.text('暂时无法打开录入页，请重试。'), findsOneWidget);
      expect(router.pushes, 1);
      await tester.tap(find.text('录入第一种药'));
      await tester.pumpAndSettle();
      expect(router.pushes, 2);
      expect(find.text('Synthetic entry route'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}
