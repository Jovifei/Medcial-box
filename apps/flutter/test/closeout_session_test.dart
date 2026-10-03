import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:home_medicine_flutter/data/api_client.dart';

void main() {
  test('late 401 does not clear newer token', () async {
    var token = 'old';
    var cleared = 0;
    final gate = Completer<void>();
    final api = ApiClient(
      baseUrl: 'https://medicine.example',
      tokenProvider: () async => token,
      client: MockClient((r) async {
        await gate.future;
        return http.Response('{}', 401);
      }),
    );
    api.onUnauthorized = () async {
      cleared++;
    };
    final pending = api.get('/test');
    await Future<void>.delayed(Duration.zero);
    token = 'new';
    gate.complete();
    await expectLater(pending, throwsA(isA<ApiException>()));
    expect(cleared, 0);
  });
}
