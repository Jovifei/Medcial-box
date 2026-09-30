import 'dart:convert';

import '../models/medicine_models.dart';
import 'api_client.dart';
import 'app_stores.dart';

const apiBaseUrlFromBuild = String.fromEnvironment('API_BASE_URL');
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
  ApiAuthRepository({
    required this.api,
    required this.secretStore,
    this.localStore,
    this.onIdentitySwitch,
  });

  /// 身份切换（换账号/换家庭）前统一清理内存与本机数据；为空时退回仅清理本机存储。
  final Future<void> Function()? onIdentitySwitch;

  static const accessTokenKey = 'home_medicine.auth.access_token';
  static const pendingPollTokenKey = 'home_medicine.auth.pending_poll_token';

  final ApiClient api;
  final SecretStore secretStore;
  final LocalAppStore? localStore;

  Future<String?> readAccessToken() => secretStore.read(accessTokenKey);

  Future<DeviceLink> startDeviceLink() async {
    final json = await api.post(
      '/api/v1/auth/device-links',
      authenticated: false,
    ) as Map<String, dynamic>;
    final pollToken = json['pollToken'] as String;
    await secretStore.write(pendingPollTokenKey, pollToken);
    return DeviceLink(
      code: json['code'] as String,
      pollToken: pollToken,
      expiresAt: DateTime.parse(json['expiresAt'] as String),
    );
  }

  Future<DeviceLinkExchange> exchangePendingLink() async {
    final pollToken = await secretStore.read(pendingPollTokenKey);
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
    final state = json['state'] as String;
    if (state == 'approved' && json['token'] is String) {
      // The approval flow can connect a different account on a device that
      // previously held another household's offline snapshot. Drop that data
      // (memory included) before accepting the new credential.
      await _clearIdentityData();
      await secretStore.write(accessTokenKey, json['token']! as String);
      await secretStore.delete(pendingPollTokenKey);
    } else if (state == 'expired') {
      await secretStore.delete(pendingPollTokenKey);
    }
    return DeviceLinkExchange(
      state: state,
      expiresAt: json['expiresAt'] is String
          ? DateTime.tryParse(json['expiresAt']! as String)
          : null,
    );
  }

  Future<AuthProfile> getCurrentUser() async {
    final json = await api.get('/api/v1/auth/me') as Map<String, dynamic>;
    final user = json['user'] as Map<String, dynamic>;
    final familyJson = json['family'];
    final family = familyJson is Map<String, dynamic>
        ? FamilyRecord.fromJson(familyJson)
        : null;
    if (family != null) await localStore?.saveFamily(family);
    return AuthProfile(
      userId: user['id'] as String,
      nickname: user['nickname'] as String?,
      hasFamily: user['hasFamily'] == true,
      family: family,
    );
  }

  Future<void> _clearIdentityData() async {
    if (onIdentitySwitch != null) {
      await onIdentitySwitch!();
      return;
    }
    await localStore?.clearFamilyData();
  }

  Future<void> logout() async {
    try {
      await api.post('/api/v1/auth/logout');
    } finally {
      // 即使服务端撤销失败（含断网），本机也必须切到未登录状态：
      // 先清身份数据，再删令牌，避免停留在无令牌的已登录界面（A03）。
      await _clearIdentityData();
      await secretStore.delete(accessTokenKey);
      await secretStore.delete(pendingPollTokenKey);
    }
  }
}

class InvitationPreview {
  const InvitationPreview({required this.familyName, required this.expiresAt});
  final String familyName;
  final DateTime expiresAt;
}

class ApiFamilyRepository {
  ApiFamilyRepository({required this.api, required this.localStore, this.onFamilyChanged});
  final ApiClient api;
  final LocalAppStore localStore;

  /// 加入或创建另一个家庭前清理上一个家庭的库存快照（含内存）。
  final Future<void> Function()? onFamilyChanged;

  Future<FamilyRecord> getCurrentFamily() async {
    final json = await api.get('/api/v1/families/current') as Map<String, dynamic>;
    final family = FamilyRecord.fromJson(json['family'] as Map<String, dynamic>);
    await localStore.saveFamily(family);
    return family;
  }

  Future<FamilyRecord> createFamily(String name) async {
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

  Future<FamilyRecord> acceptInvitation(String code) async {
    await api.post('/api/v1/families/invitations/accept', body: {'code': code.trim()});
    // 加入新家庭：丢弃上一个家庭的库存快照，稍后重新同步（A03）。
    await _clearPreviousFamilySnapshot();
    return getCurrentFamily();
  }

  Future<void> _clearPreviousFamilySnapshot() async {
    if (onFamilyChanged != null) {
      await onFamilyChanged!();
      return;
    }
    await localStore.clearFamilyData();
  }

  Future<String> createInvitation() async {
    final json = await api.post('/api/v1/families/invitations') as Map<String, dynamic>;
    return json['invitationCode'] as String;
  }

  Future<void> updateNickname(String? nickname) async {
    await api.post(
      '/api/v1/users/me/nickname',
      body: {'nickname': nickname?.trim().isEmpty == true ? null : nickname?.trim()},
    );
  }
}

Map<String, Object?> jsonObject(String source) =>
    jsonDecode(source) as Map<String, Object?>;
