import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';

import 'dart:typed_data';

void main() {
  test('barcode candidates are queried only with explicit consent and never upload an image', () async {
    final repository = ApiWorkflowRepository(
      api: ApiClient(
        baseUrl: 'https://medicine.example',
        tokenProvider: () async => 'session-token',
        client: MockClient((request) async {
          expect(request.method, 'POST');
          expect(request.url.path, '/api/v1/medicine-catalog/candidates');
          expect(request.headers['authorization'], 'Bearer session-token');
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          expect(body['barcode'], '6901234567890');
          expect(body['consentToShare'], isTrue);
          expect(body.keys, isNot(contains('image')));
          return http.Response.bytes(
            utf8.encode(
              jsonEncode({
                'candidates': [
                  {'name': '候选药品', 'source': 'provider'},
                ],
                'warnings': ['需要人工核对'],
              }),
            ),
            200,
          );
        }),
      ),
    );

    final result = await repository.searchMedicineCandidates(
      barcode: '6901234567890',
      consentToShare: true,
    );

    expect((result['candidates'] as List).single['name'], '候选药品');
  });

  test(
    'backup restore requires and sends the one-time preview confirmation token',
    () async {
      final requests = <http.Request>[];
      final repository = ApiWorkflowRepository(
        api: ApiClient(
          baseUrl: 'https://medicine.example',
          tokenProvider: () async => 'session-token',
          client: MockClient((request) async {
            requests.add(request);
            if (request.url.path == '/api/v1/backups/preview') {
              return http.Response.bytes(
                utf8.encode(
                  jsonEncode({
                    'valid': true,
                    'duplicateBackup': false,
                    'confirmationToken': 'a' * 64,
                    'medicineCount': 0,
                    'likelyMatches': [],
                    'errors': [],
                    'inventorySettings': {'stocktakeInterval': 'monthly'},
                  }),
                ),
                200,
              );
            }
            return http.Response.bytes(
              utf8.encode('{"restoredCount":0,"backupId":"backup-1"}'),
              201,
            );
          }),
        ),
      );
      final backup = {'backupId': 'backup-1', 'medicines': <dynamic>[]};

      final preview = await repository.previewJsonRestore(backup);
      expect(preview['inventorySettings'], {'stocktakeInterval': 'monthly'});
      await repository.restoreJsonBackup(
        backup,
        preview['confirmationToken'] as String,
      );

      expect(requests.map((request) => request.url.path), [
        '/api/v1/backups/preview',
        '/api/v1/backups/restore',
      ]);
      final restoreBody = jsonDecode(requests[1].body) as Map<String, dynamic>;
      expect(restoreBody['confirmationToken'], 'a' * 64);
      expect(restoreBody['confirmed'], isTrue);
      expect(restoreBody['backup'], backup);
    },
  );

  test('leaflet photos upload privately and use authenticated list, read and delete requests', () async {
    final png = base64Decode(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLJsgAAAABJRU5ErkJggg==',
    );
    final requests = <http.Request>[];
    final repository = ApiWorkflowRepository(
      api: ApiClient(
        baseUrl: 'https://medicine.example',
        tokenProvider: () async => 'session-token',
        client: MockClient((request) async {
          requests.add(request);
          expect(request.headers['authorization'], 'Bearer session-token');
          if (request.method == 'POST') {
            final body = jsonDecode(request.body) as Map<String, dynamic>;
            expect(base64Decode(body['imageBase64'] as String), png);
            expect(body['mimeType'], 'image/png');
            expect(body['source'], 'package_leaflet');
            return http.Response.bytes(
              utf8.encode(jsonEncode({'photo': _leafletPhotoJson()})),
              201,
            );
          }
          if (request.method == 'GET' &&
              request.url.path.endsWith('/leaflet-photos')) {
            return http.Response.bytes(
              utf8.encode(
                jsonEncode({
                  'photos': [_leafletPhotoJson()],
                }),
              ),
              200,
            );
          }
          if (request.method == 'GET') {
            return http.Response.bytes(
              png,
              200,
              headers: {'content-type': 'image/png'},
            );
          }
          expect(request.method, 'DELETE');
          return http.Response('', 204);
        }),
      ),
    );

    final uploaded = await repository.uploadLeafletPhoto(
      'medicine-1',
      Uint8List.fromList(png),
      mimeType: 'image/png',
    );
    final listed = await repository.listLeafletPhotos('medicine-1');
    final image = await repository.readLeafletPhoto('medicine-1', uploaded.id);
    await repository.deleteLeafletPhoto('medicine-1', uploaded.id);

    expect(uploaded.id, 'photo-1');
    expect(listed.single.contentType, 'image/png');
    expect(image.contentType, 'image/png');
    expect(image.bytes, png);
    expect(requests.map((request) => request.method), [
      'POST',
      'GET',
      'GET',
      'DELETE',
    ]);
  });
}

Map<String, dynamic> _leafletPhotoJson() => {
  'id': 'photo-1',
  'medicineId': 'medicine-1',
  'contentType': 'image/png',
  'sizeBytes': 68,
  'source': 'package_leaflet',
  'createdAt': '2026-09-29T02:00:00.000Z',
  'url': '/api/v1/medicines/medicine-1/leaflet-photos/photo-1',
};
