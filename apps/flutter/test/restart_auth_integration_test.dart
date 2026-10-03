// These tests intentionally use only APIs present in the qualified e053162
// baseline, so the same production-service regressions can be run red there.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_auth_repository.dart';
import 'package:home_medicine_flutter/data/app_services.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
// ignore: depend_on_referenced_packages
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _RestartPaths extends PathProviderPlatform {
  _RestartPaths(this.root);
  final Directory root;
  @override
  Future<String?> getTemporaryPath() async => root.path;
  @override
  Future<String?> getApplicationSupportPath() async => root.path;
}

class _RetainedSecrets extends MemorySecretStore {
  bool failDelete = false;
  int acceptedWrites = 0;
  @override
  Future<void> write(String key, String value) async {
    if (key == ApiAuthRepository.accessTokenKey) acceptedWrites++;
    await super.write(key, value);
  }

  @override
  Future<void> delete(String key) async {
    if (failDelete) throw StateError('Synthetic secure deletion failure');
    await super.delete(key);
  }
}

http.Response _json(Object value, [int status = 200]) => http.Response(
  jsonEncode(value),
  status,
  headers: {'content-type': 'application/json'},
);
http.Response _link() => _json({
  'code': '654321',
  'pollToken': 'synthetic-poll',
  'expiresAt': '2099-01-01T00:00:00Z',
});
http.Response _approved() =>
    _json({'state': 'approved', 'token': 'synthetic-credential-a'});
Future<AppServices> _services(
  _RetainedSecrets secrets,
  Future<http.Response> Function(http.Request) handler,
) => http.runWithClient(
  () => AppServices.create(
    apiBaseUrl: 'https://medicine.example',
    secretStore: secrets,
    localStore: MemoryInventoryLocalStore(),
  ),
  () => MockClient(handler),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  AndroidFlutterLocalNotificationsPlugin.registerWith();
  const channel = MethodChannel('dexterous.com/flutter/local_notifications');
  late Directory root;
  late PathProviderPlatform oldPaths;
  setUp(() async {
    root = await Directory.systemTemp.createTemp('medicine-auth-restart-test-');
    oldPaths = PathProviderPlatform.instance;
    PathProviderPlatform.instance = _RestartPaths(root);
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    SharedPreferences.setMockInitialValues({});
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          channel,
          (call) async => call.method == 'initialize' ? true : null,
        );
  });
  tearDown(() async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
    debugDefaultTargetPlatformOverride = null;
    PathProviderPlatform.instance = oldPaths;
    await root.delete(recursive: true);
  });

  test('offline logout plus failed secure delete cannot restore protected API access', () async {
    final secrets = _RetainedSecrets();
    final first = await _services(secrets, (request) async {
      if (request.url.path.endsWith('/auth/device-links')) return _link();
      if (request.url.path.endsWith('/exchange')) return _approved();
      throw http.ClientException('Synthetic offline revoke');
    });
    await first.auth!.startDeviceLink();
    await first.auth!.exchangePendingLink();
    expect(await first.auth!.readAccessToken(), 'synthetic-credential-a');
    secrets.failDelete = true;
    expect(await first.auth!.logout(), isNotNull);
    expect(
      secrets.values[ApiAuthRepository.accessTokenKey],
      isNotNull,
      reason: 'The adversarial storage must really retain the old credential',
    );
    first.api!.close();

    var protectedCalls = 0;
    final fresh = await _services(secrets, (request) async {
      protectedCalls++;
      return _json({'ok': true});
    });
    Object? blocked;
    try {
      await fresh.api!.get('/api/v1/protected-restart-probe');
    } catch (error) {
      blocked = error;
    }
    expect(
      protectedCalls,
      0,
      reason: 'A retained credential must never reach any protected endpoint after restart',
    );
    expect(blocked, isNotNull);
    expect(await fresh.auth!.readAccessToken(), isNull);
    fresh.api!.close();
  });

  test(
    'start-link response arriving after logout cannot recreate a pending login',
    () async {
      final secrets = _RetainedSecrets();
      final entered = Completer<void>();
      final response = Completer<http.Response>();
      final services = await _services(secrets, (request) async {
        if (request.url.path.endsWith('/auth/device-links')) {
          entered.complete();
          return response.future;
        }
        return _json({});
      });
      final pending = services.auth!.startDeviceLink();
      final outcome = pending.then<Object?>(
        (value) => value,
        onError: (Object error) => error,
      );
      await entered.future;
      await services.auth!.logout();
      response.complete(_link());
      expect(
        await outcome,
        isNot(isA<DeviceLink>()),
        reason: 'Logout invalidates already-started link creation',
      );
      expect(secrets.values[ApiAuthRepository.pendingPollTokenKey], isNull);
      expect(secrets.acceptedWrites, 0);
      services.api!.close();
    },
  );

  test(
    'approved poll arriving after logout intent cannot accept a session',
    () async {
      final secrets = _RetainedSecrets();
      final entered = Completer<void>();
      final response = Completer<http.Response>();
      final services = await _services(secrets, (request) async {
        if (request.url.path.endsWith('/auth/device-links')) return _link();
        if (request.url.path.endsWith('/exchange')) {
          entered.complete();
          return response.future;
        }
        return _json({});
      });
      await services.auth!.startDeviceLink();
      final poll = services.auth!.exchangePendingLink();
      final outcome = poll.then<Object?>(
        (value) => value,
        onError: (Object error) => error,
      );
      await entered.future;
      final logout = services.auth!.logout();
      response.complete(_approved());
      final result = await outcome;
      await logout;
      expect(
        secrets.acceptedWrites,
        0,
        reason: 'A stale approved response must never transiently write an accepted credential',
      );
      expect(result, isNot(isA<DeviceLinkExchange>()));
      expect(await services.auth!.readAccessToken(), isNull);
      services.api!.close();
    },
  );
}
