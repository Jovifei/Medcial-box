import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:home_medicine_flutter/data/api_auth_repository.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';

void main() {
  test('logout clears identity data through the shared switch hook (A03)', () async {
    var cleared = false;
    final repository = ApiAuthRepository(
      api: ApiClient(
        baseUrl: 'https://medicine.example',
        tokenProvider: () async => null,
        client: MockClient((request) async => http.Response('{}', 200)),
      ),
      secretStore: MemorySecretStore(),
      localStore: MemoryInventoryLocalStore(),
      onIdentitySwitch: () async {
        cleared = true;
      },
    );
    await repository.logout();
    expect(cleared, isTrue, reason: 'logout must run the shared identity cleanup');
  });

  test('logout still clears local data when the server revoke fails (A03)', () async {
    final local = MemoryInventoryLocalStore();
    await local.saveFamily(
      FamilyRecord(id: 'family-a', name: '旧家庭', role: 'member'),
    );
    final repository = ApiAuthRepository(
      api: ApiClient(
        baseUrl: 'https://medicine.example',
        tokenProvider: () async => null,
        client: MockClient((request) async => throw http.ClientException('offline')),
      ),
      secretStore: MemorySecretStore(),
      localStore: local,
    );
    try {
      await repository.logout();
    } catch (_) {
      // 服务端撤销失败应当上抛，但本机状态必须已经清理。
    }
    expect(await local.readFamily(), isNull,
        reason: 'a failed revoke must still switch the device into the signed-out state');
  });

  test('medicine repository drops the cached inventory on session switch (A03)', () async {
    final repository = ApiMedicineRepository(
      api: ApiClient(
        baseUrl: 'https://medicine.example',
        tokenProvider: () async => null,
        client: MockClient((request) async => http.Response.bytes(
              utf8.encode(jsonEncode({
                'medicines': [
                  {'id': 'medicine-a', 'name': '上一个家庭的药', 'batches': []},
                ],
              })),
              200,
            )),
      ),
      localStore: MemoryInventoryLocalStore(),
    );
    await repository.listMedicines();
    expect(repository.medicines.length, 1);
    repository.clearSessionSnapshot();
    expect(repository.medicines, isEmpty,
        reason: 'another account must not see the previous household inventory');
    expect(repository.lastSyncedAt, isNull);
  });
}
