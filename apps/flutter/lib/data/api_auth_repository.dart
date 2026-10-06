import 'dart:convert';

import '../models/medicine_models.dart';
import 'api_client.dart';
import 'app_stores.dart';
import 'session_identity_state.dart';

const apiBaseUrlFromBuild = String.fromEnvironment('API_BASE_URL');
const localAppTrialFromBuild = bool.fromEnvironment('LOCAL_APP_TRIAL');
const missingApiConfigurationMessage =
    '尚未配置服务地址。请在运行或构建时添加 --dart-define=API_BASE_URL=https://你的药箱域名';

class DeviceLink {
  const DeviceLink({
    required this.code,
    required this.pollToken,
    required this.expiresAt,
  });
  final String code;
  final String pollToken;
  final DateTime expiresAt;
}

class DeviceLinkExchange {
  const DeviceLinkExchange({required this.state, this.expiresAt});
  final String state;
  final DateTime? expiresAt;
}

class AuthProfile {
  const AuthProfile({
    required this.userId,
    required this.nickname,
    required this.hasFamily,
    this.family,
  });
  final String userId;
  final String? nickname;
  final bool hasFamily;
  final FamilyRecord? family;
}

class ApiAuthRepository {
  Future<List<Map<String, dynamic>>> listDevices() async {
    final epoch = api.identityEpoch;
    final result =
        await api.get('/api/v1/auth/devices') as Map<String, dynamic>;
    _requireCurrentIdentity(epoch);
    return (result['devices'] as List<dynamic>).cast<Map<String, dynamic>>();
  }

  Future<void> revokeDevice(String id) async {
    final epoch = api.identityEpoch;
    await api.post(
      '/api/v1/auth/devices/${Uri.encodeComponent(id)}/revoke',
      body: {},
    );
    _requireCurrentIdentity(epoch);
  }

  ApiAuthRepository({
    required this.api,
    required this.secretStore,
    this.localStore,
    this.onIdentitySwitch,
    this.onLoggedOut,
    this.onOwnerValidated,
  }) {
    if (api.identityState == null) {
      throw ArgumentError(
        'ApiAuthRepository requires a fenced identity state.',
      );
    }
  }

  /// 身份切换（换账号/换家庭）前统一清理内存与本机数据；为空时退回仅清理本机存储。
  final Future<void> Function()? onIdentitySwitch;
  final void Function()? onLoggedOut;
  final Future<void> Function(VerifiedOwnerContext owner)? onOwnerValidated;

  static const accessTokenKey = 'home_medicine.auth.access_token';
  static const pendingPollTokenKey = 'home_medicine.auth.pending_poll_token';

  final ApiClient api;
  final SecretStore secretStore;
  final LocalAppStore? localStore;

  SessionIdentityState get identityState => api.identityState!;
  Future<String?> readAccessToken() => identityState.readAccessToken();

  void _requireLink(String? link, int epoch) {
    if (link == null ||
        !identityState.isLinkCurrent(link) ||
        epoch != api.identityEpoch) {
      throw const ApiException(
        statusCode: 401,
        code: 'STALE_SESSION',
        message: '连接已变更，请重新获取连接码。',
      );
    }
  }

  Future<DeviceLink> startDeviceLink() async {
    final link = identityState.beginLink();
    final epoch = api.identityEpoch;
    final json = await api.post(
      '/api/v1/auth/device-links',
      authenticated: false,
    ) as Map<String, dynamic>;
    final pollToken = json['pollToken'] as String;
    _requireLink(link, epoch);
    await _transition(() async {
      _requireLink(link, epoch);
      await identityState.storePendingLink(link, pollToken);
    });
    _requireLink(link, epoch);
    return DeviceLink(
      code: json['code'] as String,
      pollToken: pollToken,
      expiresAt: DateTime.parse(json['expiresAt'] as String),
    );
  }

  Future<T> _transition<T>(Future<T> Function() action) =>
      api.transitionIdentity(action);

  Future<DeviceLinkExchange> exchangePendingLink() {
    final link = identityState.pendingLink;
    final epoch = api.identityEpoch;
    return _transition(() => _exchangePendingLink(link, epoch));
  }

  Future<DeviceLinkExchange> _exchangePendingLink(
    String? link,
    int epoch,
  ) async {
    _requireLink(link, epoch);
    final pollToken = await identityState.readPendingLink(link!);
    _requireLink(link, epoch);
    if (pollToken == null || pollToken.isEmpty) {
      throw const ApiException(
        statusCode: 401,
        code: 'NO_PENDING_DEVICE_LINK',
        message: '连接已失效，请重新获取连接码。',
      );
    }
    final json = await api.post(
      '/api/v1/auth/device-links/exchange',
      body: {'pollToken': pollToken},
      authenticated: false,
    ) as Map<String, dynamic>;
    _requireLink(link, epoch);
    final state = json['state'] as String;
    if (state == 'approved' && json['token'] is String) {
      await _acceptLinkedToken(link, json['token']! as String);
    } else if (state == 'expired') {
      await identityState.expireLink(link);
    }
    return DeviceLinkExchange(
      state: state,
      expiresAt: json['expiresAt'] is String
          ? DateTime.tryParse(json['expiresAt']! as String)
          : null,
    );
  }

  Future<void> _acceptLinkedToken(String link, String token) async {
    await _clearIdentityData();
    if (!identityState.isLinkCurrent(link)) {
      throw const ApiException(
        statusCode: 401,
        code: 'STALE_SESSION',
        message: '连接已变更，请重新连接。',
      );
    }
    await identityState.acceptToken(link, token);
    if (!identityState.accepted) {
      throw const ApiException(
        statusCode: 401,
        code: 'STALE_SESSION',
        message: '连接已变更，请重新连接。',
      );
    }
  }

  Future<void> startLocalTrial({bool enabled = localAppTrialFromBuild}) async {
    final origin = Uri.parse(api.baseUrl);
    if (!enabled ||
        origin.scheme != 'http' ||
        !{'127.0.0.1', 'localhost'}.contains(origin.host)) {
      throw StateError('本机试用只允许显式启用的本地测试构建。');
    }
    final link = identityState.beginLink();
    final epoch = api.identityEpoch;
    final marker = await api.get(
      '/api/v1/health/local-app-trial',
      authenticated: false,
    );
    _requireLink(link, epoch);
    if (marker is! Map || marker['mode'] != 'local-app-trial') {
      throw StateError('当前服务不是本机试用服务。');
    }
    final result = await api.post(
      '/api/v1/auth/wechat',
      authenticated: false,
      body: {'code': 'local-app-trial'},
      isCurrent: () => identityState.isLinkCurrent(link),
    );
    _requireLink(link, epoch);
    if (result is! Map || result['token'] is! String) {
      throw const FormatException('本机试用会话无效。');
    }
    await _transition(() async {
      _requireLink(link, epoch);
      await _acceptLinkedToken(link, result['token'] as String);
    });
  }

  void _requireCurrentIdentity(int epoch) {
    if (epoch != api.identityEpoch) {
      throw const ApiException(
        statusCode: 401,
        code: 'STALE_SESSION',
        message: '会话已变更，请重新加载。',
      );
    }
  }

  Future<AuthProfile> getCurrentUser() async {
    var epoch = api.identityEpoch;
    final generation = identityState.generation;
    final json = await api.get('/api/v1/auth/me') as Map<String, dynamic>;
    _requireCurrentIdentity(epoch);
    final user = json['user'];
    final familyJson = json['family'];
    // Missing/defaulted/inconsistent fields are not proof of membership loss.
    if (user is! Map<String, dynamic> ||
        user['id'] is! String ||
        (user['id'] as String).trim().isEmpty ||
        (user['nickname'] != null && user['nickname'] is! String) ||
        user['hasFamily'] is! bool ||
        !json.containsKey('family') ||
        (user['hasFamily'] == true && familyJson is! Map<String, dynamic>) ||
        (user['hasFamily'] == false && familyJson != null)) {
      throw const ApiException(
        statusCode: 502,
        code: 'INVALID_RESPONSE',
        message: '家庭身份返回结果无法识别，请重试。',
      );
    }
    if (familyJson is Map<String, dynamic> &&
        (familyJson['id'] is! String ||
            (familyJson['id'] as String).trim().isEmpty ||
            familyJson['name'] is! String ||
            (familyJson['name'] as String).trim().isEmpty ||
            !const ['owner', 'member'].contains(familyJson['role']))) {
      throw const ApiException(
        statusCode: 502,
        code: 'INVALID_RESPONSE',
        message: '家庭身份返回结果无法识别，请重试。',
      );
    }
    final family = familyJson is Map<String, dynamic>
        ? FamilyRecord.fromJson(familyJson)
        : null;
    final previousOwner = identityState.owner;
    if (family != null &&
        previousOwner != null &&
        (previousOwner.userId != user['id'] ||
            (previousOwner.familyId != null &&
                previousOwner.familyId != family.id))) {
      final cleanupEpoch = await api.reportNoCurrentFamily(epoch);
      _requireCurrentIdentity(cleanupEpoch);
      epoch = cleanupEpoch;
    }
    if (family != null) {
      await localStore?.saveFamily(family);
      _requireCurrentIdentity(epoch);
    } else {
      final cleanupEpoch = await api.reportNoCurrentFamily(epoch);
      _requireCurrentIdentity(cleanupEpoch);
      epoch = cleanupEpoch;
    }
    if (generation != null) {
      await identityState.recordOwner(
        expectedGeneration: generation,
        userId: user['id'] as String,
        familyId: family?.id,
        isCurrent: () => epoch == api.identityEpoch,
      );
      _requireCurrentIdentity(epoch);
      final owner = identityState.owner;
      if (owner != null) await onOwnerValidated?.call(owner);
      _requireCurrentIdentity(epoch);
    }
    return AuthProfile(
      userId: user['id'] as String,
      nickname: user['nickname'] as String?,
      hasFamily: user['hasFamily'] as bool,
      family: family,
    );
  }

  Future<void> _clearIdentityData({bool explicitLogoutRetry = false}) async {
    if (!explicitLogoutRetry) await api.waitForIdentityCleanup();
    // Logout is also the explicit recovery action. A failed fence may have
    // closed/incremented the API epoch, making the old cleanup retry stale.
    // Start a fresh full cleanup; cleanupForIdentityTransition still drains
    // all earlier work before any later session can be accepted.
    if (onIdentitySwitch != null) {
      await api.cleanupForIdentityTransition(onIdentitySwitch!);
      return;
    }
    api.invalidateIdentity();
    await identityState.clearFamily();
    await localStore?.clearFamilyData();
  }

  /// 退出登录（R10）：本机一定切到未登录态，服务端撤销失败单独返回、不阻断本地清理。
  ///
  /// - 服务端撤销失败（含断网）不再上抛中断流程，而是把友好文案作为返回值交给界面单独告知；
  /// - 每个清理步骤各自 try/catch：清理钩子抛错也保证后续令牌删除照常执行，
  ///   不会停留在"无令牌却仍是已登录界面"的状态。
  /// 返回服务端撤销的错误信息；本机清理成功且服务端也撤销成功时返回 null。
  Future<String?> logout() {
    final state = identityState;
    final intent = state.beginSignOut();
    api.invalidateIdentity();
    onLoggedOut?.call();
    // Start persistence immediately, not behind a slow link/poll/network queue.
    final persistence = state
        .persistSignOut(intent)
        .then<String?>(
          (_) => null,
          onError: (Object error) => error.toString(),
        );
    return api.transitionIdentity(() async {
      final warnings = <String>[];
      final persistenceWarning = await persistence;
      if (persistenceWarning != null) warnings.add(persistenceWarning);
      if (intent.token != null) {
        try {
          await api.revokeSession(intent.token!);
        } catch (error) {
          warnings.add(friendlyApiError(error));
        }
      }
      if (state.isSignOutCurrent(intent)) {
        try {
          await _clearIdentityData(explicitLogoutRetry: true);
        } catch (_) {}
        try {
          await state.deleteSignedOutSecrets(intent);
        } catch (_) {}
      }
      final warning = warnings.isEmpty ? null : warnings.join('\n');
      state.retainSignOutWarning(intent, warning);
      return warning;
    }, allowFailedCleanup: true);
  }
}

class InvitationPreview {
  const InvitationPreview({required this.familyName, required this.expiresAt});
  final String familyName;
  final DateTime expiresAt;
}

class ApiFamilyRepository {
  ApiFamilyRepository({
    required this.api,
    required this.localStore,
    this.onFamilyChanged,
    this.onFamilyValidated,
  });
  final ApiClient api;
  final LocalAppStore localStore;

  /// 加入或创建另一个家庭前清理上一个家庭的库存快照（含内存）。
  final Future<void> Function()? onFamilyChanged;
  final Future<void> Function()? onFamilyValidated;

  Future<FamilyRecord> getCurrentFamily() async {
    var epoch = api.identityEpoch;
    final generation = api.identityState?.generation;
    final userId = api.identityState?.owner?.userId;
    final json =
        await api.get('/api/v1/families/current') as Map<String, dynamic>;
    if (epoch != api.identityEpoch) {
      throw const ApiException(
        statusCode: 401,
        code: 'STALE_SESSION',
        message: '家庭身份已变更。',
      );
    }
    final value = json['family'];
    if (value is! Map<String, dynamic> ||
        value['id'] is! String ||
        (value['id'] as String).trim().isEmpty ||
        value['name'] is! String ||
        (value['name'] as String).trim().isEmpty ||
        !const ['owner', 'member'].contains(value['role'])) {
      throw const ApiException(
        statusCode: 502,
        code: 'INVALID_RESPONSE',
        message: '家庭身份返回结果无法识别，请重试。',
      );
    }
    final family = FamilyRecord.fromJson(value);
    final oldFamilyId = api.identityState?.owner?.familyId;
    if (oldFamilyId != null && oldFamilyId != family.id) {
      epoch = await api.reportNoCurrentFamily(epoch);
      if (epoch != api.identityEpoch) {
        throw const ApiException(
          statusCode: 401,
          code: 'STALE_SESSION',
          message: '家庭身份已变更。',
        );
      }
    }
    await localStore.saveFamily(family);
    if (generation != null && userId != null) {
      await api.identityState!.recordOwner(
        expectedGeneration: generation,
        userId: userId,
        familyId: family.id,
        isCurrent: () => epoch == api.identityEpoch,
      );
    }
    if (epoch != api.identityEpoch) {
      throw const ApiException(
        statusCode: 401,
        code: 'STALE_SESSION',
        message: '家庭身份已变更。',
      );
    }
    await onFamilyValidated?.call();
    if (epoch != api.identityEpoch) {
      throw const ApiException(
        statusCode: 401,
        code: 'STALE_SESSION',
        message: '家庭身份已变更。',
      );
    }
    return family;
  }

  Future<FamilyRecord> createFamily(String name) =>
      api.transitionIdentity(() => _createFamily(name));

  Future<FamilyRecord> _createFamily(String name) async {
    await api.post('/api/v1/families', body: {'name': name});
    await _clearPreviousFamilySnapshot();
    return getCurrentFamily();
  }

  Future<InvitationPreview> previewInvitation(String code) async {
    final json = await api.post(
      '/api/v1/families/invitations/preview',
      body: {'invitationCode': code.trim()},
    ) as Map<String, dynamic>;
    final family = json['family'] as Map<String, dynamic>;
    return InvitationPreview(
      familyName: family['name'] as String,
      expiresAt: DateTime.parse(json['expiresAt'] as String),
    );
  }

  Future<FamilyRecord> acceptInvitation(String code) =>
      api.transitionIdentity(() => _acceptInvitation(code));

  Future<FamilyRecord> _acceptInvitation(String code) async {
    await api.post(
      '/api/v1/families/invitations/accept',
      body: {'code': code.trim()},
    );
    // 加入新家庭：丢弃上一个家庭的库存快照，稍后重新同步（A03）。
    await _clearPreviousFamilySnapshot();
    return getCurrentFamily();
  }

  Future<void> _clearPreviousFamilySnapshot() async {
    await api.waitForIdentityCleanup();
    if (onFamilyChanged != null) {
      await api.cleanupForIdentityTransition(onFamilyChanged!);
      return;
    }
    await localStore.clearFamilyData();
  }

  Future<String> createInvitation() async {
    final json =
        await api.post('/api/v1/families/invitations') as Map<String, dynamic>;
    return json['invitationCode'] as String;
  }

  Future<void> updateNickname(String? nickname) async {
    await api.post(
      '/api/v1/users/me/nickname',
      body: {
        'nickname': nickname?.trim().isEmpty == true ? null : nickname?.trim(),
      },
    );
  }
}

Map<String, Object?> jsonObject(String source) =>
    jsonDecode(source) as Map<String, Object?>;
