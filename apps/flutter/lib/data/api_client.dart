import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'session_identity_state.dart';

typedef TokenProvider = Future<String?> Function();

class ApiException implements Exception {
  const ApiException({
    required this.statusCode,
    required this.code,
    required this.message,
  });

  final int statusCode;
  final String code;
  final String message;

  @override
  String toString() => message;
}

class ApiNetworkException implements Exception {
  const ApiNetworkException(this.message);
  final String message;

  @override
  String toString() => message;
}

class ApiBinaryResponse {
  const ApiBinaryResponse({required this.bytes, this.contentType});
  final Uint8List bytes;
  final String? contentType;
}

class ApiClient {
  ApiClient({
    required String baseUrl,
    required this.tokenProvider,
    http.Client? client,
    this.identityState,
    this.requestTimeout = const Duration(seconds: 15),
  }) : baseUrl = normalizeBaseUrl(baseUrl),
       _client = client ?? http.Client();

  final String baseUrl;
  final TokenProvider tokenProvider;
  final SessionIdentityState? identityState;
  Future<VerifiedOwnerContext?> Function()? refreshIdentityContext;
  final http.Client _client;
  final Duration requestTimeout;

  /// 收到 401 时触发（会话已在服务端失效）：由上层清理本机会话、删除令牌并回到未登录态（R10）。
  /// 用可设置字段而非构造参数，避免与依赖 ApiClient 的仓库形成构造期循环依赖。
  Future<void> Function()? onUnauthorized;

  /// The authenticated session is valid, but its current family no longer
  /// exists/is accessible. Keep the token so family setup can continue.
  Future<void> Function()? onFamilyUnavailable;
  Future<void> _identityCleanup = Future.value();
  Future<void> Function()? _retryIdentityCleanup;
  int? _cleanupEpoch;

  Future<void> _beginIdentityCleanup(Future<void> Function() cleanup) {
    final previous = _identityCleanup;
    final pending = cleanup();
    _retryIdentityCleanup = cleanup;
    _cleanupEpoch = identityEpoch;
    // Keep every earlier native/storage cleanup inside the acceptance barrier.
    // A new attempt may recover an earlier failure, but must also drain it.
    final barrier = Future.wait<void>([
      previous.catchError((Object _) {}),
      pending,
    ]).then<void>((_) {});
    _identityCleanup = barrier;
    return barrier;
  }

  Future<void> waitForIdentityCleanup() async {
    var retried = false;
    while (true) {
      final pending = _identityCleanup;
      try {
        await pending;
      } catch (_) {
        if (!identical(pending, _identityCleanup)) continue;
        // Retry once per explicit call; a failed retry remains fail-closed.
        if (retried ||
            _retryIdentityCleanup == null ||
            _cleanupEpoch != identityEpoch) {
          rethrow;
        }
        retried = true;
        await _beginIdentityCleanup(_retryIdentityCleanup!);
      }
      // A newer loss may start while an older cleanup is being awaited.
      if (identical(pending, _identityCleanup)) return;
    }
  }

  /// Explicit auth/family cleanup participates in the same full barrier as
  /// response-triggered cleanup, including any overlapping newer callback.
  Future<void> cleanupForIdentityTransition(
    Future<void> Function() cleanup,
  ) async {
    await _beginIdentityCleanup(cleanup);
    await waitForIdentityCleanup();
  }

  Future<void> _identityTransitions = Future.value();

  /// Auth and family acceptance share one queue, so cleanup of the previous
  /// identity finishes before a replacement token/family can be accepted.
  Future<T> transitionIdentity<T>(
    Future<T> Function() action, {
    bool allowFailedCleanup = false,
  }) {
    final next = _identityTransitions.then((_) async {
      while (true) {
        final pending = _identityCleanup;
        try {
          await waitForIdentityCleanup();
        } catch (_) {
          if (!allowFailedCleanup) rethrow;
          // Explicit logout still attempts server revoke and token deletion.
          break;
        }
        if (identical(pending, _identityCleanup)) break;
      }
      return action();
    });
    _identityTransitions = next.then<void>((_) {}, onError: (Object _) {});
    return next;
  }

  int identityEpoch = 0;
  void invalidateIdentity() => identityEpoch++;

  /// Used only after auth/me explicitly and consistently reports no family.
  /// Shares the error-response cleanup barrier with auth/family transitions.
  Future<int> reportNoCurrentFamily(int expectedEpoch) async {
    if (expectedEpoch != identityEpoch) {
      throw const ApiException(
        statusCode: 401,
        code: 'STALE_SESSION',
        message: '会话已变更，请重新加载。',
      );
    }
    final handler = onFamilyUnavailable;
    final cleanup = handler == null ? null : _beginIdentityCleanup(handler);
    final cleanupEpoch = identityEpoch;
    if (cleanup != null) await cleanup;
    return cleanupEpoch;
  }

  static String normalizeBaseUrl(String value) {
    final trimmed = value.trim().replaceFirst(RegExp(r'/+$'), '');
    final uri = Uri.tryParse(trimmed);
    if (uri == null ||
        !uri.hasAuthority ||
        !{'http', 'https'}.contains(uri.scheme)) {
      throw ArgumentError.value(
        value,
        'baseUrl',
        '必须是 http(s):// 开头的有效 API 地址',
      );
    }
    return trimmed;
  }

  Future<dynamic> get(String path, {bool authenticated = true}) =>
      _send('GET', path, authenticated: authenticated);

  Future<ApiBinaryResponse> getBinary(
    String path, {
    bool authenticated = true,
  }) async {
    final response = await _sendRequest(
      'GET',
      path,
      authenticated: authenticated,
      accept: 'image/jpeg, image/png',
    );
    final decodedError = response.statusCode >= 200 && response.statusCode < 300
        ? null
        : _decodeErrorBody(response);
    _throwIfFailed(response, decodedError);
    if (response.bodyBytes.isEmpty) {
      throw const ApiException(
        statusCode: 502,
        code: 'EMPTY_RESPONSE',
        message: '图片内容为空，请稍后重试。',
      );
    }
    return ApiBinaryResponse(
      bytes: response.bodyBytes,
      contentType: response.headers['content-type']?.split(';').first.trim(),
    );
  }

  Future<dynamic> post(
    String path, {
    Map<String, Object?> body = const {},
    bool authenticated = true,
    bool Function()? isCurrent,
  }) => _send(
    'POST',
    path,
    body: body,
    authenticated: authenticated,
    isCurrent: isCurrent,
  );

  Future<dynamic> put(
    String path,
    Map<String, Object?> body, {
    bool Function()? isCurrent,
  }) => _send('PUT', path, body: body, isCurrent: isCurrent);

  Future<dynamic> delete(String path) => _send('DELETE', path);

  Future<dynamic> _send(
    String method,
    String path, {
    Map<String, Object?>? body,
    bool authenticated = true,
    bool Function()? isCurrent,
  }) async {
    final response = await _sendRequest(
      method,
      path,
      body: body,
      authenticated: authenticated,
      isCurrent: isCurrent,
    );

    if (response.statusCode == 204 || response.bodyBytes.isEmpty) {
      _throwIfFailed(response, null);
      return null;
    }
    dynamic decoded;
    try {
      decoded = jsonDecode(utf8.decode(response.bodyBytes));
    } on FormatException {
      _throwIfFailed(response, null);
      throw const ApiException(
        statusCode: 502,
        code: 'INVALID_RESPONSE',
        message: '服务器返回格式无法识别，请稍后重试。',
      );
    }
    _throwIfFailed(response, decoded);
    return decoded;
  }

  Future<http.Response> _sendRequest(
    String method,
    String path, {
    Map<String, Object?>? body,
    bool authenticated = true,
    String accept = 'application/json',
    bool Function()? isCurrent,
  }) async {
    final epoch = identityEpoch;
    final token = authenticated ? await tokenProvider() : null;
    // Token storage can complete after logout/reconnection. Reject the old
    // intent before any request is sent with the replacement session token.
    if ((authenticated && epoch != identityEpoch) ||
        (isCurrent != null && !isCurrent())) {
      throw const ApiException(
        statusCode: 401,
        code: 'STALE_SESSION',
        message: '会话已变更，请重新加载。',
      );
    }
    if (authenticated &&
        identityState != null &&
        (token == null || token.isEmpty)) {
      throw const ApiException(
        statusCode: 401,
        code: 'SESSION_BLOCKED',
        message: '登录状态尚未确认，请重新连接。',
      );
    }
    final headers = <String, String>{'accept': accept};
    if (body != null) {
      headers['content-type'] = 'application/json; charset=utf-8';
    }
    if (token != null && token.isNotEmpty) {
      headers['authorization'] = 'Bearer $token';
    }
    final uri = Uri.parse('$baseUrl${path.startsWith('/') ? path : '/$path'}');

    http.Response response;
    try {
      final request = http.Request(method, uri)..headers.addAll(headers);
      if (body != null) request.body = jsonEncode(body);
      final streamed = await _client.send(request).timeout(requestTimeout);
      response = await http.Response.fromStream(streamed)
          .timeout(requestTimeout);
    } on TimeoutException {
      throw const ApiNetworkException('连接超时，请检查网络后重试。');
    } on SocketException {
      throw const ApiNetworkException('无法连接服务器，请检查网络后重试。');
    } on http.ClientException {
      throw const ApiNetworkException('无法连接服务器，请检查网络后重试。');
    }
    final errorBody = response.statusCode == 404
        ? _decodeErrorBody(response)
        : null;
    final familyUnavailable =
        errorBody is Map<String, dynamic> &&
        errorBody['error'] is Map<String, dynamic> &&
        (errorBody['error'] as Map<String, dynamic>)['code'] ==
            'FAMILY_NOT_FOUND';
    var cleanedCurrentFamily = false;
    if (authenticated &&
        (response.statusCode == 401 || familyUnavailable) &&
        epoch == identityEpoch &&
        token == await tokenProvider() &&
        epoch == identityEpoch) {
      // The second token lookup is asynchronous too. Recheck the epoch AFTER
      // it, including same-token family changes, before invoking any cleanup.
      final handler = response.statusCode == 401
          ? onUnauthorized
          : onFamilyUnavailable;
      if (handler != null) {
        cleanedCurrentFamily = familyUnavailable;
        await _beginIdentityCleanup(handler);
      }
    }
    if (authenticated &&
        epoch != identityEpoch &&
        response.statusCode != 401 &&
        !cleanedCurrentFamily) {
      throw const ApiException(
        statusCode: 401,
        code: 'STALE_SESSION',
        message: '会话已变更，请重新加载。',
      );
    }
    return response;
  }

  dynamic _decodeErrorBody(http.Response response) {
    if (response.bodyBytes.isEmpty) return null;
    try {
      return jsonDecode(utf8.decode(response.bodyBytes));
    } on FormatException {
      return null;
    }
  }

  void _throwIfFailed(http.Response response, dynamic decoded) {
    if (response.statusCode >= 200 && response.statusCode < 300) return;
    final error =
        decoded is Map<String, dynamic> &&
            decoded['error'] is Map<String, dynamic>
        ? decoded['error']! as Map<String, dynamic>
        : const <String, dynamic>{};
    throw ApiException(
      statusCode: response.statusCode,
      code: error['code'] is String ? error['code']! as String : 'HTTP_ERROR',
      message: error['message'] is String
          ? error['message']! as String
          : '请求未成功（${response.statusCode}），请稍后重试。',
    );
  }

  /// Bounded best-effort revoke uses only the captured outgoing credential.
  /// It cannot invoke a cleanup callback against a replacement identity.
  Future<void> revokeSession(String token) async {
    try {
      final response = await _client
          .post(
            Uri.parse('$baseUrl/api/v1/auth/logout'),
            headers: {
              'authorization': 'Bearer $token',
              'content-type': 'application/json; charset=utf-8',
            },
            body: '{}',
          )
          .timeout(requestTimeout);
      _throwIfFailed(response, _decodeErrorBody(response));
    } on TimeoutException {
      throw const ApiNetworkException('连接超时，请检查网络后重试。');
    } on SocketException {
      throw const ApiNetworkException('无法连接服务器，请检查网络后重试。');
    } on http.ClientException {
      throw const ApiNetworkException('无法连接服务器，请检查网络后重试。');
    }
  }

  void close() => _client.close();
}

String friendlyApiError(Object error) {
  if (error is SessionPersistenceException) return error.toString();
  if (error is ApiNetworkException) return error.message;
  if (error is ApiException) {
    if (error.statusCode == 401) return '登录已过期，请重新连接家庭药箱。';
    if (error.statusCode == 409) return '这条记录刚被家人修改，请刷新后再试。';
    return error.message;
  }
  return '操作未完成，请检查网络后重试。';
}
