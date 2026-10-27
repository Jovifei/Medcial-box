import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/features/medicine/medicine_detail_api_page.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  testWidgets(
    'stock precedes photo information and each leaflet summary appears once',
    (tester) async {
      tester.view.physicalSize = const Size(900, 3000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => null,
        client: MockClient(
          (request) async => http.Response(
            jsonEncode(
              request.url.path.endsWith('dosage-notes')
                  ? {'notes': []}
                  : {
                      'id': 'medicine',
                      'name': '合成药品',
                      'batches': [],
                      'leaflet': {
                        'purposeSummary': '合成用途摘要',
                        'packageUsageSummary': '合成用量摘要',
                        'reviewStatus': 'unverified',
                      },
                    },
            ),
            200,
            headers: {'content-type': 'application/json'},
          ),
        ),
      );
      addTearDown(api.close);
      await tester.pumpWidget(
        MaterialApp(
          home: MedicineDetailApiPage(
            repository: ApiMedicineRepository(
              api: api,
              localStore: MemoryInventoryLocalStore(),
            ),
            workflow: ApiWorkflowRepository(api: api),
            medicineId: 'medicine',
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        tester.getTopLeft(find.text('库存批次')).dy,
        lessThan(tester.getTopLeft(find.text('说明书与资料来源')).dy),
      );
      await tester.tap(find.text('说明书与资料来源'));
      await tester.pumpAndSettle();
      expect(find.textContaining('合成用途摘要'), findsOneWidget);
      expect(find.textContaining('合成用量摘要'), findsOneWidget);
      expect(find.text('查看或添加说明书照片'), findsOneWidget);
    },
  );

  testWidgets(
    'long names and stock actions remain readable at 320 width and double text',
    (tester) async {
      tester.view.physicalSize = const Size(320, 800);
      tester.view.devicePixelRatio = 1;
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => null,
        client: MockClient(
          (request) async => http.Response(
            jsonEncode(
              request.url.path.endsWith('dosage-notes')
                  ? {'notes': []}
                  : {
                      'id': 'medicine',
                      'name': '用于测试换行的很长很长的药品名称',
                      'batches': [
                        {
                          'id': 'batch',
                          'quantity': 2,
                          'unit': 'box',
                          'expiry': {'value': '2028-12-31', 'precision': 'day'},
                        },
                      ],
                      'leaflet': {'reviewStatus': 'unverified'},
                    },
            ),
            200,
            headers: {'content-type': 'application/json'},
          ),
        ),
      );
      addTearDown(api.close);
      await tester.pumpWidget(
        MaterialApp(
          home: MedicineDetailApiPage(
            repository: ApiMedicineRepository(
              api: api,
              localStore: MemoryInventoryLocalStore(),
            ),
            workflow: ApiWorkflowRepository(api: api),
            medicineId: 'medicine',
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('用于测试换行的很长很长的药品名称'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('修改库存批次'), 180);
      await tester.pumpAndSettle();
      expect(find.text('修改库存批次'), findsWidgets);
      expect(tester.takeException(), isNull);
    },
  );
}
