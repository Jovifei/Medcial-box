import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';

import 'app_stores.dart';
import 'private_atomic_state.dart';

/// Nonsecret context established only by a current validated server profile.
class VerifiedOwnerContext {
  const VerifiedOwnerContext({
    required this.origin,
    required this.generation,
    required this.userId,
    required this.familyId,
  });
  final String origin;
  final String generation;
  final String userId;
  final String? familyId;
}

class SessionPersistenceException implements Exception {
  const SessionPersistenceException();
  @override
  String toString() => '本机登录状态保存失败。当前已锁定，请重试退出或重新连接；重启后的退出状态尚未确认。';
}

class SignOutIntent {
  const SignOutIntent._(this.revision, this.generation, this.token);
  final int revision;
  final String generation;
  final String? token;
}

/// Forward-only ordinary-restart fence. Secure-store ACK alone is insufficient:
/// the secure envelope and the nonsecret acceptance must match exactly.
class SessionIdentityState {
  SessionIdentityState({
    required this.origin,
    required this.secrets,
    required this.persistence,
  }) {
    final endpoint = Uri.tryParse(origin);
    if (endpoint == null ||
        endpoint.userInfo.isNotEmpty ||
        endpoint.hasQuery ||
        endpoint.hasFragment) {
      throw ArgumentError('服务地址只能包含 API 主机和路径，不得包含账号密码、查询参数或片段。');
    }
  }
  static const accessTokenKey = 'home_medicine.auth.access_token';
  static const pendingPollTokenKey = 'home_medicine.auth.pending_poll_token';
  final String origin;
  final SecretStore secrets;
  final PrivateAtomicState persistence;
  final _random = Random.secure();
  Future<void>? _initialization;
  bool _ready = false;
  void Function()? onBlocked;
  Future<void> _tail = Future.value();
  int _revision = 0;
  String? _generation;
  String? _token;
  String? _link;
  bool _accepted = false;
  VerifiedOwnerContext? _owner;
  bool needsPersistenceRetry = false;
  final ValueNotifier<String?> warningSignal = ValueNotifier(null);
  String? get warning => warningSignal.value;
  set warning(String? value) => warningSignal.value = value;
  void retainSignOutWarning(SignOutIntent intent, String? value) {
    if (isSignOutCurrent(intent)) warning = value;
  }

  bool _quarantinePending = false;
  bool _blockLegacyRestore = false;
  final Set<String> _blockedLegacyScopes = {};
  static String scopeForOwner(VerifiedOwnerContext owner) => base64Url.encode(
    utf8.encode(jsonEncode([owner.origin, owner.userId, owner.familyId])),
  );
  bool canRestoreLegacyScope(String scope) =>
      !_blockLegacyRestore && !_blockedLegacyScopes.contains(scope);
  void _blockCurrentLegacyScope() {
    final context = _owner;
    if (context == null || context.familyId == null) return;
    final scope = scopeForOwner(context);
    if (scope.length > 2048 || _blockedLegacyScopes.length >= 16) {
      _blockLegacyRestore = true;
      _blockedLegacyScopes.clear();
    } else {
      _blockedLegacyScopes.add(scope);
    }
  }

  bool get requiresLegacyQuarantine => _quarantinePending;
  void finishLegacyQuarantine() => _quarantinePending = false;

  bool get accepted => _accepted;
  String? get generation => _accepted ? _generation : null;
  VerifiedOwnerContext? get owner => _accepted ? _owner : null;
  String _nonce() => List.generate(
    24,
    (_) => _random.nextInt(256),
  ).map((v) => v.toRadixString(16).padLeft(2, '0')).join();
  static bool _id(Object? value) =>
      value is String &&
      value.isNotEmpty &&
      value.length <= 256 &&
      value.trim() == value;
  static bool _nonceValid(Object? value) =>
      value is String && RegExp(r'^[a-f0-9]{48}$').hasMatch(value);
  Future<T> _serial<T>(Future<T> Function() action) {
    final next = _tail.then((_) => action());
    _tail = next.then<void>((_) {}, onError: (Object _) {});
    return next;
  }

  Map<String, Object?> _record(
    String generation,
    bool accepted, [
    VerifiedOwnerContext? owner,
  ]) => {
    'schema': 1,
    'origin': origin,
    'generation': generation,
    'state': accepted ? 'accepted' : 'signedOut',
    'quarantinePending': _quarantinePending,
    'blockLegacyRestore': _blockLegacyRestore,
    'blockedLegacyScopes': _blockedLegacyScopes.toList(),
    if (owner != null)
      'owner': {'userId': owner.userId, 'familyId': owner.familyId},
  };
  void _failed() {
    _accepted = false;
    _token = null;
    _owner = null;
    needsPersistenceRetry = true;
    warning = const SessionPersistenceException().toString();
    onBlocked?.call();
  }

  Future<void> initialize() => _initialization ??= _serial(() async {
    final revision = _revision;
    try {
      final raw = await persistence.read();
      if (revision != _revision) return;
      // Legacy credentials have neither a provable API origin nor a historical
      // logout fence. Require reconnection; never infer authority from the token.
      if (raw == null) {
        _quarantinePending = true;
        final legacy = await secrets.read(accessTokenKey);
        if (revision != _revision) return;
        // Only a genuine pre-envelope credential identifies a one-time legacy
        // upgrade. Missing/corrupt modern fencing cannot create new migration
        // eligibility or erase an unknowable prior explicit invalidation.
        final legacyRawCredential =
            legacy != null && RegExp(r'^[a-f0-9]{64}$').hasMatch(legacy);
        _blockLegacyRestore = !legacyRawCredential;
        if (legacy != null) {
          warning = '旧版登录没有可验证的服务地址记录，请重新连接。原草稿将保留隔离，验证所属账号和家庭后才可恢复；未记录归属的旧药品草稿不会自动显示。';
        }
        _generation = _nonce();
        await persistence.write(jsonEncode(_record(_generation!, false)));
        return;
      }
      final record = jsonDecode(raw);
      if (record is! Map ||
          record['schema'] != 1 ||
          !_nonceValid(record['generation']) ||
          !const ['accepted', 'signedOut'].contains(record['state'])) {
        throw const FormatException('Invalid identity fence');
      }
      if (record['quarantinePending'] != null &&
          record['quarantinePending'] is! bool) {
        throw const FormatException('Invalid migration fence');
      }
      final blocked = record['blockedLegacyScopes'];
      if ((record['blockLegacyRestore'] != null &&
              record['blockLegacyRestore'] is! bool) ||
          (blocked != null &&
              (blocked is! List ||
                  blocked.length > 16 ||
                  !blocked.every(
                    (v) =>
                        v is String &&
                        v.length <= 2048 &&
                        RegExp(r'^[A-Za-z0-9_=\-]+$').hasMatch(v),
                  )))) {
        throw const FormatException('Invalid legacy invalidation fence');
      }
      _blockLegacyRestore = record['blockLegacyRestore'] == true;
      if (blocked is List) _blockedLegacyScopes.addAll(blocked.cast<String>());
      if (record['origin'] != origin) {
        throw const FormatException('Different API base');
      }
      _quarantinePending = record['quarantinePending'] == true;
      if (_quarantinePending) {
        warning = '原本机资料已保留隔离。请重新连接，验证所属账号和家庭后恢复可确认归属的计划草稿。';
      }
      _generation = record['generation'] as String;
      if (record['state'] == 'signedOut') return;
      final tokenRaw = await secrets.read(accessTokenKey);
      if (revision != _revision) return;
      final envelope = tokenRaw == null ? null : jsonDecode(tokenRaw);
      if (!_matches(envelope, _generation!)) {
        throw const FormatException('Unmatched secure session envelope');
      }
      final ownerJson = record['owner'];
      VerifiedOwnerContext? context;
      if (ownerJson != null) {
        if (ownerJson is! Map ||
            !_id(ownerJson['userId']) ||
            !ownerJson.containsKey('familyId') ||
            (ownerJson['familyId'] != null && !_id(ownerJson['familyId']))) {
          throw const FormatException('Invalid owner context');
        }
        context = VerifiedOwnerContext(
          origin: origin,
          generation: _generation!,
          userId: ownerJson['userId'] as String,
          familyId: ownerJson['familyId'] as String?,
        );
      }
      if (revision != _revision) return;
      _owner = context;
      _token = envelope['token'] as String;
      _accepted = true;
      needsPersistenceRetry = false;
      warning = null;
    } catch (_) {
      if (revision == _revision) {
        _quarantinePending = true;
        _blockLegacyRestore = true;
        _failed();
      }
    } finally {
      _ready = true;
    }
  });
  bool _matches(dynamic envelope, String generation) =>
      envelope is Map &&
      envelope['schema'] == 1 &&
      envelope['origin'] == origin &&
      envelope['generation'] == generation &&
      envelope['token'] is String &&
      (envelope['token'] as String).isNotEmpty &&
      (envelope['token'] as String).length <= 16384;
  Future<String?> readAccessToken() async {
    if (!_ready) await initialize();
    final revision = _revision;
    final generation = _generation;
    if (!_accepted || generation == null) return null;
    try {
      final raw = await secrets.read(accessTokenKey);
      if (revision != _revision || !_accepted) return null;
      final value = raw == null ? null : jsonDecode(raw);
      if (!_matches(value, generation)) {
        _failed();
        return null;
      }
      _token = value['token'] as String;
      return _token;
    } catch (_) {
      if (revision == _revision) _failed();
      return null;
    }
  }

  /// Close synchronously, before any transition queue, persistence or network.
  SignOutIntent beginSignOut() {
    final oldToken = _token;
    _blockCurrentLegacyScope();
    if (_quarantinePending || _owner == null) _blockLegacyRestore = true;
    _quarantinePending = false;
    _revision++;
    _accepted = false;
    _owner = null;
    _token = null;
    _link = null;
    _generation = _nonce();
    return SignOutIntent._(_revision, _generation!, oldToken);
  }

  bool isSignOutCurrent(SignOutIntent intent) => intent.revision == _revision;
  Future<void> persistSignOut(SignOutIntent intent) => _serial(() async {
    if (!isSignOutCurrent(intent)) return;
    try {
      await persistence.write(jsonEncode(_record(intent.generation, false)));
      if (isSignOutCurrent(intent)) {
        needsPersistenceRetry = false;
        warning = null;
      }
    } catch (_) {
      if (isSignOutCurrent(intent)) _failed();
      throw const SessionPersistenceException();
    }
  });
  Future<void> deleteSignedOutSecrets(SignOutIntent intent) =>
      _serial(() async {
        if (!isSignOutCurrent(intent)) return;
        Object? failure;
        for (final key in [accessTokenKey, pendingPollTokenKey]) {
          if (!isSignOutCurrent(intent)) break;
          try {
            await secrets.delete(key);
          } catch (error) {
            failure = error;
          }
        }
        if (failure != null) throw failure;
      });
  String beginLink() {
    _link = _nonce();
    return _link!;
  }

  String? get pendingLink => _link;
  bool isLinkCurrent(String link) => _link == link;
  Future<void> storePendingLink(String link, String pollToken) =>
      _serial(() async {
        if (!isLinkCurrent(link)) return;
        await secrets.write(
          pendingPollTokenKey,
          jsonEncode({
            'schema': 1,
            'origin': origin,
            'link': link,
            'pollToken': pollToken,
          }),
        );
      });
  Future<String?> readPendingLink(String link) async {
    final raw = await secrets.read(pendingPollTokenKey);
    if (!isLinkCurrent(link) || raw == null) return null;
    final value = jsonDecode(raw);
    if (value is! Map ||
        value['schema'] != 1 ||
        value['origin'] != origin ||
        value['link'] != link ||
        value['pollToken'] is! String) {
      return null;
    }
    return value['pollToken'] as String;
  }

  Future<void> expireLink(String link) => _serial(() async {
    if (!isLinkCurrent(link)) return;
    _link = null;
    await secrets.delete(pendingPollTokenKey);
  });
  Future<void> acceptToken(String link, String token) => _serial(() async {
    if (!isLinkCurrent(link)) {
      throw StateError('连接已变更，请重新连接。');
    }
    final revision = ++_revision;
    final generation = _nonce();
    _accepted = false;
    _owner = null;
    _token = null;
    _generation = generation;
    try {
      // Fence the previous session before any secure replacement ACK.
      await persistence.write(jsonEncode(_record(generation, false)));
      if (revision != _revision || !isLinkCurrent(link)) return;
      await secrets.write(
        accessTokenKey,
        jsonEncode({
          'schema': 1,
          'origin': origin,
          'generation': generation,
          'token': token,
        }),
      );
      if (revision != _revision || !isLinkCurrent(link)) return;
      await persistence.write(jsonEncode(_record(generation, true)));
      if (revision != _revision || !isLinkCurrent(link)) return;
      _token = token;
      _accepted = true;
      needsPersistenceRetry = false;
      warning = null;
      _link = null;
      try {
        await secrets.delete(pendingPollTokenKey);
      } catch (_) {}
    } catch (_) {
      await _sealFailedCommit(revision);
      throw const SessionPersistenceException();
    }
  });
  Future<void> _sealFailedCommit(int revision) async {
    if (revision != _revision) return;
    _failed();
    final generation = _generation ?? _nonce();
    try {
      await persistence.write(jsonEncode(_record(generation, false)));
    } catch (_) {
      // No storage API can promise restart safety if every write fails.
    }
  }

  Future<void> recordOwner({
    required String expectedGeneration,
    required String userId,
    required String? familyId,
    required bool Function() isCurrent,
  }) => _serial(() async {
    if (!_accepted || _generation != expectedGeneration || !isCurrent()) return;
    if (!_id(userId) || (familyId != null && !_id(familyId))) {
      throw const FormatException('Invalid verified owner');
    }
    final revision = _revision;
    final context = VerifiedOwnerContext(
      origin: origin,
      generation: expectedGeneration,
      userId: userId,
      familyId: familyId,
    );
    try {
      await persistence.write(
        jsonEncode(_record(expectedGeneration, true, context)),
      );
      if (revision == _revision &&
          _accepted &&
          _generation == expectedGeneration &&
          isCurrent()) {
        _owner = context;
      }
    } catch (_) {
      await _sealFailedCommit(revision);
      throw const SessionPersistenceException();
    }
  });
  Future<void> clearFamily() {
    if (!_accepted) return Future.value();
    if (_owner == null) _blockLegacyRestore = true;
    _blockCurrentLegacyScope();
    final revision = ++_revision;
    final generation = _generation;
    final userId = _owner?.userId;
    _owner = userId == null || generation == null
        ? null
        : VerifiedOwnerContext(
            origin: origin,
            generation: generation,
            userId: userId,
            familyId: null,
          );
    final context = _owner;
    return _serial(() async {
      if (revision != _revision || !_accepted || generation == null) return;
      try {
        await persistence.write(jsonEncode(_record(generation, true, context)));
      } catch (_) {
        await _sealFailedCommit(revision);
        throw const SessionPersistenceException();
      }
    });
  }
}
