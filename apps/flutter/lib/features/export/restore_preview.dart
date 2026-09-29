String? backupRestoreBlockReason(Map<String, dynamic> preview) {
  if (preview['duplicateBackup'] == true) return '这份备份已经导入过。';
  if (preview['valid'] != true) {
    final errors = (preview['errors'] as List<dynamic>? ?? const [])
        .whereType<String>()
        .toList(growable: false);
    return '备份未通过校验${errors.isEmpty ? '，请检查文件后重试' : '：${errors.join('；')}'}。';
  }
  final token = preview['confirmationToken'];
  if (token is! String || token.isEmpty) return '恢复预览凭据已失效，请重新选择并预览备份。';
  return null;
}
