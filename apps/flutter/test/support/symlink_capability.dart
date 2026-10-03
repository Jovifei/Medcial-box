import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Only Windows' precise missing-privilege result makes this capability absent.
/// Other IO failures must remain visible, including errno 1314 on other hosts.
Future<String?> symbolicLinkSkipReason({
  required bool isWindows,
  required Future<void> Function() createLinks,
}) async {
  try {
    await createLinks();
    return null;
  } on FileSystemException catch (error) {
    if (!isWindows || error.osError?.errorCode != 1314) rethrow;
    return 'Windows symbolic-link fixture capability is unavailable '
        '(errno 1314); these security assertions were NOT RUN.';
  }
}

/// Call at the start of a symlink-dependent test and return when false.
/// Linux and other hosts always run the original assertions without a skip.
Future<bool> requireSymbolicLinks() async {
  if (!Platform.isWindows) return true;
  final directory = await Directory.systemTemp.createTemp('medbox-link-probe-');
  String? reason;
  try {
    final target = await File('${directory.path}/target').writeAsString('probe');
    reason = await symbolicLinkSkipReason(
      isWindows: Platform.isWindows,
      createLinks: () async {
        await Link('${directory.path}/file-link').create(target.path);
        await Link('${directory.path}/directory-link').create(directory.path);
      },
    );
  } finally {
    // Only this fresh synthetic fixture is removed; do not follow its links.
    for (final name in ['directory-link', 'file-link']) {
      final link = Link('${directory.path}/$name');
      if (await FileSystemEntity.type(link.path, followLinks: false) ==
          FileSystemEntityType.link) {
        await link.delete();
      }
    }
    await directory.delete(recursive: true);
  }
  if (reason == null) return true;
  markTestSkipped(reason);
  return false;
}
