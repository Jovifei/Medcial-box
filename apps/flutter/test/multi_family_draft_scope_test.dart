import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/medicine_draft_queue.dart';
import 'package:home_medicine_flutter/data/api_auth_repository.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  test('switch repository clears snapshots while retaining both owned queues and uncertain payload', () async {
    final store = MemoryInventoryLocalStore();
    final a = MedicineDraftQueue(store, ownerKey: 'origin-user-family-a');
    final b = MedicineDraftQueue(store, ownerKey: 'origin-user-family-b');
    final uncertain = {
      'name': 'A pending',
      'status': 'uncertain',
      'idempotencyKey': 'original-key',
      'payload': {'name': 'Original A'},
    };
    await a.save('a', uncertain);
    await b.save('b', {'name': 'B pending', 'status': 'review'});
    final paths = <String>[];
    final api = ApiClient(
      baseUrl: 'https://medicine.example',
      tokenProvider: () async => 'synthetic-token',
      client: MockClient((request) async {
        paths.add(request.url.path);
        if (request.url.path.endsWith('/switch')) {
          return http.Response(
            '{}',
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        return http.Response(
          '{"family":{"id":"family-b","name":"B","role":"member"}}',
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );
    final repo = ApiFamilyRepository(api: api, localStore: store);
    expect((await repo.switchFamily('family-b')).id, 'family-b');
    expect(paths, [
      '/api/v1/families/family-b/switch',
      '/api/v1/families/current',
    ]);
    expect(
      (await MedicineDraftQueue(
        store,
        ownerKey: 'origin-user-family-a',
      ).list()).single,
      {...uncertain, 'id': 'a'},
    );
    expect((await b.list()).single['name'], 'B pending');
    expect(
      await MedicineDraftQueue(store, ownerKey: 'other-user-family-a').list(),
      isEmpty,
    );
  });

  test('late queued recognition cannot overwrite another family and original draft survives return', () async {
    final store = MemoryInventoryLocalStore();
    var current = true;
    final a = MedicineDraftQueue(
      store,
      ownerKey: 'a',
      scope: 'epoch-a',
      isCurrent: () => current,
    );
    await a.save('photo-a', {'photoRef': 'a-original', 'name': 'review A'});
    current = false;
    await store.clearFamilySnapshot();
    final b = MedicineDraftQueue(store, ownerKey: 'b', scope: 'epoch-b');
    await b.save('photo-b', {'photoRef': 'b-original', 'name': 'review B'});
    await a.save('photo-a', {'photoRef': 'late-a', 'name': 'late recognition'});
    expect((await b.list()).single['photoRef'], 'b-original');
    expect(
      (await MedicineDraftQueue(
        store,
        ownerKey: 'a',
      ).list()).single['photoRef'],
      'a-original',
    );
  });
}
