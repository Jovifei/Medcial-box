import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/medicine_recognition.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:image_picker/image_picker.dart';

Uint8List _photo() {
  final bytes = Uint8List(128);
  bytes.setRange(0, 3, [255, 216, 255]);
  bytes.setRange(126, 128, [255, 217]);
  return bytes;
}

class _GatedImage extends XFile {
  _GatedImage(this.stage) : super('synthetic-memory-only');
  final String stage;
  final started = Completer<void>();
  final resume = Completer<void>();
  int reads = 0;
  Future<void> _wait(String point) async {
    if (stage == point) {
      started.complete();
      await resume.future;
    }
  }

  @override
  Future<int> length() async {
    await _wait('length');
    return 128;
  }

  @override
  Future<Uint8List> readAsBytes() async {
    reads++;
    await _wait('read');
    return _photo();
  }
}

void main() {
  for (final stage in ['length', 'read']) {
    for (final transition in ['family', 'same-family-user', 'ABA']) {
      test(
        'identity $transition during $stage sends zero photo requests',
        () async {
          var user = 'user-A';
          var family = 'family-A';
          var calls = 0;
          var tokenReads = 0;
          final api = ApiClient(
            baseUrl: 'https://synthetic.invalid',
            tokenProvider: () async {
              tokenReads++;
              return '$user-$family';
            },
            client: MockClient((request) async {
              calls++;
              return http.Response('{"draft":{}}', 200);
            }),
          );
          addTearDown(api.close);
          final image = _GatedImage(stage);
          final result = ApiMedicineRecognitionRepository(api).recognize(image);
          final blocked = expectLater(
            result,
            throwsA(
              isA<ApiException>().having(
                (error) => error.code,
                'code',
                'STALE_SESSION',
              ),
            ),
          );
          await image.started.future;
          if (transition == 'same-family-user') {
            user = 'user-B';
          } else {
            family = 'family-B';
          }
          api.invalidateIdentity();
          if (transition == 'ABA') {
            family = 'family-A';
            api.invalidateIdentity();
          }
          image.resume.complete();
          await blocked;
          expect(calls, 0);
          expect(tokenReads, 0);
          expect(image.reads, stage == 'length' ? 0 : 1);
        },
      );
    }
  }

  for (final stage in ['before-read', 'length', 'read', 'token']) {
    test('cancelled operation at $stage sends zero photo requests', () async {
      var current = stage != 'before-read';
      var calls = 0;
      var tokenReads = 0;
      final tokenEntered = Completer<void>();
      final tokenResume = Completer<String?>();
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async {
          tokenReads++;
          tokenEntered.complete();
          return tokenResume.future;
        },
        client: MockClient((request) async {
          calls++;
          return http.Response('{"draft":{}}', 200);
        }),
      );
      addTearDown(api.close);
      final image = _GatedImage(stage);
      final result = ApiMedicineRecognitionRepository(
        api,
        isCurrent: () => current,
      ).recognize(image);
      final blocked = expectLater(
        result,
        throwsA(
          isA<ApiException>().having(
            (error) => error.code,
            'code',
            'STALE_SESSION',
          ),
        ),
      );
      if (stage == 'token') {
        await tokenEntered.future;
        current = false;
        tokenResume.complete('replacement-session');
      } else if (stage != 'before-read') {
        await image.started.future;
        current = false;
        image.resume.complete();
      }
      await blocked;
      expect(calls, 0);
      expect(tokenReads, stage == 'token' ? 1 : 0);
      expect(image.reads, stage == 'before-read' || stage == 'length' ? 0 : 1);
    });
  }

  test(
    'current operation survives asynchronous image and token reads',
    () async {
      var calls = 0;
      final image = _GatedImage('read');
      final tokenEntered = Completer<void>();
      final tokenResume = Completer<String?>();
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async {
          tokenEntered.complete();
          return tokenResume.future;
        },
        client: MockClient((request) async {
          calls++;
          expect(request.headers['authorization'], 'Bearer original-session');
          return http.Response('{"draft":{"name":"Synthetic draft"}}', 200);
        }),
      );
      addTearDown(api.close);
      final result = ApiMedicineRecognitionRepository(
        api,
        isCurrent: () => true,
      ).recognize(image);
      await image.started.future;
      image.resume.complete();
      await tokenEntered.future;
      tokenResume.complete('original-session');
      expect((await result).name, 'Synthetic draft');
      expect(calls, 1);
    },
  );

  test(
    'late cancelled response cannot invalidate a replacement operation',
    () async {
      var current = true;
      var cleanups = 0;
      final entered = Completer<void>();
      final response = Completer<http.Response>();
      final api = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => 'original-session',
        client: MockClient((request) async {
          entered.complete();
          return response.future;
        }),
      );
      api.onUnauthorized = () async {
        cleanups++;
      };
      addTearDown(api.close);
      final result = ApiMedicineRecognitionRepository(
        api,
        isCurrent: () => current,
      ).recognize(XFile.fromData(_photo()));
      final blocked = expectLater(
        result,
        throwsA(
          isA<ApiException>().having(
            (error) => error.code,
            'code',
            'STALE_SESSION',
          ),
        ),
      );
      await entered.future;
      current = false;
      response.complete(
        http.Response(
          '{"error":{"code":"UNAUTHORIZED","message":"expired"}}',
          401,
        ),
      );
      await blocked;
      expect(cleanups, 0);
    },
  );
}
