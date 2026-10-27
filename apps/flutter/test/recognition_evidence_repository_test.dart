import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  test(
    'photo deletion rejects an identity change during token lookup',
    () async {
      final entered = Completer<void>();
      final token = Completer<String?>();
      var current = true;
      var calls = 0;
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async {
          entered.complete();
          return token.future;
        },
        client: MockClient((_) async {
          calls++;
          return http.Response('', 204);
        }),
      );
      addTearDown(api.close);
      final result = ApiWorkflowRepository(api: api)
          .deleteLeafletPhoto('medicine', 'photo', isCurrent: () => current);
      final rejected = expectLater(result, throwsA(isA<ApiException>()));
      await entered.future;
      current = false;
      token.complete('old-token');
      await rejected;
      expect(calls, 0);
    },
  );

  test('late deletion response is rejected after an identity change', () async {
    final entered = Completer<void>();
    final response = Completer<http.Response>();
    var current = true;
    final api = ApiClient(
      baseUrl: 'https://synthetic.invalid',
      tokenProvider: () async => 'old-token',
      client: MockClient((_) {
        entered.complete();
        return response.future;
      }),
    );
    addTearDown(api.close);
    final result = ApiWorkflowRepository(api: api)
        .deleteLeafletPhoto('medicine', 'photo', isCurrent: () => current);
    final rejected = expectLater(result, throwsA(isA<ApiException>()));
    await entered.future;
    current = false;
    response.complete(http.Response('', 204));
    await rejected;
  });

  test(
    'reads per-photo evidence and sends an unchanged persisted request',
    () async {
      final requests = <http.Request>[];
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => 'synthetic',
        client: MockClient((request) async {
          requests.add(request);
          return http.Response.bytes(
            utf8.encode(
              jsonEncode({
                'evidence': {
                  'schemaVersion': 1,
                  'revision': 2,
                  'medicineVersion': 3,
                  'currentMedicineVersion': 3,
                  'stale': false,
                  'photos': [
                    {
                      'photoId': 'p1',
                      'sequence': 2,
                      'status': 'recognized',
                      'fields': {'name': '合成药'},
                      'warnings': ['核对合成警告'],
                      'available': true,
                    },
                  ],
                  'fieldSources': {
                    'name': {
                      'source': 'recognized',
                      'photoIds': ['p1'],
                      'reviewed': true,
                    },
                  },
                },
              }),
            ),
            200,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
        }),
      );
      addTearDown(api.close);
      final repository = ApiWorkflowRepository(api: api);
      final evidence = await repository.getRecognitionEvidence('medicine');
      expect(evidence!.photos.single.sequence, 2);
      expect(evidence.photos.single.fields['name'], '合成药');
      expect(evidence.photos.single.warnings, ['核对合成警告']);
      expect(evidence.fieldSources['name']!.photoIds, ['p1']);
      final payload = <String, dynamic>{
        'schemaVersion': 1,
        'revision': 1,
        'medicineVersion': 3,
        'idempotencyKey': 'synthetic_key_1234',
        'photos': <Object>[],
        'fieldSources': <String, Object>{},
      };
      await repository.saveRecognitionEvidence('medicine', payload);
      expect(requests.last.method, 'POST');
      expect(jsonDecode(requests.last.body), payload);
      expect(
        requests.last.url.path,
        '/api/v1/medicines/medicine/recognition-evidence',
      );
    },
  );
}
