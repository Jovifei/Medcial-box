import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:image_picker/image_picker.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/medicine_recognition.dart';

Uint8List photo({bool png = false}) {
  final bytes = Uint8List(128);
  bytes.setRange(
    0,
    png ? 8 : 3,
    png ? [137, 80, 78, 71, 13, 10, 26, 10] : [255, 216, 255],
  );
  bytes.setRange(
    png ? 120 : 126,
    128,
    png ? [73, 69, 78, 68, 174, 66, 96, 130] : [255, 217],
  );
  return bytes;
}

ApiMedicineRecognitionRepository repository(
  Future<http.Response> Function(http.Request) handler,
) => ApiMedicineRecognitionRepository(
  ApiClient(
    baseUrl: 'https://medicine.example',
    tokenProvider: () async => 'test-token',
    client: MockClient(handler),
  ),
);

void main() {
  for (final png in [false, true]) {
    test(
      'uploads validated ${png ? 'PNG' : 'JPEG'} and maps review draft',
      () async {
        final bytes = photo(png: png);
        final api = repository((request) async {
          expect(request.method, 'POST');
          expect(request.url.path, '/api/v1/recognitions/medicine');
          expect(request.headers['authorization'], 'Bearer test-token');
          final payload = jsonDecode(request.body) as Map<String, dynamic>;
          expect(payload['mimeType'], png ? 'image/png' : 'image/jpeg');
          expect(base64Decode(payload['imageBase64'] as String), bytes);
          return http.Response.bytes(
            utf8.encode(
              jsonEncode({
                'draft': {
                  'name': ' 测试凝胶 ',
                  'specification': '20g',
                  'expiryValue': '2028-03',
                  'purposeCategory': '外用',
                },
                'warnings': ['请核对包装'],
                'requiresConfirmation': true,
              }),
            ),
            200,
          );
        });
        final draft = await api.recognize(
          XFile.fromData(bytes, name: 'photo.bin'),
        );
        expect(draft.name, '测试凝胶');
        expect(draft.specification, '20g');
        expect(draft.expiry, '2028-03');
        expect(draft.purposeCategory, '外用');
        expect(draft.purposeTags, isEmpty);
        expect(draft.warnings, ['请核对包装']);
      },
    );
  }

  test('rejects invalid and oversized images before sending', () async {
    var calls = 0;
    final api = repository((_) async {
      calls++;
      return http.Response('{}', 200);
    });
    for (final bytes in [Uint8List(127), Uint8List(128), Uint8List(4194305)]) {
      await expectLater(
        api.recognize(XFile.fromData(bytes)),
        throwsA(isA<FormatException>()),
      );
    }
    expect(calls, 0);
  });

  test('missing fields remain unconfirmed rather than invented', () async {
    final api = repository((_) async => http.Response('{"draft":{}}', 200));
    final draft = await api.recognize(XFile.fromData(photo()));
    expect(draft.name, '');
    expect(draft.expiry, '待补充');
    expect(draft.purposeCategory, isNull);
  });

  test('propagates provider failure and rejects malformed response', () async {
    final unavailable = repository(
      (_) async => http.Response(
        '{"error":{"code":"RECOGNITION_UNAVAILABLE","message":"unavailable"}}',
        503,
      ),
    );
    await expectLater(
      unavailable.recognize(XFile.fromData(photo())),
      throwsA(isA<ApiException>()),
    );
    final malformed = repository(
      (_) async => http.Response('{"draft":[]}', 200),
    );
    await expectLater(
      malformed.recognize(XFile.fromData(photo())),
      throwsA(isA<FormatException>()),
    );
  });
}

