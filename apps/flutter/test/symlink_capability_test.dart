import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'support/symlink_capability.dart';

void main() {
  test(
    'available Windows symlinks keep the security assertions enabled',
    () async {
      var calls = 0;
      expect(
        await symbolicLinkSkipReason(
          isWindows: true,
          createLinks: () async {
            calls++;
          },
        ),
        isNull,
      );
      expect(calls, 1);
    },
  );

  test(
    'only Windows missing symlink privilege gives an explicit skip reason',
    () async {
      final reason = await symbolicLinkSkipReason(
        isWindows: true,
        createLinks: () async => throw const FileSystemException(
          'synthetic link privilege failure',
          'synthetic-link',
          OSError('privilege not held', 1314),
        ),
      );
      expect(reason, contains('errno 1314'));
      expect(reason, contains('NOT RUN'));
    },
  );

  for (final scenario in [
    (false, 1314),
    (true, 5),
    (true, 2),
  ]) {
    test('other host/error ${scenario.$1}/${scenario.$2} still fails', () async {
      final error = FileSystemException(
        'synthetic probe failure',
        'synthetic-link',
        OSError('synthetic', scenario.$2),
      );
      await expectLater(
        symbolicLinkSkipReason(
          isWindows: scenario.$1,
          createLinks: () async => throw error,
        ),
        throwsA(same(error)),
      );
    });
  }

  test('non-filesystem probe failures are not hidden', () async {
    final error = StateError('synthetic probe bug');
    await expectLater(
      symbolicLinkSkipReason(
        isWindows: true,
        createLinks: () async => throw error,
      ),
      throwsA(same(error)),
    );
  });
}
