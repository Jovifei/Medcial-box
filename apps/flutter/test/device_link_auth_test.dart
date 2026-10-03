import 'dart:convert';

import 'package:home_medicine_flutter/data/private_atomic_state.dart';
import 'package:home_medicine_flutter/data/session_identity_state.dart';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:home_medicine_flutter/data/api_auth_repository.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';

void main() {
  test(
    'device link keeps poll token private and saves approved session securely',
    () async {
      final secrets = MemorySecretStore();
      final state = SessionIdentityState(
        origin: 'https://medicine.example',
        secrets: secrets,
        persistence: MemoryPrivateAtomicState(),
      );
      await state.initialize();
      state.finishLegacyQuarantine();
      final local = MemoryInventoryLocalStore();
      await local.saveInventory([
        MedicineRecord(
          id: 'from-previous-account',
          name: '旧家庭缓存',
          batches: const [],
        ),
      ]);
      var pollCalls = 0;
      final repository = ApiAuthRepository(
        api: ApiClient(
          baseUrl: 'https://medicine.example',
          tokenProvider: state.readAccessToken,
          identityState: state,
          client: MockClient((request) async {
            if (request.url.path.endsWith('/auth/device-links')) {
              expect(request.headers.containsKey('authorization'), isFalse);
              return http.Response.bytes(
                utf8.encode(
                  jsonEncode({
                    'code': '123456',
                    'pollToken': 'private-poll-token',
                    'expiresAt': '2026-09-28T03:05:00.000Z',
                  }),
                ),
                201,
              );
            }
            expect(request.url.path, endsWith('/auth/device-links/exchange'));
            expect(request.headers.containsKey('authorization'), isFalse);
            final body = jsonDecode(request.body) as Map<String, dynamic>;
            expect(body['pollToken'], 'private-poll-token');
            pollCalls++;
            if (pollCalls == 1) {
              return http.Response.bytes(
                utf8.encode(jsonEncode({'state': 'pending'})),
                200,
              );
            }
            return http.Response.bytes(
              utf8.encode(
                jsonEncode({
                  'state': 'approved',
                  'token': 'session-token',
                  'expiresAt': '2026-10-28T03:00:00.000Z',
                  'user': {'id': 'u1', 'hasFamily': true},
                }),
              ),
              200,
            );
          }),
        ),
        secretStore: secrets,
        localStore: local,
      );

      final link = await repository.startDeviceLink();
      expect(link.code, '123456');
      expect(await secrets.read(ApiAuthRepository.accessTokenKey), isNull);
      expect(
        (jsonDecode(
          (await secrets.read(ApiAuthRepository.pendingPollTokenKey))!,
        ) as Map)['pollToken'],
        'private-poll-token',
      );

      final pending = await repository.exchangePendingLink();
      expect(pending.state, 'pending');
      expect(await secrets.read(ApiAuthRepository.accessTokenKey), isNull);
      expect((await local.readInventory())!.single.id, 'from-previous-account');

      final approved = await repository.exchangePendingLink();
      expect(approved.state, 'approved');
      expect(await repository.readAccessToken(), 'session-token');
      expect(await secrets.read(ApiAuthRepository.pendingPollTokenKey), isNull);
      expect(await local.readInventory(), isNull);
    },
  );

  test('missing API base reports actionable configuration help', () {
    expect(
      missingApiConfigurationMessage,
      contains('--dart-define=API_BASE_URL=https://'),
    );
  });
}
