import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:home_medicine_flutter/data/api_auth_repository.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';

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

  test('in-flight listMedicines from a previous session does not backfill after switch (R10)', () async {
    final gate = Completer<void>();
    final local = MemoryInventoryLocalStore();
    final repository = ApiMedicineRepository(
      api: ApiClient(
        baseUrl: 'https://medicine.example',
        tokenProvider: () async => null,
        client: MockClient((request) async {
          await gate.future;
          return http.Response.bytes(
            utf8.encode(jsonEncode({
              'medicines': [
                {'id': 'stale', 'name': '旧会话的药', 'batches': []},
              ],
            })),
            200,
          );
        }),
      ),
      localStore: local,
    );
    final pending = repository.listMedicines();
    // 请求仍在途时发生会话切换（退出 / 换账号 / 换家庭）。
    repository.clearSessionSnapshot();
    gate.complete();
    final result = await pending;
    expect(result, isEmpty, reason: '旧会话的晚到响应不得作为结果回填');
    expect(repository.medicines, isEmpty, reason: '内存快照不得被旧会话响应污染');
    expect((await local.readInventory())?.isEmpty ?? true, isTrue,
        reason: '本机缓存不得写入旧会话库存');
  });

  test('logout reports a server revoke failure separately while still clearing the device (R10)', () async {
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
    final revokeNote = await repository.logout();
    expect(revokeNote, isNotNull, reason: '服务端撤销失败要单独告知，而不是被吞掉');
    expect(await local.readFamily(), isNull,
        reason: '服务端撤销失败仍必须把本机切到未登录态');
  });
}
