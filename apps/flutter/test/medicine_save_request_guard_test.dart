import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _error(int status) => http.Response(
  jsonEncode({
    'error': {
      'code': status == 401 ? 'UNAUTHORIZED' : 'FAMILY_NOT_FOUND',
      'message': 'synthetic',
    },
  }),
  status,
  headers: {'content-type': 'application/json'},
);

void main() {
  for (final status in [401, 404]) {
    for (final expireAtToken in [false, true]) {
      test(
        'stale $status cannot clean up replacement state at ${expireAtToken ? 'second token' : 'response'} boundary',
        () async {
          var current = true;
          var cleanup = 0;
          var reads = 0;
          final response = Completer<http.Response>();
          final sent = Completer<void>();
          final secondToken = Completer<String?>();
          final secondRead = Completer<void>();
          final api = ApiClient(
            baseUrl: 'https://synthetic.invalid',
            tokenProvider: () async {
              if (++reads == 2) {
                secondRead.complete();
                return secondToken.future;
              }
              return 'synthetic-same-token';
            },
            client: MockClient((_) {
              sent.complete();
              return response.future;
            }),
          );
          addTearDown(api.close);
          api.onUnauthorized = () async => cleanup++;
          api.onFamilyUnavailable = () async => cleanup++;
          final result = api.post(
            '/synthetic',
            isCurrent: () => current,
            responseIsCurrent: () => current,
          );
          final rejected = expectLater(result, throwsA(isA<ApiException>()));
          await sent.future;
          if (expireAtToken) {
            response.complete(_error(status));
            await secondRead.future;
            current = false;
            secondToken.complete('synthetic-same-token');
          } else {
            current = false;
            response.complete(_error(status));
          }
          await rejected;
          expect(cleanup, 0);
          expect(api.identityEpoch, 0);
        },
      );
    }

    test(
      'valid current $status still performs its established cleanup',
      () async {
        var current = true;
        var cleanup = 0;
        final api = ApiClient(
          baseUrl: 'https://synthetic.invalid',
          tokenProvider: () async => 'synthetic',
          client: MockClient((_) async => _error(status)),
        );
        addTearDown(api.close);
        Future<void> clear() async {
          cleanup++;
          current = false;
          api.invalidateIdentity();
        }

        api.onUnauthorized = clear;
        api.onFamilyUnavailable = clear;
        await expectLater(
          api.post(
            '/synthetic',
            isCurrent: () => current,
            responseIsCurrent: () => current,
          ),
          throwsA(
            isA<ApiException>().having((e) => e.statusCode, 'status', status),
          ),
        );
        expect(cleanup, 1);
      },
    );
  }

  for (final status in [200, 401, 404]) {
    test(
      'legacy dispatch-only caller retains late $status response semantics',
      () async {
        var current = true;
        var cleanup = 0;
        final sent = Completer<void>();
        final response = Completer<http.Response>();
        final api = ApiClient(
          baseUrl: 'https://synthetic.invalid',
          tokenProvider: () async => 'synthetic',
          client: MockClient((_) {
            sent.complete();
            return response.future;
          }),
        );
        addTearDown(api.close);
        api.onUnauthorized = () async => cleanup++;
        api.onFamilyUnavailable = () async => cleanup++;
        final result = api.post('/synthetic', isCurrent: () => current);
        final expected = status == 200
            ? expectLater(result, completion({'ack': true}))
            : expectLater(
                result,
                throwsA(
                  isA<ApiException>().having(
                    (e) => e.statusCode,
                    'status',
                    status,
                  ),
                ),
              );
        await sent.future;
        current = false;
        response.complete(
          status == 200 ? http.Response('{"ack":true}', 200) : _error(status),
        );
        await expected;
        expect(cleanup, status == 200 ? 0 : 1);
      },
    );
  }

  for (final operation in ['list', 'get', 'create', 'photo', 'cover']) {
    test(
      '$operation repository forwards intent through token lookup',
      () async {
        var current = true;
        final token = Completer<String?>();
        final entered = Completer<void>();
        var dispatched = 0;
        final api = ApiClient(
          baseUrl: 'https://synthetic.invalid',
          tokenProvider: () {
            entered.complete();
            return token.future;
          },
          client: MockClient((_) async {
            dispatched++;
            return http.Response('{}', 200);
          }),
        );
        addTearDown(api.close);
        final repository = ApiMedicineRepository(
          api: api,
          localStore: MemoryInventoryLocalStore(),
        );
        final workflow = ApiWorkflowRepository(api: api);
        final Future<Object?> result = switch (operation) {
          'list' => repository.listMedicines(isCurrent: () => current),
          'get' => repository.getMedicine(
            'synthetic',
            isCurrent: () => current,
          ),
          'create' => repository.createMedicine({
            'name': 'synthetic',
          }, isCurrent: () => current),
          'photo' => workflow.uploadLeafletPhoto(
            'synthetic',
            Uint8List.fromList([137, 80, 78, 71]),
            mimeType: 'image/png',
            isCurrent: () => current,
          ),
          _ => workflow.setCoverPhoto(
            'synthetic',
            'photo',
            isCurrent: () => current,
          ),
        };
        final rejected = expectLater(
          result,
          throwsA(
            isA<ApiException>().having((e) => e.code, 'code', 'STALE_SESSION'),
          ),
        );
        await entered.future;
        current = false;
        token.complete('synthetic-replacement');
        await rejected;
        expect(dispatched, 0);
      },
    );
  }
}
