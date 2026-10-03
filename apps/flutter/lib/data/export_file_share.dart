import 'dart:io';

import 'package:flutter/services.dart';
import 'package:share_plus/share_plus.dart';

import 'export_temporary_store.dart';

/// Single, already-written file bridge to the locked share_plus 13.3.0 native
/// plugin. Its general Dart API awaits file preparation before native dispatch;
/// exports need the final identity guard after all preparation has finished.
/// Keep this payload/result contract tested against MethodChannelShare when
/// upgrading share_plus. Native copying and share-sheet behavior remain theirs.
class ExportFileShare {
  static const testedSharePlusVersion = '13.3.0';
  static const testedPlatformInterfaceVersion = '7.2.0';
  static const _channel = MethodChannel('dev.fluttercommunity.plus/share');

  static Future<ShareResult> share({
    required File file,
    required String mimeType,
    required String subject,
    required String text,
    required bool Function() isCurrent,
  }) async {
    if (file.path.isEmpty || mimeType.isEmpty || text.isEmpty) {
      throw ArgumentError(
        'A written file, MIME type and nonempty share text are required.',
      );
    }
    final arguments = <String, Object>{
      'paths': [file.path],
      'mimeTypes': [mimeType],
      'subject': subject,
      'text': text,
    };
    if (!isCurrent()) {
      throw const ExportTemporaryException('会话或页面已变更，请重新导出。');
    }
    // No await/file conversion between the final guard and native dispatch.
    final pending = _channel.invokeMethod<String>('share', arguments);
    final result =
        await pending ?? 'dev.fluttercommunity.plus/share/unavailable';
    final status = switch (result) {
      '' => ShareResultStatus.dismissed,
      'dev.fluttercommunity.plus/share/unavailable' =>
        ShareResultStatus.unavailable,
      _ => ShareResultStatus.success,
    };
    return ShareResult(result, status);
  }
}
