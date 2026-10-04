import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:home_medicine_flutter/data/api_auth_repository.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/private_atomic_state.dart';
import 'package:home_medicine_flutter/data/session_identity_state.dart';

Future<ApiAuthRepository> repository(
  String origin,
  List<String> paths, {
  bool marker = true,
}) async {
  final secrets = MemorySecretStore();
  final state = SessionIdentityState(
    origin: origin,
    secrets: secrets,
    persistence: MemoryPrivateAtomicState(),
  );
  await state.initialize();
  state.finishLegacyQuarantine();
  final api = ApiClient(
    baseUrl: origin,
    tokenProvider: state.readAccessToken,
    identityState: state,
    client: MockClient((request) async {
      paths.add(request.url.path);
      final Object body = request.url.path.endsWith('local-app-trial')
          ? {'mode': marker ? 'local-app-trial' : 'production'}
          : request.url.path.endsWith('wechat')
          ? {'token': 'synthetic-trial-token'}
          : {
              'user': {'id': 'trial-user', 'nickname': null, 'hasFamily': true},
              'family': {
                'id': 'trial-family',
                'name': '本机试用家庭',
                'role': 'owner',
              },
            };
      return http.Response(
        jsonEncode(body),
        200,
        headers: {'content-type': 'application/json'},
      );
    }),
  );
  return ApiAuthRepository(
    api: api,
    secretStore: secrets,
    localStore: MemoryInventoryLocalStore(),
  );
}

void main() {
  test('trial is opt-in and cannot contact remote origins', () async {
    for (final origin in [
      'http://127.0.0.1:13300',
      'https://medicine.example',
    ]) {
      final paths = <String>[];
      final auth = await repository(origin, paths);
      await expectLater(auth.startLocalTrial(), throwsStateError);
      if (origin.startsWith('https')) {
        await expectLater(
          auth.startLocalTrial(enabled: true),
          throwsStateError,
        );
      }
      expect(paths, isEmpty);
    }
  });
  test(
    'local service must declare trial capability before authentication',
    () async {
      final paths = <String>[];
      final auth = await repository(
        'http://127.0.0.1:13300',
        paths,
        marker: false,
      );
      await expectLater(auth.startLocalTrial(enabled: true), throwsStateError);
      expect(paths, ['/api/v1/health/local-app-trial']);
      expect(await auth.readAccessToken(), isNull);
    },
  );
  test('trial retains normal credential and verified owner fences without link code', () async {
    final paths = <String>[];
    final auth = await repository('http://127.0.0.1:13300', paths);
    await auth.startLocalTrial(enabled: true);
    final profile = await auth.getCurrentUser();
    expect(profile.family?.id, 'trial-family');
    expect(auth.identityState.owner?.userId, 'trial-user');
    expect(await auth.readAccessToken(), 'synthetic-trial-token');
    expect(paths, [
      '/api/v1/health/local-app-trial',
      '/api/v1/auth/wechat',
      '/api/v1/auth/me',
    ]);
  });
}
