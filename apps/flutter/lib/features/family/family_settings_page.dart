import 'package:flutter/cupertino.dart';

import '../../core/theme/app_typography.dart';
import '../../core/theme/app_colors.dart';
import '../../core/widgets/apple_screen.dart';
import '../../data/api_workflow_repository.dart';
import '../../data/app_services.dart';
import '../../models/medicine_models.dart';

/// 家庭设置（对齐小程序 family-settings）：
/// 盘点频率、成员管理（转让/移出）、离开家庭。
class FamilySettingsPage extends StatefulWidget {
  const FamilySettingsPage({required this.services, super.key});

  final AppServices services;

  @override
  State<FamilySettingsPage> createState() => _FamilySettingsPageState();
}

class _FamilySettingsPageState extends State<FamilySettingsPage> {
  bool _loading = true;
  bool _busy = false;
  FamilyRecord? _family;
  FamilySettingsRecord? _settings;
  Object? _error;

  bool get _isCurrent => mounted;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final results = await Future.wait([
        widget.services.families!.getCurrentFamily(),
        widget.services.workflow!.getSettings(),
      ]);
      if (!_isCurrent) return;
      setState(() {
        _family = results[0] as FamilyRecord;
        _settings = results[1] as FamilySettingsRecord;
        _loading = false;
      });
    } catch (error) {
      if (!_isCurrent) return;
      setState(() {
        _error = error;
        _loading = false;
      });
    }
  }

  Future<void> _showAlert(String title, String content) {
    return showCupertinoDialog<void>(
      context: context,
      builder: (dialogContext) => CupertinoAlertDialog(
        title: Text(title),
        content: Text(content),
        actions: [
          CupertinoDialogAction(
            isDefaultAction: true,
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('好'),
          ),
        ],
      ),
    );
  }

  String _roleLabel(String role) {
    switch (role) {
      case 'owner':
        return '管理员';
      case 'caregiver':
        return '照护者';
      default:
        return '成员';
    }
  }

  Future<void> _updateInterval(String interval) async {
    if (_busy || _settings?.stocktakeInterval == interval) return;
    setState(() => _busy = true);
    try {
      final updated = await widget.services.workflow!.updateSettings(
        FamilySettingsRecord(stocktakeInterval: interval),
      );
      if (!_isCurrent) return;
      setState(() => _settings = updated);
    } catch (error) {
      if (_isCurrent) await _showAlert('保存失败', '$error');
    } finally {
      if (_isCurrent) setState(() => _busy = false);
    }
  }

  Future<void> _memberActions(FamilyMemberRecord member) async {
    final isOwner = _family?.role == 'owner';
    await showCupertinoModalPopup<void>(
      context: context,
      builder: (popupContext) => CupertinoActionSheet(
        title: Text(member.displayName),
        actions: [
          if (isOwner && !member.isSelf)
            CupertinoActionSheetAction(
              onPressed: () {
                Navigator.of(popupContext).pop();
                _transferOwnership(member);
              },
              child: const Text('转让所有权'),
            ),
          if (isOwner && !member.isSelf)
            CupertinoActionSheetAction(
              isDestructiveAction: true,
              onPressed: () {
                Navigator.of(popupContext).pop();
                _removeMember(member);
              },
              child: const Text('移出家庭'),
            ),
          if (!isOwner && member.isSelf)
            CupertinoActionSheetAction(
              isDestructiveAction: true,
              onPressed: () {
                Navigator.of(popupContext).pop();
                _leaveFamily();
              },
              child: const Text('离开家庭'),
            ),
        ],
        cancelButton: CupertinoActionSheetAction(
          onPressed: () => Navigator.of(popupContext).pop(),
          child: const Text('取消'),
        ),
      ),
    );
  }

  Future<void> _transferOwnership(FamilyMemberRecord member) async {
    final confirmed = await _confirm(
      '转让所有权',
      '把「${_family?.name ?? '家庭'}」的管理员身份转让给 ${member.displayName}？你将变普通成员。',
    );
    if (!confirmed) return;
    setState(() => _busy = true);
    try {
      await widget.services.workflow!.transferOwnership(member.id);
      if (_isCurrent) await _showAlert('已完成', '管理员已转让给 ${member.displayName}。');
      await _load();
    } catch (error) {
      if (_isCurrent) await _showAlert('转让失败', '$error');
    } finally {
      if (_isCurrent) setState(() => _busy = false);
    }
  }

  Future<void> _removeMember(FamilyMemberRecord member) async {
    final confirmed = await _confirm(
      '移出成员',
      '把 ${member.displayName} 移出「${_family?.name ?? '家庭'}」？移出后对方将无法再查看与修改库存。',
    );
    if (!confirmed) return;
    setState(() => _busy = true);
    try {
      await widget.services.workflow!.removeMember(member.id);
      await _load();
    } catch (error) {
      if (_isCurrent) await _showAlert('移出失败', '$error');
    } finally {
      if (_isCurrent) setState(() => _busy = false);
    }
  }

  Future<void> _leaveFamily() async {
    final confirmed = await _confirm(
      '离开家庭',
      '离开后你将无法查看「${_family?.name ?? '家庭'}」的库存与计划，需要重新受邀才能加入。',
    );
    if (!confirmed) return;
    setState(() => _busy = true);
    try {
      await widget.services.workflow!.leaveFamily();
      // familyInvalidated 会把导航带回 /family-choice；这里只等待跳转。
    } catch (error) {
      if (_isCurrent) await _showAlert('离开失败', '$error');
    } finally {
      if (_isCurrent) setState(() => _busy = false);
    }
  }

  Future<bool> _confirm(String title, String content) async {
    final result = await showCupertinoDialog<bool>(
      context: context,
      builder: (dialogContext) => CupertinoAlertDialog(
        title: Text(title),
        content: Text(content),
        actions: [
          CupertinoDialogAction(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          CupertinoDialogAction(
            isDestructiveAction: true,
            isDefaultAction: true,
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('确认'),
          ),
        ],
      ),
    );
    return result ?? false;
  }

  String _nextStocktakeLabel() {
    final raw = _settings?.nextStocktakeAt;
    if (raw == null || raw.isEmpty) return '未安排';
    return raw.length >= 10 ? raw.substring(0, 10) : raw;
  }

  @override
  Widget build(BuildContext context) {
    final c = AppSemanticColors.of(View.of(context).platformDispatcher.platformBrightness);
    Widget body;
    if (_loading) {
      body = const Center(child: CupertinoActivityIndicator(radius: 14));
    } else if (_error != null || _family == null || _settings == null) {
      body = Center(
        child: CupertinoButton(
          onPressed: _load,
          child: Text('加载失败，点按重试', style: AppType.body.copyWith(color: c.accent)),
        ),
      );
    } else {
      body = ListView(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        children: [
          CupertinoListSection.insetGrouped(
            header: Text('家庭', style: AppType.footnote.copyWith(color: c.secondaryLabel)),
            children: [
              CupertinoListTile(
                title: Text(_family!.name, style: AppType.headline),
                additionalInfo: Text(
                  _roleLabel(_family!.role),
                  style: AppType.subhead.copyWith(color: c.secondaryLabel),
                ),
              ),
            ],
          ),
          CupertinoListSection.insetGrouped(
            header: Text('盘点频率', style: AppType.footnote.copyWith(color: c.secondaryLabel)),
            children: [
              for (final entry in const [
                ('weekly', '每周盘点'),
                ('monthly', '每月盘点'),
                ('disabled', '关闭盘点提醒'),
              ])
                CupertinoListTile(
                  title: Text(entry.$2, style: AppType.body),
                  trailing: _settings!.stocktakeInterval == entry.$1
                      ? Icon(CupertinoIcons.check_mark, color: c.accent, size: 20)
                      : null,
                  onTap: _busy ? null : () => _updateInterval(entry.$1),
                ),
              CupertinoListTile(
                title: Text('下次盘点', style: AppType.body),
                additionalInfo: Text(
                  _nextStocktakeLabel(),
                  style: AppType.subhead.copyWith(color: c.secondaryLabel),
                ),
              ),
            ],
          ),
          CupertinoListSection.insetGrouped(
            header: Text('家庭成员', style: AppType.footnote.copyWith(color: c.secondaryLabel)),
            children: [
              for (final member in _family!.members)
                CupertinoListTile(
                  title: Text(
                    member.isSelf ? '${member.displayName}（我）' : member.displayName,
                    style: AppType.body,
                  ),
                  subtitle: Text(_roleLabel(member.role), style: AppType.footnote),
                  trailing: (_family!.role == 'owner' || member.isSelf)
                      ? const Icon(CupertinoIcons.ellipsis, size: 18)
                      : null,
                  onTap: _busy ? null : () => _memberActions(member),
                ),
            ],
          ),
          if (_family!.role == 'owner')
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
              child: Text(
                '邀请家人：在「我的 → 邀请家人加入」生成邀请码。',
                style: AppType.footnote.copyWith(color: c.secondaryLabel),
              ),
            ),
          CupertinoListSection.insetGrouped(
            children: [
              CupertinoListTile(
                title: Text(
                  '离开家庭',
                  style: AppType.body.copyWith(color: c.danger),
                ),
                onTap: _busy ? null : _leaveFamily,
              ),
            ],
          ),
        ],
      );
    }
    return AppleScreen(title: '家庭设置', child: body);
  }
}
