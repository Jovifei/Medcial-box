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
  final familyController = ExpansibleController();
  final reminderController = ExpansibleController();
  final familyKey = GlobalKey();
  final reminderKey = GlobalKey();
  List<Map<String, dynamic>> devices = [];
  String? devicesError;
  bool devicesLoading = false;
  String? revokingDeviceId;

  bool reminderEnabled = false;
  bool loadingWechat = false;
  bool savingReminder = false;
  String reminderTime = '09:00';
  List<String> reminderChannels = [];
  Map<String, dynamic>? wechatTemplates;

  @override
  void initState() {
    super.initState();
    familyFuture = widget.services.families!.getCurrentFamily();
    _restoreReminderState();
    _loadWechatTemplates();
  }

  void _expandSection(ExpansibleController controller, GlobalKey key) {
    controller.expand();
    if (key.currentContext != null) {
      Scrollable.ensureVisible(key.currentContext!);
    }
  }

  Future<void> _loadDevices() async {
    final epoch = widget.services.api!.identityEpoch;
    setState(() {
      devicesLoading = true;
      devicesError = null;
    });
    try {
      final result = await widget.services.auth!.listDevices();
      if (mounted && epoch == widget.services.api!.identityEpoch) {
        setState(() => devices = result);
      }
    } catch (error) {
      if (mounted && epoch == widget.services.api!.identityEpoch) {
        setState(() {
          devices = [];
          devicesError = friendlyApiError(error);
        });
      }
    } finally {
      if (mounted && epoch == widget.services.api!.identityEpoch) {
        setState(() => devicesLoading = false);
      }
    }
  }

  Future<void> _revokeDevice(Map<String, dynamic> device) async {
    if (revokingDeviceId != null ||
        device['isCurrent'] == true ||
        device['clientKind'] != 'android') {
      return;
    }
    final epoch = widget.services.api!.identityEpoch;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('撤销 Android App 授权？'),
        content: const Text('该设备需要重新连接，才能访问家庭数据。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('撤销'),
          ),
        ],
      ),
    );
    if (confirmed != true ||
        !mounted ||
        epoch != widget.services.api!.identityEpoch) {
      return;
    }
    if (revokingDeviceId != null) return;
    setState(() => revokingDeviceId = device['id'] as String);
    try {
      await widget.services.auth!.revokeDevice(device['id'] as String);
      if (mounted && epoch == widget.services.api!.identityEpoch) {
        await _loadDevices();
      }
    } catch (error) {
      if (mounted && epoch == widget.services.api!.identityEpoch) {
        _showError(error);
      }
    } finally {
      if (mounted && epoch == widget.services.api!.identityEpoch) {
        setState(() => revokingDeviceId = null);
      }
    }
  }

  @override
  void dispose() {
    familyController.dispose();
    reminderController.dispose();
    super.dispose();
  }

  Future<void> _restoreReminderState() async {
    try {
      final prefs = await widget.services.workflow!.notificationPreferences();
      reminderTime = prefs['stockReminderTime'] as String? ?? '09:00';
      reminderChannels = (prefs['channels'] as List<dynamic>? ?? [])
          .cast<String>();
      widget.services.reminders.stockReminderTime = reminderTime;
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
    if (savingReminder) return;
    setState(() => savingReminder = true);
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
      final channels = {...reminderChannels};
      if (value) {
        channels.add('android');
      } else {
        channels.remove('android');
      }
      await widget.services.workflow!.updateNotificationPreferences(
        stockReminderTime: reminderTime,
        channels: channels.toList(),
      );
      reminderChannels = channels.toList();
      await widget.services.plans!.onChanged?.call();
      if (mounted) {
        setState(() => reminderEnabled = widget.services.reminders.enabled);
      }
    } catch (error) {
      if (value) await widget.services.reminders.disable();
      if (mounted) {
        setState(() => reminderEnabled = widget.services.reminders.enabled);
        _showMessage('本地提醒暂不可用：${friendlyApiError(error)}');
      }
    } finally {
      if (mounted) setState(() => savingReminder = false);
    }
  }

  Future<void> _chooseReminderTime() async {
    final parts = reminderTime.split(':');
    final picked = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(
        hour: int.parse(parts[0]),
        minute: int.parse(parts[1]),
      ),
    );
    if (picked == null || !mounted) return;
    final next =
        '${picked.hour.toString().padLeft(2, '0')}:${picked.minute.toString().padLeft(2, '0')}';
    try {
      await widget.services.workflow!.updateNotificationPreferences(
        stockReminderTime: next,
        channels: reminderChannels,
      );
      widget.services.reminders.stockReminderTime = next;
      await widget.services.plans!.onChanged?.call();
      if (mounted) setState(() => reminderTime = next);
    } catch (error) {
      if (mounted) _showError(error);
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
                    ExpansionTile(
                      tilePadding: EdgeInsets.zero,
                      key: familyKey,
                      controller: familyController,
                      title: const Text('我的家庭'),
                      subtitle: Text('${family!.members.length} 位家庭成员'),
                      children: family.members
                          .map(
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
                              subtitle: Text(
                                '加入时间：${_formatDate(member.joinedAt)}',
                              ),
                            ),
                          )
                          .toList(),
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
            const SizedBox(height: 16),
            Text('常用入口', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 10),
            _EntryGrid(
              children: [
                _EntryTile(
                  title: '我的家庭',
                  hint: '成员与角色',
                  icon: Icons.home_outlined,
                  onTap: () => _expandSection(familyController, familyKey),
                ),
                _EntryTile(
                  title: '照护对象',
                  hint: '本人、孩子与老人',
                  icon: Icons.people_outline,
                  onTap: () => context.push('/care-profiles'),
                ),
                _EntryTile(
                  title: '提醒设置',
                  hint: '本地通知与时间',
                  icon: Icons.notifications_outlined,
                  onTap: () => _expandSection(reminderController, reminderKey),
                ),
                _EntryTile(
                  title: '补货清单',
                  hint: '需要补充的库存',
                  icon: Icons.shopping_bag_outlined,
                  onTap: () => context.push('/restock'),
                ),
              ],
            ),
            const SizedBox(height: 12),
            AppCard(
              child: ExpansionTile(
                tilePadding: EdgeInsets.zero,
                key: reminderKey,
                controller: reminderController,
                title: const Text('Android 本地提醒'),
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
                    onChanged: savingReminder ? null : _toggleReminders,
                  ),
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.schedule_rounded),
                    title: const Text('库存提醒时间'),
                    subtitle: Text('$reminderTime · 上海时间'),
                    onTap: _chooseReminderTime,
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
              child: ExpansionTile(
                tilePadding: EdgeInsets.zero,
                title: const Text('微信订阅提醒'),
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
            Text('数据管理', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 10),
            _EntryGrid(
              children: [
                _EntryTile(
                  title: '导出清单',
                  hint: 'Markdown / CSV / PDF',
                  icon: Icons.ios_share_rounded,
                  onTap: () => context.push('/export'),
                ),
                _EntryTile(
                  title: '备份与恢复',
                  hint: 'JSON 保存与恢复',
                  icon: Icons.backup_outlined,
                  onTap: () => context.push('/export?section=backup'),
                ),
                _EntryTile(
                  title: '最近删除',
                  hint: '恢复药品与批次',
                  icon: Icons.delete_outline_rounded,
                  onTap: () => context.push('/trash'),
                ),
                _EntryTile(
                  title: '变更记录',
                  hint: '查看家庭修改',
                  icon: Icons.history_rounded,
                  onTap: () => context.push('/audit'),
                ),
              ],
            ),
            const SizedBox(height: 16),
            AppCard(
              child: ExpansionTile(
                tilePadding: EdgeInsets.zero,
                title: const Text('已登录设备'),
                onExpansionChanged: (expanded) {
                  if (expanded) _loadDevices();
                },
                children: [
                  if (devicesLoading) const LinearProgressIndicator(),
                  if (devicesError != null) Text(devicesError!),
                  ...devices.map(
                    (device) => ListTile(
                      title: Text(
                        '${device['clientKind'] == 'android' ? 'Android App' : '微信小程序'}${device['isCurrent'] == true ? ' · 当前设备' : ''}',
                      ),
                      subtitle: Text(
                        device['isCurrent'] == true
                            ? '当前会话请通过退出登录撤销。'
                            : device['clientKind'] == 'android'
                            ? '可撤销此设备的授权'
                            : '微信会话请在对应设备退出。',
                      ),
                      trailing:
                          device['clientKind'] == 'android' &&
                              device['isCurrent'] != true
                          ? TextButton(
                              onPressed: () => _revokeDevice(device),
                              child: const Text('撤销授权'),
                            )
                          : null,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            Text('其他设置', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 10),
            AppCard(
              child: Column(
                children: [
                  ListTile(
                    leading: const Icon(Icons.person_outline),
                    title: const Text('账号设置'),
                    subtitle: const Text('修改显示名'),
                    onTap: () => _editNickname(null),
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

class _EntryGrid extends StatelessWidget {
  const _EntryGrid({required this.children});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final width = (constraints.maxWidth - 12) / 2;
      return Wrap(
        spacing: 12,
        runSpacing: 12,
        children: children
            .map((child) => SizedBox(width: width, child: child))
            .toList(),
      );
    },
  );
}

class _EntryTile extends StatelessWidget {
  const _EntryTile({
    required this.title,
    required this.hint,
    required this.icon,
    required this.onTap,
  });
  final String title;
  final String hint;
  final IconData icon;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Material(
    color: Colors.white,
    borderRadius: BorderRadius.circular(20),
    child: InkWell(
      borderRadius: BorderRadius.circular(20),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, color: AppColors.leaf),
            const SizedBox(height: 12),
            Text(title, style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 4),
            Text(
              hint,
              style: Theme.of(context).textTheme.bodySmall
                  ?.copyWith(color: AppColors.muted),
            ),
          ],
        ),
      ),
    ),
  );
}
