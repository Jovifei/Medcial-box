import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/features/export/restore_preview.dart';

void main() {
  test('invalid, duplicate, or tokenless backup previews cannot be confirmed', () {
    expect(backupRestoreBlockReason({'valid': false, 'errors': ['日期无效']}), contains('日期无效'));
    expect(backupRestoreBlockReason({'valid': true, 'duplicateBackup': true}), contains('已经导入过'));
    expect(backupRestoreBlockReason({'valid': true, 'duplicateBackup': false}), contains('凭据已失效'));
  });

  test('valid preview with a confirmation token may continue to the confirmation dialog', () {
    expect(
      backupRestoreBlockReason({
        'valid': true,
        'duplicateBackup': false,
        'confirmationToken': 'a' * 64,
      }),
      isNull,
    );
  });
}
