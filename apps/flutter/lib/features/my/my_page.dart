import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart'
    show Icons, ScaffoldMessenger, SnackBar, SelectableText, showLicensePage;
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/theme/app_typography.dart';
import '../../core/widgets/apple_screen.dart';
import '../../core/widgets/app_surfaces.dart';
import '../../data/api_client.dart';
import '../../data/app_services.dart';
import '../../models/medicine_models.dart';
import 'release_notes_page.dart';

/// 我的（苹果风）：inset grouped 分组列表，参照 iOS 系统设置。
/// 交互弹层暂用既有 AppSheet（过渡期），分组与行为全部对齐 DESIGN.md。
class MyPage extends StatefulWidget {
  const MyPage({super.key, required this.services, this.familyManagementRequest = 0});
  final AppServices services;
  final int familyManagementRequest;
  @override
  State<MyPage> createState() => _MyPageState();
}

class _MyPageState extends State<MyPage> {
  Future<FamilyRecord>? familyFuture;
  List<Map<String, dynamic>> devices = [];
  String? devicesError;
  bool devicesLoading = false;
  String? revokingDeviceId;

  bool reminderEnabled = false;
  bool loadingWechat = false;
  bool savingReminder = false;
  bool devicesExpanded = false;
  String reminderTime = '09:00';
  List<String> reminderChannels = [];
  Map<String, dynamic>? wechatTemplates;

  bool get _isCurrent => mounted;

  @override
  void initState() {
    super.initState();
    familyFuture = widget.services.families!.getCurrentFamily();
    _restoreReminderState();
    _loadWechatTemplates();
  }

  Future<void> _loadDevices() async {
    final epoch = widget.services.api!.identityEpoch;
    setState(() {
      devicesLoading = true;
      devicesError = null;
    });
    try {
      final result = await widget.services.auth!.listDevices();
      if (_isCurrent && epoch == widget.services.api!.identityEpoch) {
        setState(() => devices = result);
      }
    } catch (error) {
      if (_isCurrent && epoch == widget.services.api!.identityEpoch) {
        setState(() {
          devices = [];
          devicesError = friendlyApiError(error);
        });
      }
    } finally {
      if (_isCurrent && epoch == widget.services.api!.identityEpoch) {
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
    final confirmed = await _confirmDialog(
      '撤销 Android App 授权？',
      '该设备需要重新连接，才能访问家庭数据。',
      destructiveLabel: '撤销',
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
              style: AppType.title2.copyWith(letterSpacing: 2),
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
    final now = DateTime.now();
    var selected = DateTime(
      now.year,
      now.month,
      now.day,
      int.tryParse(parts.isNotEmpty ? parts[0] : '') ?? 9,
      int.tryParse(parts.length > 1 ? parts[1] : '') ?? 0,
    );
    await showCupertinoModalPopup<void>(
      context: context,
      builder: (popupContext) => Container(
        height: 280,
        color: CupertinoColors.systemBackground.resolveFrom(popupContext),
        child: SafeArea(
          child: Column(
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  CupertinoButton(
                    onPressed: () => Navigator.of(popupContext).pop(),
                    child: const Text('取消'),
                  ),
                  CupertinoButton(
                    onPressed: () => Navigator.of(popupContext).pop(),
                    child: const Text('完成'),
                  ),
                ],
              ),
              Expanded(
                child: CupertinoDatePicker(
                  mode: CupertinoDatePickerMode.time,
                  use24hFormat: true,
                  minuteInterval: 5,
                  initialDateTime: selected,
                  onDateTimeChanged: (value) => selected = value,
                ),
              ),
            ],
          ),
        ),
      ),
    );
    if (!mounted) return;
    final next =
        '${selected.hour.toString().padLeft(2, '0')}:${selected.minute.toString().padLeft(2, '0')}';
    if (next == reminderTime) return;
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
    final confirm = await _confirmDialog(
      '退出 App 登录？',
      '这只会撤销当前 App 会话并清除此设备缓存，不会让你退出家庭药箱。',
      destructiveLabel: '退出登录',
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

  Future<bool> _confirmDialog(
    String title,
    String content, {
    required String destructiveLabel,
  }) async {
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
            child: Text(destructiveLabel),
          ),
        ],
      ),
    );
    return result ?? false;
  }

  void _showMessage(String message) {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  void _showError(Object error) => _showMessage(friendlyApiError(error));

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

  @override
  Widget build(BuildContext context) => AppleScreen(
    title: '我的',
    safeAreaBottom: false,
    child: FutureBuilder<FamilyRecord>(
      future: familyFuture,
      builder: (context, snapshot) {
        final family = snapshot.data;
        return ListView(
          padding: EdgeInsets.only(
            bottom: MediaQuery.paddingOf(context).bottom + 84,
          ),
          children: [
            CupertinoListSection.insetGrouped(
              header: const Text('家庭'),
              children: [
                if (family != null)
                  CupertinoListTile(
                    title: Text(family.name),
                    additionalInfo: Text(
                      '${_roleLabel(family.role)} · ${family.members.length} 位成员',
                    ),
                  ),
                CupertinoListTile(
                  leading: const Icon(CupertinoIcons.person_2),
                  title: const Text('切换、创建或加入家庭'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => context.push('/family-choice'),
                ),
                CupertinoListTile(
                  leading: const Icon(CupertinoIcons.gear_alt),
                  title: const Text('家庭设置'),
                  subtitle: const Text('盘点频率、成员管理、离开家庭'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => context.push('/family-settings'),
                ),
              ],
            ),
            if (snapshot.hasError)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: Text(
                  friendlyApiError(snapshot.error!),
                  style: AppType.footnote
                      .copyWith(color: CupertinoColors.systemRed),
                ),
              )
            else if (snapshot.connectionState != ConnectionState.done)
              const Padding(
                padding: EdgeInsets.all(16),
                child: Center(child: CupertinoActivityIndicator()),
              )
            else if (family != null) ...[
              CupertinoListSection.insetGrouped(
                header: const Text('家庭成员'),
                children: [
                  for (final member in family.members)
                    CupertinoListTile(
                      leading: Icon(
                        member.role == 'owner'
                            ? CupertinoIcons.lock_shield
                            : CupertinoIcons.person,
                      ),
                      title: Text(
                        member.isSelf
                            ? '${member.displayName}（我）'
                            : member.displayName,
                      ),
                      additionalInfo: Text(_roleLabel(member.role)),
                      subtitle: Text('加入于 ${_formatDate(member.joinedAt)}'),
                    ),
                  if (family.role == 'owner')
                    CupertinoListTile(
                      leading: const Icon(CupertinoIcons.person_add),
                      title: const Text('生成邀请码'),
                      subtitle: const Text('72 小时有效，仅可使用一次'),
                      trailing: const CupertinoListTileChevron(),
                      onTap: _createInvite,
                    ),
                ],
              ),
            ],
            CupertinoListSection.insetGrouped(
              header: const Text('药箱工具'),
              children: [
                CupertinoListTile(
                  leading: const Icon(CupertinoIcons.person_badge_plus),
                  title: const Text('用药的人'),
                  subtitle: const Text('照护对象与权限'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => context.push('/care-profiles'),
                ),
                CupertinoListTile(
                  leading: const Icon(CupertinoIcons.cart),
                  title: const Text('补货清单'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => context.push('/restock'),
                ),
                CupertinoListTile(
                  leading: const Icon(CupertinoIcons.list_bullet),
                  title: const Text('药箱盘点与频率'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => context.go('/home?tab=pending'),
                ),
              ],
            ),
            CupertinoListSection.insetGrouped(
              header: const Text('提醒'),
              children: [
                CupertinoListTile(
                  leading: const Icon(CupertinoIcons.bell),
                  title: const Text('Android 本地通知'),
                  subtitle: const Text('30 / 7 / 1 / 0 天期限提醒，基于上次同步库存'),
                  trailing: CupertinoSwitch(
                    value: reminderEnabled,
                    onChanged: savingReminder ? null : _toggleReminders,
                  ),
                ),
                CupertinoListTile(
                  leading: const Icon(CupertinoIcons.clock),
                  title: const Text('库存提醒时间'),
                  additionalInfo: Text('$reminderTime · 上海时间'),
                  onTap: _chooseReminderTime,
                ),
                CupertinoListTile(
                  leading: const Icon(CupertinoIcons.paperplane),
                  title: const Text('微信订阅提醒'),
                  subtitle: Text(_wechatTemplateMessage()),
                  trailing: CupertinoButton(
                    padding: EdgeInsets.zero,
                    minimumSize: Size.zero,
                    onPressed: loadingWechat ? null : _loadWechatTemplates,
                    child: const Icon(CupertinoIcons.arrow_clockwise, size: 18),
                  ),
                ),
              ],
            ),
            CupertinoListSection.insetGrouped(
              header: const Text('数据管理'),
              children: [
                CupertinoListTile(
                  leading: const Icon(CupertinoIcons.share),
                  title: const Text('导出清单'),
                  subtitle: const Text('Markdown / CSV / PDF'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => context.push('/export'),
                ),
                CupertinoListTile(
                  leading: const Icon(CupertinoIcons.archivebox),
                  title: const Text('备份与恢复'),
                  subtitle: const Text('JSON 保存与恢复'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => context.push('/export?section=backup'),
                ),
                CupertinoListTile(
                  leading: const Icon(CupertinoIcons.trash),
                  title: const Text('最近删除'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => context.push('/trash'),
                ),
                CupertinoListTile(
                  leading: const Icon(CupertinoIcons.clock),
                  title: const Text('变更记录'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => context.push('/audit'),
                ),
              ],
            ),
            CupertinoListSection.insetGrouped(
              header: const Text('账号与设备'),
              children: [
                CupertinoListTile(
                  title: const Text('已登录设备'),
                  subtitle: Text(
                    devicesLoading
                        ? '正在加载…'
                        : devicesExpanded
                        ? '${devices.length} 台设备'
                        : '点按查看与撤销授权',
                  ),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () {
                    if (!devicesExpanded && devices.isEmpty && devicesError == null) {
                      _loadDevices();
                    }
                    setState(() => devicesExpanded = !devicesExpanded);
                  },
                ),
                if (devicesExpanded) ...[
                  if (devicesLoading)
                    const CupertinoListTile(
                      title: Center(child: CupertinoActivityIndicator()),
                    ),
                  if (devicesError != null)
                    CupertinoListTile(title: Text(devicesError!)),
                  if (devices.isEmpty && !devicesLoading && devicesError == null)
                    const CupertinoListTile(title: Text('暂无其他设备记录')),
                  for (final device in devices)
                    CupertinoListTile(
                      leading: const Icon(CupertinoIcons.device_phone_portrait),
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
                      trailing: device['clientKind'] == 'android' &&
                              device['isCurrent'] != true
                          ? CupertinoButton(
                              padding: EdgeInsets.zero,
                              minimumSize: Size.zero,
                              onPressed: revokingDeviceId == null
                                  ? () => _revokeDevice(device)
                                  : null,
                              child: Text(
                                '撤销授权',
                                style: AppType.subhead.copyWith(
                                  color: CupertinoColors.systemRed
                                      .resolveFrom(context),
                                ),
                              ),
                            )
                          : null,
                    ),
                ],
              ],
            ),
            CupertinoListSection.insetGrouped(
              header: const Text('账号'),
              children: [
                CupertinoListTile(
                  leading: const Icon(CupertinoIcons.person),
                  title: const Text('账号设置'),
                  subtitle: const Text('修改显示名'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => _editNickname(null),
                ),
                CupertinoListTile(
                  leading: const Icon(CupertinoIcons.info),
                  title: const Text('版本与更新'),
                  subtitle: Text('当前版本 $appVersion'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => context.push('/release-notes'),
                ),
                CupertinoListTile(
                  leading: const Icon(CupertinoIcons.doc_text),
                  title: const Text('开源许可'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => showLicensePage(
                    context: context,
                    applicationName: '家庭药箱',
                  ),
                ),
                CupertinoListTile(
                  leading: const Icon(
                    CupertinoIcons.power,
                    color: CupertinoColors.systemRed,
                  ),
                  title: Text(
                    '退出 App 登录',
                    style: AppType.body.copyWith(
                      color: CupertinoColors.systemRed.resolveFrom(context),
                    ),
                  ),
                  onTap: _logout,
                ),
              ],
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: Text(
                '个人剂量备注默认仅本人可见。主动分享家庭库存时请检查导出选项。',
                style: AppType.footnote.copyWith(
                  color: CupertinoColors.secondaryLabel.resolveFrom(context),
                ),
                textAlign: TextAlign.center,
              ),
            ),
          ],
        );
      },
    ),
  );

  String _wechatTemplateMessage() {
    if (loadingWechat) return '正在查询模板状态…';
    if (wechatTemplates == null) return '暂时无法读取模板状态，请稍后重试。';
    final reason = wechatTemplates?['reason'] as String?;
    if (wechatTemplates?['available'] != true) {
      return 'BLOCKED_PLATFORM · ${reason ?? '当前 AppID 暂无可用提醒模板。'}';
    }
    final templates = wechatTemplates?['templates'];
    if (templates is List && templates.isEmpty) {
      return 'BLOCKED_PLATFORM · ${reason ?? '没有已配置的有效模板。'}';
    }
    return '服务端已配置模板候选。请在小程序内主动授权；真实送达仍需在微信平台实测。';
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
      CupertinoTextField(
        controller: controller,
        maxLength: 40,
        placeholder: '例如：爸爸',
        style: AppType.body.copyWith(
          color: CupertinoColors.label.resolveFrom(context),
        ),
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
