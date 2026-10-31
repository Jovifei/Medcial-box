import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_auth_repository.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/features/home/production_shell.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  testWidgets(
    'loading, failure and successful empty inventory have distinct messages',
    (tester) async {
      final medicineResponse = Completer<http.Response>();
      var attempts = 0;
      final store = MemoryInventoryLocalStore();
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => 'synthetic-token',
        client: MockClient((request) async {
          if (request.url.path == '/api/v1/medicines') {
            attempts++;
            if (attempts == 1) return medicineResponse.future;
            return http.Response(jsonEncode({'medicines': []}), 200);
          }
          if (request.url.path == '/api/v1/families/current') {
            return http.Response(
              jsonEncode({
                'family': {'id': 'family-a', 'name': '家庭', 'role': 'owner'},
              }),
              200,
              headers: {'content-type': 'application/json; charset=utf-8'},
            );
          }
          if (request.url.path == '/api/v1/notifications/pending') {
            return http.Response(jsonEncode({'items': []}), 200);
          }
          throw StateError('Unexpected request ${request.url.path}');
        }),
      );
      addTearDown(api.close);
      await tester.pumpWidget(
        MaterialApp(
          home: CabinetHomePage(
            repository: ApiMedicineRepository(api: api, localStore: store),
            familyRepository: ApiFamilyRepository(api: api, localStore: store),
            workflow: ApiWorkflowRepository(api: api),
          ),
        ),
      );
      await tester.pump();
      expect(find.text('还没有记录药品'), findsNothing);
      expect(find.text('没有匹配结果'), findsNothing);
      medicineResponse.complete(
        http.Response(
          jsonEncode({
            'error': {'code': 'UNAVAILABLE', 'message': '暂时无法读取药箱'},
          }),
          503,
          headers: {'content-type': 'application/json; charset=utf-8'},
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('暂时无法读取药箱'), findsOneWidget);
      expect(find.text('没有匹配结果'), findsNothing);
      expect(find.text('还没有记录药品'), findsNothing);
      await tester.tap(find.text('重新加载'));
      await tester.pumpAndSettle();
      expect(find.text('暂时无法读取药箱'), findsNothing);
      expect(find.text('还没有记录药品'), findsOneWidget);
      await tester.tap(find.text('状态 ▾'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('已归档'));
      await tester.pumpAndSettle();
      expect(find.text('已归档药品'), findsOneWidget);
      expect(find.text('暂无已归档药品'), findsOneWidget);
    },
  );

  testWidgets(
    'medicine card labels management expiry separately from package expiry',
    (tester) async {
      final store = MemoryInventoryLocalStore();
      final api = ApiClient(
        baseUrl: 'https://medicine.example',
        tokenProvider: () async => 'token',
        client: MockClient((request) async {
          if (request.url.path == '/api/v1/medicines') {
            return http.Response(
              jsonEncode({
                'medicines': [
                  {
                    'id': 'medicine-a',
                    'name': '合成长药名',
                    'specification': '长规格 20 粒每盒',
                    'batches': [
                      {
                        'id': 'batch-a',
                        'expiry': {'value': '2027-12-31', 'precision': 'day'},
                        'managementExpiryDate': '2026-12-31',
                        'quantity': 2,
                        'unit': 'box',
                      },
                    ],
                    'stockStatus': {
                      'state': 'normal',
                      'quantity': 2,
                      'unit': 'box',
                    },
                  },
                ],
              }),
              200,
              headers: {'content-type': 'application/json; charset=utf-8'},
            );
          }
          if (request.url.path == '/api/v1/families/current') {
            return http.Response(
              jsonEncode({
                'family': {'id': 'family-a', 'name': '家庭', 'role': 'owner'},
              }),
              200,
              headers: {'content-type': 'application/json; charset=utf-8'},
            );
          }
          if (request.url.path == '/api/v1/notifications/pending') {
            return http.Response(
              jsonEncode({'items': []}),
              200,
              headers: {'content-type': 'application/json; charset=utf-8'},
            );
          }
          throw StateError('Unexpected request ${request.url.path}');
        }),
      );
      addTearDown(api.close);
      await tester.pumpWidget(
        MaterialApp(
          home: CabinetHomePage(
            repository: ApiMedicineRepository(api: api, localStore: store),
            familyRepository: ApiFamilyRepository(api: api, localStore: store),
            workflow: ApiWorkflowRepository(api: api),
          ),
        ),
      );
      api.refreshIdentityContext = () async => null;
      await tester.pumpAndSettle();
      expect(find.text('管理期限'), findsOneWidget);
      expect(find.text('最早期限：2026-12-31'), findsOneWidget);
      expect(find.text('包装有效期'), findsNothing);
      expect(find.text('合成长药名'), findsOneWidget);
    },
  );
}
