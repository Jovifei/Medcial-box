import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

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
    this.requestTimeout = const Duration(seconds: 15),
  }) : baseUrl = _normalizeBaseUrl(baseUrl),
       _client = client ?? http.Client();

  final String baseUrl;
  final TokenProvider tokenProvider;
  final http.Client _client;
  final Duration requestTimeout;

  /// 收到 401 时触发（会话已在服务端失效）：由上层清理本机会话、删除令牌并回到未登录态（R10）。
  /// 用可设置字段而非构造参数，避免与依赖 ApiClient 的仓库形成构造期循环依赖。
  Future<void> Function()? onUnauthorized;
  Future<void> _identityCleanup = Future.value();
  Future<void> waitForIdentityCleanup() => _identityCleanup;
  int identityEpoch = 0;
  void invalidateIdentity() => identityEpoch++;

  static String _normalizeBaseUrl(String value) {
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
  }) => _send('POST', path, body: body, authenticated: authenticated);

  Future<dynamic> put(String path, Map<String, Object?> body) =>
      _send('PUT', path, body: body);

  Future<dynamic> delete(String path) => _send('DELETE', path);

  Future<dynamic> _send(
    String method,
    String path, {
    Map<String, Object?>? body,
    bool authenticated = true,
  }) async {
    final response = await _sendRequest(
      method,
      path,
      body: body,
      authenticated: authenticated,
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
  }) async {
    final epoch = identityEpoch;
    final token = authenticated ? await tokenProvider() : null;
    // Token storage can complete after logout/reconnection. Reject the old
    // intent before any request is sent with the replacement session token.
    if (authenticated && epoch != identityEpoch) {
      throw const ApiException(
        statusCode: 401,
        code: 'STALE_SESSION',
        message: '会话已变更，请重新加载。',
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
    if (response.statusCode == 401 &&
        authenticated &&
        epoch == identityEpoch &&
        token == await tokenProvider()) {
      final cleanup = onUnauthorized?.call();
      if (cleanup != null) {
        _identityCleanup = cleanup;
        await cleanup;
      }
    }
    if (authenticated && epoch != identityEpoch && response.statusCode != 401) {
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

  void close() => _client.close();
}

String friendlyApiError(Object error) {
  if (error is ApiNetworkException) return error.message;
  if (error is ApiException) {
    if (error.statusCode == 401) return '登录已过期，请重新连接家庭药箱。';
    if (error.statusCode == 409) return '这条记录刚被家人修改，请刷新后再试。';
    return error.message;
  }
  return '操作未完成，请检查网络后重试。';
}
