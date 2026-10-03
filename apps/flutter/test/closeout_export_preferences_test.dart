import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';

void main() {
  test('PDF and its preview use one immutable authorized snapshot', () async {
    final paths = <String>[];
    final repo = ApiWorkflowRepository(
      api: ApiClient(
        baseUrl: 'https://medicine.example',
        tokenProvider: () async => 'test',
        client: MockClient((request) async {
          paths.add(request.url.path);
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          expect(body['includePersonalDosage'], false);
          expect(body['includeArchived'], true);
          expect(body['includeStorageLocation'], false);
          if (request.url.path.endsWith('/snapshot')) {
            return http.Response(
              jsonEncode({'snapshotId': 'same-snapshot'}),
              200,
            );
          }
          expect(body['snapshotId'], 'same-snapshot');
          return http.Response(
            jsonEncode(
              request.url.path.endsWith('/markdown')
                  ? {'markdown': 'snapshot text'}
                  : {
                      'contentBase64': base64Encode([37, 80, 68, 70]),
                    },
            ),
            200,
          );
        }),
      ),
    );
    final result = await repo.exportSnapshotFormat(
      format: 'pdf',
      includePersonalDosage: false,
      includeArchived: true,
      includeStorageLocation: false,
    );
    expect(paths, [
      '/api/v1/exports/snapshot',
      '/api/v1/exports/markdown',
      '/api/v1/exports/pdf',
    ]);
    expect(result['markdown'], 'snapshot text');
    expect(base64Decode(result['contentBase64'] as String), [37, 80, 68, 70]);
  });
  test(
    'reminder preferences preserve independent channels and clock',
    () async {
      final repo = ApiWorkflowRepository(
        api: ApiClient(
          baseUrl: 'https://medicine.example',
          tokenProvider: () async => 'test',
          client: MockClient((request) async {
            expect(request.method, 'PUT');
            expect(jsonDecode(request.body), {
              'stockReminderTime': '10:30',
              'channels': ['wechat', 'android'],
            });
            return http.Response('{}', 200);
          }),
        ),
      );
      await repo.updateNotificationPreferences(
        stockReminderTime: '10:30',
        channels: ['wechat', 'android'],
      );
    },
  );
}
