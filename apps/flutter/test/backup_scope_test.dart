import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  test(
    'full and inventory-only backups send distinct, explicit scopes',
    () async {
      final requests = <Map<String, dynamic>>[];
      final api = ApiClient(
        baseUrl: 'https://medicine.example',
        tokenProvider: () async => 'synthetic-token',
        client: MockClient((request) async {
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          requests.add(body);
          return http.Response(
            jsonEncode({
              'schemaVersion': 2,
              'contentScope': body['includeRecognitionEvidence'] == false
                  ? 'inventory_only'
                  : 'inventory_and_recognition_evidence',
              'medicines': [],
            }),
            200,
          );
        }),
      );
      addTearDown(api.close);
      final repository = ApiWorkflowRepository(api: api);
      expect(
        (await repository.createJsonBackup())['contentScope'],
        'inventory_and_recognition_evidence',
      );
      expect(
        (await repository.createJsonBackup(
          includeRecognitionEvidence: false,
        ))['contentScope'],
        'inventory_only',
      );
      expect(requests, [
        {},
        {'includeRecognitionEvidence': false},
      ]);
    },
  );

  test(
    'old or misleading responses cannot be treated as a confirmed scope',
    () async {
      Map<String, dynamic> response = {'schemaVersion': 2, 'medicines': []};
      final api = ApiClient(
        baseUrl: 'https://medicine.example',
        tokenProvider: () async => 'synthetic-token',
        client: MockClient(
          (request) async => http.Response(jsonEncode(response), 200),
        ),
      );
      addTearDown(api.close);
      final repository = ApiWorkflowRepository(api: api);
      Future<void> rejects(Future<Map<String, dynamic>> operation) async =>
          expectLater(
            operation,
            throwsA(
              isA<ApiException>().having(
                (error) => error.code,
                'code',
                'BACKUP_SCOPE_UNCONFIRMED',
              ),
            ),
          );
      await rejects(repository.createJsonBackup());
      await rejects(
        repository.createJsonBackup(includeRecognitionEvidence: false),
      );
      response = {
        'schemaVersion': 2,
        'contentScope': 'inventory_and_recognition_evidence',
        'medicines': [],
      };
      await rejects(
        repository.createJsonBackup(includeRecognitionEvidence: false),
      );
      response = {
        'schemaVersion': 2,
        'contentScope': 'inventory_only',
        'medicines': [
          {
            'recognitionEvidence': {'schemaVersion': 1},
          },
        ],
      };
      await rejects(
        repository.createJsonBackup(includeRecognitionEvidence: false),
      );
      response = {
        'schemaVersion': 1,
        'contentScope': 'inventory_only',
        'medicines': [],
      };
      await rejects(
        repository.createJsonBackup(includeRecognitionEvidence: false),
      );
    },
  );
}
