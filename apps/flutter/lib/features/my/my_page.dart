import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart'
    show Icons, ScaffoldMessenger, SnackBar, SelectableText, showLicensePage;
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/theme/app_typography.dart';
import '../../core/theme/font_scale.dart';
import '../../core/widgets/apple_screen.dart';
import '../../core/widgets/apple_list_row.dart';
import '../../core/widgets/app_surfaces.dart';
import '../../data/api_client.dart';
import '../../data/app_services.dart';
import '../../models/medicine_models.dart';
import '../medicine/archived_medicines_page.dart';
import 'release_notes_page.dart';

/// 我的（苹果风）：inset grouped 分组列表，参照 iOS 系统设置。
/// 交互弹层暂用既有 AppSheet（过渡期），分组与行为全部对齐 DESIGN.md。
class MyPage extends StatefulWidget {
  const MyPage({
    super.key,
    required this.services,
    this.familyManagementRequest = 0,
  });
  final AppServices services;
  final int familyManagementRequest;
  @override
  State<MyPage> createState() => _MyPageState();
}

class _MyPageState extends State<MyPage> {
  final _scrollController = ScrollController();
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

  @override
  void didUpdateWidget(covariant MyPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.familyManagementRequest != widget.familyManagementRequest) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_scrollController.hasClients) return;
        if (MediaQuery.disableAnimationsOf(context)) {
          _scrollController.jumpTo(0);
        } else {
          _scrollController.animateTo(
            0,
            duration: const Duration(milliseconds: 220),
            curve: Curves.easeOut,
          );
        }
      });
    }
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
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

  Future<void> _chooseFontScale() async {
    final controller = widget.services.fontScale;
    if (controller == null) return;
    await showCupertinoModalPopup<void>(
      context: context,
      builder: (popupContext) => DefaultTextStyle(
        style: CupertinoTheme.of(popupContext).textTheme.textStyle,
        child: Container(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(popupContext).height * 0.8,
          ),
          color: CupertinoColors.systemBackground.resolveFrom(popupContext),
          child: SafeArea(
            child: Column(
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    CupertinoButton(
                      onPressed: () => Navigator.of(popupContext).pop(),
                      child: const Text('完成'),
                    ),
                  ],
                ),
                Flexible(
                  child: SingleChildScrollView(
                    child: CupertinoListSection.insetGrouped(
                      header: const Text('预览与选择 · 全局生效'),
                      children: [
                        for (final option in FontScaleSetting.values)
                          AppleListRow(
                            title: Text(
                              option == FontScaleSetting.small
                                  ? '小 · 适合信息密度优先'
                                  : option == FontScaleSetting.large
                                  ? '大 · 适老友好'
                                  : '标准 · 推荐档',
                              style: AppType.body.copyWith(
                                fontSize:
                                    AppType.body.fontSize! * option.factorValue,
                              ),
                            ),
                            trailing: controller.setting == option
                                ? const Icon(CupertinoIcons.check_mark)
                                : null,
                            onTap: () {
                              controller.set(option);
                              if (popupContext.mounted) {
                                Navigator.of(popupContext).pop();
                              }
                            },
                          ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
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
          controller: _scrollController,
          padding: EdgeInsets.only(
            bottom: MediaQuery.paddingOf(context).bottom + 84,
          ),
          children: [
            CupertinoListSection.insetGrouped(
              header: const Text('家庭'),
              children: [
                if (family != null)
                  AppleListRow(
                    title: Text(family.name),
                    additionalInfo: Text(
                      '${_roleLabel(family.role)} · ${family.members.length} 位成员',
                    ),
                  ),
                AppleListRow(
                  leading: const Icon(CupertinoIcons.person_2),
                  title: const Text('切换、创建或加入家庭'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => context.push('/family-choice'),
                ),
                AppleListRow(
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
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      friendlyApiError(snapshot.error!),
                      style: AppType.footnote.copyWith(
                        color: CupertinoColors.systemRed.resolveFrom(context),
                      ),
                    ),
                    CupertinoButton(
                      minimumSize: const Size(48, 48),
                      padding: EdgeInsets.zero,
                      onPressed: () => setState(() {
                        familyFuture = widget.services.families!
                            .getCurrentFamily();
                      }),
                      child: const Text('重新加载家庭'),
                    ),
                  ],
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
                    AppleListRow(
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
                    AppleListRow(
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
                AppleListRow(
                  leading: const Icon(CupertinoIcons.person_badge_plus),
                  title: const Text('用药的人'),
                  subtitle: const Text('照护对象与权限'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => context.push('/care-profiles'),
                ),
                AppleListRow(
                  leading: const Icon(CupertinoIcons.cart),
                  title: const Text('补货清单'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => context.push('/restock'),
                ),
                AppleListRow(
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
                AppleListRow(
                  leading: const Icon(CupertinoIcons.bell),
                  title: const Text('Android 本地通知'),
                  subtitle: const Text('30 / 7 / 1 / 0 天期限提醒，基于上次同步库存'),
                  trailing: CupertinoSwitch(
                    value: reminderEnabled,
                    onChanged: savingReminder ? null : _toggleReminders,
                  ),
                ),
                AppleListRow(
                  leading: const Icon(CupertinoIcons.clock),
                  title: const Text('库存提醒时间'),
                  additionalInfo: Text('$reminderTime · 上海时间'),
                  onTap: _chooseReminderTime,
                ),
                AppleListRow(
                  leading: const Icon(CupertinoIcons.paperplane),
                  title: const Text('微信订阅提醒'),
                  subtitle: Text(_wechatTemplateMessage()),
                  trailing: CupertinoButton(
                    padding: EdgeInsets.zero,
                    minimumSize: const Size(48, 48),
                    onPressed: loadingWechat ? null : _loadWechatTemplates,
                    child: const Icon(CupertinoIcons.arrow_clockwise, size: 18),
                  ),
                ),
              ],
            ),
            CupertinoListSection.insetGrouped(
              header: const Text('数据管理'),
              children: [
                AppleListRow(
                  leading: const Icon(CupertinoIcons.share),
                  title: const Text('导出清单'),
                  subtitle: const Text('Markdown / CSV / PDF'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => context.push('/export'),
                ),
                AppleListRow(
                  leading: const Icon(CupertinoIcons.archivebox),
                  title: const Text('备份与恢复'),
                  subtitle: const Text('JSON 保存与恢复'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => context.push('/export?section=backup'),
                ),
                AppleListRow(
                  leading: const Icon(CupertinoIcons.archivebox),
                  title: const Text('已归档药品'),
                  subtitle: const Text('查看已归档的药品与批次摘要'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => Navigator.of(context).push(
                    CupertinoPageRoute<void>(
                      builder: (_) => ArchivedMedicinesPage(
                        workflow: widget.services.workflow!,
                      ),
                    ),
                  ),
                ),
                AppleListRow(
                  leading: const Icon(CupertinoIcons.trash),
                  title: const Text('最近删除'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => context.push('/trash'),
                ),
                AppleListRow(
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
                AppleListRow(
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
                    if (!devicesExpanded &&
                        devices.isEmpty &&
                        devicesError == null) {
                      _loadDevices();
                    }
                    setState(() => devicesExpanded = !devicesExpanded);
                  },
                ),
                if (devicesExpanded) ...[
                  if (devicesLoading)
                    const AppleListRow(
                      title: Center(child: CupertinoActivityIndicator()),
                    ),
                  if (devicesError != null)
                    AppleListRow(title: Text(devicesError!)),
                  if (devices.isEmpty &&
                      !devicesLoading &&
                      devicesError == null)
                    const AppleListRow(title: Text('暂无其他设备记录')),
                  for (final device in devices)
                    AppleListRow(
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
                      trailing:
                          device['clientKind'] == 'android' &&
                              device['isCurrent'] != true
                          ? CupertinoButton(
                              padding: EdgeInsets.zero,
                              minimumSize: const Size(48, 48),
                              onPressed: revokingDeviceId == null
                                  ? () => _revokeDevice(device)
                                  : null,
                              child: Text(
                                '撤销授权',
                                style: AppType.subhead.copyWith(
                                  color: CupertinoColors.systemRed.resolveFrom(
                                    context,
                                  ),
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
                AppleListRow(
                  leading: const Icon(CupertinoIcons.person),
                  title: const Text('账号设置'),
                  subtitle: const Text('修改显示名'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => _editNickname(null),
                ),
                AppleListRow(
                  leading: const Icon(CupertinoIcons.textformat_size),
                  title: const Text('字体大小'),
                  additionalInfo: Text(
                    widget.services.fontScale?.label ?? '标准',
                  ),
                  trailing: const CupertinoListTileChevron(),
                  onTap: _chooseFontScale,
                ),
                AppleListRow(
                  leading: const Icon(CupertinoIcons.info),
                  title: const Text('版本与更新'),
                  subtitle: Text('当前版本 $appVersion'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => context.push('/release-notes'),
                ),
                AppleListRow(
                  leading: const Icon(CupertinoIcons.doc_text),
                  title: const Text('开源许可'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => showLicensePage(
                    context: context,
                    applicationName: '家庭药箱',
                  ),
                ),
                AppleListRow(
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
              padding: const EdgeInsets.symmetric(horizontal: 16),
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
