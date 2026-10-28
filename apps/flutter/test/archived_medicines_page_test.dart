import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/private_atomic_state.dart';
import 'package:home_medicine_flutter/data/session_identity_state.dart';
import 'package:home_medicine_flutter/features/medicine/archived_medicines_page.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  testWidgets('unconfirmed family never sends a request', (tester) async {
    var calls = 0;
    final identity = SessionIdentityState(
      origin: 'https://synthetic.invalid',
      secrets: MemorySecretStore(),
      persistence: MemoryPrivateAtomicState(),
    );
    final api = ApiClient(
      baseUrl: 'https://synthetic.invalid',
      tokenProvider: () async => 'token',
      identityState: identity,
      client: MockClient((_) async {
        calls++;
        return http.Response('{}', 200);
      }),
    );
    addTearDown(api.close);
    await tester.pumpWidget(
      MaterialApp(
        home: ArchivedMedicinesPage(workflow: ApiWorkflowRepository(api: api)),
      ),
    );
    await tester.pumpAndSettle();
    expect(calls, 0);
    expect(find.text('家庭已变更，请返回药箱重新打开。'), findsOneWidget);
  });

  testWidgets('only archived medicines are shown as read-only details', (
    tester,
  ) async {
    final requests = <http.Request>[];
    final api = ApiClient(
      baseUrl: 'https://synthetic.invalid',
      tokenProvider: () async => 'token',
      client: MockClient((request) async {
        requests.add(request);
        return http.Response(
          jsonEncode({
            'medicines': [
              {
                'id': '1',
                'name': '归档药',
                'isArchived': true,
                'specification': '10片',
                'manufacturer': '合成厂家',
                'batches': [],
              },
              {'id': '2', 'name': '在库药', 'isArchived': false},
            ],
          }),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      }),
    );
    addTearDown(api.close);
    await tester.pumpWidget(
      MaterialApp(
        home: ArchivedMedicinesPage(workflow: ApiWorkflowRepository(api: api)),
      ),
    );
    await tester.pumpAndSettle();
    expect(requests.single.method, 'GET');
    expect(requests.single.url.queryParameters['includeArchived'], 'true');
    expect(find.text('归档药'), findsOneWidget);
    expect(find.text('在库药'), findsNothing);
    await tester.tap(find.text('归档药'));
    await tester.pumpAndSettle();
    expect(find.text('厂家：合成厂家'), findsOneWidget);
    expect(find.textContaining('暂不支持恢复'), findsOneWidget);
    expect(requests.length, 1);
    api.invalidateIdentity();
    await tester.pump();
    expect(find.text('归档药'), findsNothing);
    expect(find.text('厂家：合成厂家'), findsNothing);
    expect(find.text('家庭已变更，请返回药箱重新打开。'), findsOneWidget);
  });

  testWidgets('failed requests show retry instead of empty result', (
    tester,
  ) async {
    var calls = 0;
    final api = ApiClient(
      baseUrl: 'https://synthetic.invalid',
      tokenProvider: () async => 'token',
      client: MockClient((_) async {
        calls++;
        return calls == 1
            ? http.Response('{}', 500)
            : http.Response('{"medicines":[]}', 200);
      }),
    );
    addTearDown(api.close);
    await tester.pumpWidget(
      MaterialApp(
        home: ArchivedMedicinesPage(workflow: ApiWorkflowRepository(api: api)),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('重新加载'), findsOneWidget);
    expect(find.text('暂无已归档药品'), findsNothing);
    await tester.tap(find.text('重新加载'));
    await tester.pumpAndSettle();
    expect(find.text('暂无已归档药品'), findsOneWidget);
  });

  testWidgets(
    'identity change removes visible data and rejects late response',
    (tester) async {
      final response = Completer<http.Response>();
      var cleaned = false;
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => 'token',
        client: MockClient((_) => response.future),
      );
      api.onUnauthorized = () async {
        cleaned = true;
      };
      addTearDown(api.close);
      await tester.pumpWidget(
        MaterialApp(
          home: ArchivedMedicinesPage(
            workflow: ApiWorkflowRepository(api: api),
          ),
        ),
      );
      await tester.pump();
      api.invalidateIdentity();
      await tester.pump();
      response.complete(
        http.Response('{"error":{"code":"UNAUTHENTICATED"}}', 401),
      );
      await tester.pumpAndSettle();
      expect(cleaned, isFalse);
      expect(find.text('家庭已变更，请返回药箱重新打开。'), findsOneWidget);
      expect(find.text('暂无已归档药品'), findsNothing);
    },
  );
}
