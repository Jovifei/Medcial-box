import 'dart:convert';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_surfaces.dart';
import '../../data/api_client.dart';
import '../../data/api_medicine_repository.dart';
import '../../data/api_workflow_repository.dart';
import '../../data/export_temporary_store.dart';
import '../../data/export_file_share.dart';
import 'restore_preview.dart';

enum ExportKind { markdown, csv, pdf }

/// 一次导出的不可变选项快照（R16）：与生成的文本、扩展名、MIME 一一绑定。
/// 分享/复制只读取这份快照，绝不再读可变的页面状态，
/// 杜绝"等旧预览完成后却按新 kind 命名/编码"的格式与隐私错配。
class _ExportOptions {
  const _ExportOptions({
    required this.kind,
    required this.includeDose,
    required this.includeArchived,
    required this.includeStorage,
  });

  final ExportKind kind;
  final bool includeDose;
  final bool includeArchived;
  final bool includeStorage;

  String get extension => _extension(kind);

  String get mimeType => switch (kind) {
    ExportKind.markdown => 'text/markdown',
    ExportKind.csv => 'text/csv',
    ExportKind.pdf => 'application/pdf',
  };
}

/// 预览结果与生成它的选项绑定（R16）。
class _ExportPreview {
  const _ExportPreview({required this.options, required this.text, this.bytes});
  final _ExportOptions options;
  final String text;
  final List<int>? bytes;
}

class ExportApiPage extends StatefulWidget {
  const ExportApiPage({
    super.key,
    required this.repository,
    required this.workflow,
  });
  final ApiMedicineRepository repository;
  final ApiWorkflowRepository workflow;
  @override
  State<ExportApiPage> createState() => _ExportApiPageState();
}

class _ExportApiPageState extends State<ExportApiPage> {
  ExportKind kind = ExportKind.markdown;
  bool includeDose = false;
  bool includeArchived = false;
  bool includeStorage = true;
  bool busy = false;
  Object? failure;
  final Map<String, Future<String>> snapshots = {};
  Future<_ExportPreview>? previewFuture;
  late final int _identityEpoch;
  late final int _exportEpoch;

  bool get _isCurrent =>
      mounted &&
      widget.workflow.api.identityEpoch == _identityEpoch &&
      widget.workflow.exportFiles.identityEpoch == _exportEpoch;

  @override
  void initState() {
    super.initState();
    _identityEpoch = widget.workflow.api.identityEpoch;
    _exportEpoch = widget.workflow.exportFiles.identityEpoch;
    previewFuture = _makePreview(_currentOptions());
  }

  _ExportOptions _currentOptions() => _ExportOptions(
    kind: kind,
    includeDose: includeDose,
    includeArchived: includeArchived,
    includeStorage: includeStorage,
  );

  Future<void> _refreshPreview() async {
    if (!_isCurrent) return;
    setState(() {
      failure = null;
      previewFuture = _makePreview(_currentOptions());
    });
  }

  Future<_ExportPreview> _makePreview(_ExportOptions options) async {
    try {
      final key =
          '${options.includeDose}:${options.includeArchived}:${options.includeStorage}';
      final snapshotId = await snapshots.putIfAbsent(key, () async {
        final result = await widget.workflow.api.post(
          '/api/v1/exports/snapshot',
          body: {
            'includePersonalDosage': options.includeDose,
            'includeArchived': options.includeArchived,
            'includeStorageLocation': options.includeStorage,
          },
        ) as Map<String, dynamic>;
        return result['snapshotId'] as String;
      });
      final result = await widget.workflow.exportSnapshotFormat(
        snapshotId: snapshotId,
        format: options.kind.name,
        includePersonalDosage: options.includeDose,
        includeArchived: options.includeArchived,
        includeStorageLocation: options.includeStorage,
      );
      return _ExportPreview(
        options: options,
        text: options.kind == ExportKind.csv
            ? result['content'] as String
            : result['markdown'] as String,
        bytes: options.kind == ExportKind.pdf
            ? base64Decode(result['contentBase64'] as String)
            : null,
      );
    } catch (error) {
      snapshots.clear();
      failure = error;
      rethrow;
    }
  }

  Future<void> _copy() async {
    if (!_isCurrent) return;
    try {
      final preview = await previewFuture!;
      if (!_isCurrent) return;
      await Clipboard.setData(ClipboardData(text: preview.text));
      if (_isCurrent) {
        _message(
          preview.options.kind == ExportKind.pdf
              ? 'PDF 对应的清单文本已复制。'
              : '${preview.options.extension.toUpperCase()} 内容已复制。',
        );
      }
    } catch (error) {
      if (_isCurrent) _error(error);
    }
  }

  Future<void> _shareFile() async {
    if (busy || !_isCurrent) return;
    setState(() => busy = true);
    OwnedExportFile? owned;
    try {
      final preview = await previewFuture!;
      if (!_isCurrent) return;
      final options = preview.options;
      owned = await widget.workflow.exportFiles.create(
        bytes: preview.bytes ?? utf8.encode(preview.text),
        extension: options.extension,
        identityEpoch: _exportEpoch,
        isCurrent: () => _isCurrent,
      );
      if (!_isCurrent) return;
      final result = await widget.workflow.exportFiles.handoff(
        owned,
        isCurrent: () => _isCurrent,
        send: (file) => ExportFileShare.share(
          file: file,
          mimeType: options.mimeType,
          subject: '家庭药箱库存清单',
          text: '家庭药箱库存记录，仅供核对。库存存在不代表适合服用。',
          isCurrent: () => _isCurrent,
        ),
      );
      if (_isCurrent) _shareResult(result);
    } catch (error) {
      if (_isCurrent) _shareError(error);
    } finally {
      await _releaseExport(owned);
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _createBackup() async {
    if (busy || !_isCurrent) return;
    setState(() => busy = true);
    OwnedExportFile? owned;
    try {
      final backup = await widget.workflow.createJsonBackup();
      if (!_isCurrent) return;
      owned = await widget.workflow.exportFiles.create(
        bytes: utf8.encode(const JsonEncoder.withIndent('  ').convert(backup)),
        extension: 'json',
        identityEpoch: _exportEpoch,
        isCurrent: () => _isCurrent,
        backup: true,
      );
      if (!_isCurrent) return;
      final result = await widget.workflow.exportFiles.handoff(
        owned,
        isCurrent: () => _isCurrent,
        send: (file) => ExportFileShare.share(
          file: file,
          mimeType: 'application/json',
          subject: '家庭药箱 JSON 备份',
          text: '该备份不包含登录令牌和个人剂量备注。请安全保存。',
          isCurrent: () => _isCurrent,
        ),
      );
      if (_isCurrent) _shareResult(result);
    } catch (error) {
      if (_isCurrent) _shareError(error);
    } finally {
      await _releaseExport(owned);
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _releaseExport(OwnedExportFile? owned) async {
    try {
      await owned?.release();
    } catch (_) {
      if (_isCurrent) _message('临时导出文件未能清理，请稍后重新连接药箱再试。');
    }
  }

  void _shareResult(ShareResult result) => _message(switch (result.status) {
    ShareResultStatus.success => '已选择分享目标，请在目标应用确认结果。',
    ShareResultStatus.dismissed => '已取消分享。',
    ShareResultStatus.unavailable => '分享结果无法确认，请在目标应用核对。',
  });

  void _shareError(Object error) {
    if (error is ExportTemporaryException) {
      _message(error.message);
    } else if (error is FileSystemException) {
      _message('无法准备临时导出文件，请检查存储空间后重试。');
    } else if (error is PlatformException ||
        error is MissingPluginException ||
        error is UnimplementedError) {
      _message('未能打开分享，请稍后重试。');
    } else {
      _error(error);
    }
  }

  Future<void> _restoreBackup() async {
    if (busy || !_isCurrent) return;
    setState(() => busy = true);
    try {
      final file = await FilePicker.pickFile(
        type: FileType.custom,
        allowedExtensions: const ['json'],
      );
      if (file == null || !_isCurrent) return;
      final bytes = await file.readAsBytes();
      if (!_isCurrent) return;
      final backup = widget.workflow.parseBackupFile(utf8.decode(bytes));
      final preview = await widget.workflow.previewJsonRestore(backup);
      if (!mounted || !_isCurrent) return;
      final blockReason = backupRestoreBlockReason(preview);
      if (blockReason != null) throw FormatException(blockReason);
      final confirmationToken = preview['confirmationToken'] as String;
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('检查恢复内容'),
          content: SingleChildScrollView(
            child: SelectableText(_restorePreviewText(preview)),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('新增到当前家庭'),
            ),
          ],
        ),
      );
      if (confirmed != true || !_isCurrent) return;
      final result = await widget.workflow.restoreJsonBackup(
        backup,
        confirmationToken,
      );
      if (!_isCurrent) return;
      // 只刷新活动库存（R15）：含归档的查询会把归档记录写回共享快照，污染首页与提醒。
      await widget.repository.listMedicines();
      if (_isCurrent) {
        _message('恢复完成：新增 ${result['restoredCount'] ?? '已处理'} 项。');
        await _refreshPreview();
      }
    } catch (error) {
      if (_isCurrent) _error(error);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  void _message(String message) =>
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(message)));
  void _error(Object error) => _message(friendlyApiError(error));

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('导出与备份')),
    body: ListView(
      padding: const EdgeInsets.fromLTRB(18, 8, 18, 24),
      children: [
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('导出前确认', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              SwitchListTile.adaptive(
                contentPadding: EdgeInsets.zero,
                title: const Text('包含个人剂量备注'),
                subtitle: const Text('默认关闭；仅导出当前用户有权查看的个人备注'),
                value: includeDose,
                // 分享/备份/恢复进行中锁定选项，避免生成途中被改动导致格式或隐私错配（R16）。
                onChanged: busy
                    ? null
                    : (v) {
                        setState(() => includeDose = v);
                        _refreshPreview();
                      },
              ),
              SwitchListTile.adaptive(
                contentPadding: EdgeInsets.zero,
                title: const Text('包含归档记录'),
                value: includeArchived,
                onChanged: busy
                    ? null
                    : (v) {
                        setState(() => includeArchived = v);
                        _refreshPreview();
                      },
              ),
              SwitchListTile.adaptive(
                contentPadding: EdgeInsets.zero,
                title: const Text('包含存放位置'),
                value: includeStorage,
                onChanged: busy
                    ? null
                    : (v) {
                        setState(() => includeStorage = v);
                        _refreshPreview();
                      },
              ),
              const SizedBox(height: 5),
              SegmentedButton<ExportKind>(
                segments: const [
                  ButtonSegment(
                    value: ExportKind.markdown,
                    label: Text('Markdown'),
                  ),
                  ButtonSegment(value: ExportKind.csv, label: Text('CSV')),
                  ButtonSegment(value: ExportKind.pdf, label: Text('PDF')),
                ],
                selected: {kind},
                onSelectionChanged: busy
                    ? null
                    : (values) {
                        setState(() => kind = values.first);
                        _refreshPreview();
                      },
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        if (kind == ExportKind.pdf)
          const AppCard(
            color: Color(0xFFEAF5EE),
            child: Text('PDF 使用内嵌简体中文字体。分享会生成可阅读的 A4 库存清单；个人剂量仍按上方选项控制。'),
          ),
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      '${kind == ExportKind.pdf ? '清单内容' : '预览'} · ${_extension(kind).toUpperCase()}',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                  ),
                  IconButton(
                    tooltip: '刷新预览',
                    onPressed: busy ? null : _refreshPreview,
                    icon: const Icon(Icons.refresh_rounded),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              FutureBuilder<_ExportPreview>(
                future: previewFuture,
                builder: (context, snapshot) {
                  if (snapshot.connectionState != ConnectionState.done) {
                    return const Center(
                      child: Padding(
                        padding: EdgeInsets.all(24),
                        child: CircularProgressIndicator(),
                      ),
                    );
                  }
                  if (snapshot.hasError) {
                    return Column(
                      children: [
                        Text(friendlyApiError(snapshot.error!)),
                        const SizedBox(height: 10),
                        SoftButton(label: '重试', onPressed: _refreshPreview),
                      ],
                    );
                  }
                  return SelectableText(
                    snapshot.data?.text ?? '',
                    style: const TextStyle(
                      fontFamily: 'monospace',
                      height: 1.5,
                      fontSize: 12,
                    ),
                  );
                },
              ),
              if (kind == ExportKind.markdown) ...[
                const SizedBox(height: 6),
                const Text('Markdown 是交给外部 AI 的默认格式。个人备注默认排除。'),
              ],
            ],
          ),
        ),
        const SizedBox(height: 12),
        PrimaryButton(
          label: busy ? '正在处理…' : '分享 ${_extension(kind).toUpperCase()} 文件',
          icon: Icons.ios_share_rounded,
          onPressed: busy ? null : _shareFile,
        ),
        const SizedBox(height: 8),
        SoftButton(
          label: '复制内容',
          icon: Icons.copy_rounded,
          onPressed: busy || kind == ExportKind.pdf ? null : _copy,
        ),
        const SizedBox(height: 20),
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'JSON 备份与恢复',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 6),
              const Text(
                '备份包含药品、批次、开封期限、阈值和家庭盘点设置，不包含登录令牌与个人剂量备注。恢复前会预览，只新增数据，不覆盖当前药箱。',
              ),
              const SizedBox(height: 12),
              PrimaryButton(
                label: busy ? '正在准备…' : '创建并分享备份',
                icon: Icons.backup_outlined,
                onPressed: busy ? null : _createBackup,
              ),
              const SizedBox(height: 8),
              SoftButton(
                label: '选择 JSON 文件并恢复',
                icon: Icons.restore_rounded,
                onPressed: busy ? null : _restoreBackup,
              ),
            ],
          ),
        ),
        const SizedBox(height: 8),
        const Text(
          '数据库和说明书图片由服务器备份流程单独保护。导出的家庭清单不表示药品适合服用。',
          style: TextStyle(color: AppColors.muted),
        ),
      ],
    ),
  );
}

String _extension(ExportKind kind) => switch (kind) {
  ExportKind.markdown => 'md',
  ExportKind.csv => 'csv',
  ExportKind.pdf => 'pdf',
};

String _restorePreviewText(Map<String, dynamic> preview) {
  final count = preview['medicineCount'] ?? '由服务器校验';
  final matches = preview['likelyMatches'] as List<dynamic>? ?? const [];
  final errors = preview['errors'] as List<dynamic>? ?? const [];
  final settings = preview['inventorySettings'] as Map<String, dynamic>?;
  final stocktake = settings?['stocktakeInterval'] ?? '未提供';
  return '备份药品：$count 项\n备份盘点频率：$stocktake（仅供参考，恢复不会修改当前家庭设置）\n可能重复项：${jsonEncode(matches)}\n校验问题：${jsonEncode(errors)}\n\n恢复会以事务方式新增药品和批次，不覆盖当前家庭。相同备份重复提交会被拒绝。';
}
