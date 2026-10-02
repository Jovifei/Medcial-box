import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_surfaces.dart';
import '../../data/api_client.dart';
import '../../data/app_services.dart';
import '../../models/medicine_models.dart';
import 'release_notes_page.dart';

class MyPage extends StatefulWidget {
  const MyPage({super.key, required this.services});
  final AppServices services;
  @override
  State<MyPage> createState() => _MyPageState();
}

class _MyPageState extends State<MyPage> {
  Future<FamilyRecord>? familyFuture;
  bool reminderEnabled = false;
  bool loadingWechat = false;
  Map<String, dynamic>? wechatTemplates;

  @override
  void initState() {
    super.initState();
    familyFuture = widget.services.families!.getCurrentFamily();
    widget.services.reminders.onNotificationTap = (_) {
      if (mounted) context.go('/home?tab=pending');
    };
    _restoreReminderState();
    _loadWechatTemplates();
  }

  Future<void> _restoreReminderState() async {
    try {
      await widget.services.reminders.resume(widget.services.medicines!);
      if (mounted) {
        setState(() => reminderEnabled = widget.services.reminders.enabled);
      }
    } catch (_) {
      // Local reminders are optional; the pending list remains available.
    }
  }

  Future<void> _loadWechatTemplates() async {
    setState(() => loadingWechat = true);
    try {
      final result = await widget.services.workflow!
          .notificationTemplateStatus();
      if (mounted) {
        setState(() {
          wechatTemplates = result;
          loadingWechat = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => loadingWechat = false);
    }
  }

  Future<void> _createInvite() async {
    try {
      final code = await widget.services.families!.createInvitation();
      if (!mounted) return;
      await showAppSheet<void>(
        context,
        title: '邀请家人加入',
        builder: (sheetContext) => Column(
          children: [
            const Text('该邀请码 72 小时内有效，只能使用一次。分享前请确认收件人。'),
            const SizedBox(height: 14),
            SelectableText(
              code,
              style: Theme.of(context).textTheme.headlineSmall
                  ?.copyWith(letterSpacing: 2),
            ),
            const SizedBox(height: 12),
            PrimaryButton(
              label: '复制邀请码',
              icon: Icons.copy_rounded,
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: code));
                if (sheetContext.mounted) {
                  ScaffoldMessenger.of(sheetContext)
                      .showSnackBar(const SnackBar(content: Text('邀请码已复制')));
                }
              },
            ),
            const SizedBox(height: 8),
            SoftButton(
              label: '分享邀请码',
              icon: Icons.share_outlined,
              onPressed: () => SharePlus.instance.share(
                ShareParams(text: '加入我的家庭药箱，邀请码：$code'),
              ),
            ),
          ],
        ),
      );
    } catch (error) {
      if (mounted) _showError(error);
    }
  }

  Future<void> _editNickname(String? current) async {
    final nickname = await showAppSheet<String?>(
      context,
      title: '我的显示名',
      builder: (_) => _NicknameForm(initial: current),
    );
    if (nickname == null || !mounted) return;
    try {
      await widget.services.families!.updateNickname(nickname);
      setState(
        () => familyFuture = widget.services.families!.getCurrentFamily(),
      );
      _showMessage('显示名已保存');
    } catch (error) {
      _showError(error);
    }
  }

  Future<void> _toggleReminders(bool value) async {
    try {
      if (value) {
        final granted = await widget.services.reminders.enableFor(
          widget.services.medicines!.medicines,
        );
        if (!granted) {
          _showMessage('通知权限未开启。仍可在“待处理”页面查看期限记录。');
          return;
        }
      } else {
        await widget.services.reminders.disable();
      }
      if (mounted) {
        setState(() => reminderEnabled = widget.services.reminders.enabled);
      }
    } catch (error) {
      if (mounted) _showMessage('本地提醒暂不可用：${friendlyApiError(error)}');
    }
  }

  Future<void> _logout() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('退出 App 登录？'),
        content: const Text('这只会撤销当前 App 会话并清除此设备缓存，不会让你退出家庭药箱。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('退出登录'),
          ),
        ],
      ),
    );
    if (confirm != true || !mounted) return;
    // 本机退出必须收口到未登录态：本地提醒关闭或服务端撤销失败都不得阻断跳转（R10）。
    try {
      await widget.services.reminders.disable();
    } catch (_) {
      // 提醒关闭失败不影响退出；下次进入会按服务端状态重新同步开关。
    }
    String? revokeNote;
    try {
      revokeNote = await widget.services.auth!.logout();
    } catch (error) {
      // logout 已保证本机清理与令牌删除，这里只兜底极端异常，仍继续跳转。
      revokeNote = friendlyApiError(error);
    }
    if (!mounted) return;
    if (revokeNote != null) {
      // 用根 ScaffoldMessenger 提示，跨路由仍可见：本机已退出，仅服务端撤销未完成。
      _showMessage('已在本机退出；服务端会话撤销未完成：$revokeNote');
    }
    context.go('/connect');
  }

  void _showMessage(String message) {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  void _showError(Object error) => _showMessage(friendlyApiError(error));

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('我的')),
    body: FutureBuilder<FamilyRecord>(
      future: familyFuture,
      builder: (context, snapshot) {
        final family = snapshot.data;
        return ListView(
          padding: const EdgeInsets.fromLTRB(18, 8, 18, 24),
          children: [
            AppCard(
              color: const Color(0xFFE9F1EB),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    family?.name ?? '家庭药箱',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 4),
                  Text(family?.role == 'owner' ? '管理员' : '家庭成员'),
                  const SizedBox(height: 10),
                  if (family == null && snapshot.hasError)
                    Text(friendlyApiError(snapshot.error!))
                  else if (snapshot.connectionState != ConnectionState.done)
                    const LinearProgressIndicator()
                  else
                    ...family!.members.map(
                      (member) => ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Icon(
                          member.role == 'owner'
                              ? Icons.admin_panel_settings_outlined
                              : Icons.person_outline,
                        ),
                        title: Text(
                          '${member.role == 'owner' ? '管理员' : '成员'}：${member.displayName}${member.isSelf ? '（我）' : ''}',
                        ),
                        subtitle: Text('加入时间：${_formatDate(member.joinedAt)}'),
                      ),
                    ),
                  if (family?.role == 'owner') ...[
                    const SizedBox(height: 6),
                    PrimaryButton(
                      label: '生成邀请',
                      icon: Icons.person_add_alt_1_rounded,
                      onPressed: _createInvite,
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 12),
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          '我的显示名',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                      ),
                      TextButton(
                        onPressed: () => _editNickname(null),
                        child: const Text('编辑'),
                      ),
                    ],
                  ),
                  const Text('设置家人容易识别的称呼，仅用于家庭成员列表。'),
                  const SizedBox(height: 8),
                  TextButton.icon(
                    onPressed: () => _editNickname(null),
                    icon: const Icon(Icons.edit_outlined),
                    label: const Text('修改显示名'),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Android 本地提醒',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 4),
                  const Text(
                    '根据上次同步库存，在本机安排 30 / 7 / 1 / 0 天的期限提醒。离线修改未同步时，提醒可能基于旧数据。',
                  ),
                  SwitchListTile.adaptive(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('开启本地通知'),
                    value: reminderEnabled,
                    onChanged: _toggleReminders,
                  ),
                  if (!reminderEnabled)
                    const Text(
                      '关闭通知权限时，待处理列表仍可查看。',
                      style: TextStyle(color: AppColors.muted),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '微信订阅提醒',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 5),
                  _wechatTemplateMessage(),
                  const SizedBox(height: 10),
                  SoftButton(
                    label: '刷新模板状态',
                    icon: Icons.refresh_rounded,
                    onPressed: _loadWechatTemplates,
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    '微信授权需要在小程序内由用户主动确认。App 不会替你请求微信订阅权限。',
                    style: TextStyle(color: AppColors.muted),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            AppCard(
              child: Column(
                children: [
                  ListTile(
                    leading: const Icon(Icons.ios_share_rounded),
                    title: const Text('导出 Markdown / CSV / PDF'),
                    onTap: () => context.push('/export'),
                  ),
                  ListTile(
                    leading: const Icon(Icons.backup_outlined),
                    title: const Text('JSON 备份与恢复'),
                    onTap: () => context.push('/export?section=backup'),
                  ),
                  ListTile(
                    leading: const Icon(Icons.delete_outline_rounded),
                    title: const Text('回收站'),
                    onTap: () => context.push('/trash'),
                  ),
                  ListTile(
                    leading: const Icon(Icons.history_rounded),
                    title: const Text('家庭变更记录'),
                    onTap: () => context.push('/audit'),
                  ),
                  ListTile(
                    leading: const Icon(Icons.system_update_alt_rounded),
                    title: const Text('版本与更新'),
                    subtitle: Text('当前版本 $appVersion'),
                    onTap: () => context.push('/release-notes'),
                  ),
                  ListTile(
                    leading: const Icon(Icons.article_outlined),
                    title: const Text('开源许可'),
                    onTap: () => showLicensePage(
                      context: context,
                      applicationName: '家庭药箱',
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            AppCard(
              child: Column(
                children: [
                  const Text('个人剂量备注默认仅本人可见。主动分享家庭库存时请检查导出选项。'),
                  const SizedBox(height: 12),
                  SoftButton(
                    label: '退出 App 登录',
                    icon: Icons.logout_rounded,
                    onPressed: _logout,
                  ),
                ],
              ),
            ),
          ],
        );
      },
    ),
  );

  Widget _wechatTemplateMessage() {
    if (loadingWechat) return const Text('正在查询模板状态…');
    if (wechatTemplates == null) return const Text('暂时无法读取模板状态，请稍后重试。');
    final reason = wechatTemplates?['reason'] as String?;
    if (wechatTemplates?['available'] != true) {
      return Text('BLOCKED_PLATFORM · ${reason ?? '当前 AppID 暂无可用提醒模板。'}');
    }
    final templates = wechatTemplates?['templates'];
    if (templates is List && templates.isEmpty) {
      return Text('BLOCKED_PLATFORM · ${reason ?? '没有已配置的有效模板。'}');
    }
    return const Text('服务端已配置模板候选。请在小程序内主动授权；真实送达仍需在微信平台实测。');
  }
}

class _NicknameForm extends StatefulWidget {
  const _NicknameForm({required this.initial});
  final String? initial;
  @override
  State<_NicknameForm> createState() => _NicknameFormState();
}

class _NicknameFormState extends State<_NicknameForm> {
  late final controller = TextEditingController(text: widget.initial ?? '');
  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Column(
    children: [
      TextField(
        controller: controller,
        maxLength: 40,
        decoration: const InputDecoration(hintText: '例如：爸爸'),
      ),
      const SizedBox(height: 10),
      PrimaryButton(
        label: '保存显示名',
        onPressed: () => Navigator.pop(context, controller.text.trim()),
      ),
    ],
  );
}

String _formatDate(String value) =>
    value.length >= 10 ? value.substring(0, 10) : value;
