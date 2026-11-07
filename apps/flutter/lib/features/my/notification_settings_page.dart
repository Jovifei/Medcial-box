import 'package:flutter/cupertino.dart';

import '../../core/theme/app_typography.dart';
import '../../core/theme/app_colors.dart';
import '../../core/widgets/apple_screen.dart';
import '../../data/app_services.dart';

/// 提醒与通知设置（对齐小程序 notification-settings）：
/// 库存盘点提醒时间 + 微信/Android 双渠道开关。
class NotificationSettingsPage extends StatefulWidget {
  const NotificationSettingsPage({required this.services, super.key});

  final AppServices services;

  @override
  State<NotificationSettingsPage> createState() =>
      _NotificationSettingsPageState();
}

class _NotificationSettingsPageState extends State<NotificationSettingsPage> {
  bool _loading = true;
  bool _busy = false;
  String _time = '09:00';
  Set<String> _channels = const <String>{};
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
      final prefs = await widget.services.workflow!.notificationPreferences();
      if (!_isCurrent) return;
      setState(() {
        _time = (prefs['stockReminderTime'] as String? ?? '09:00');
        _channels = ((prefs['channels'] as List<dynamic>? ?? const [])
                .whereType<String>())
            .toSet();
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

  Future<void> _save() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await widget.services.workflow!.updateNotificationPreferences(
        stockReminderTime: _time,
        channels: _channels.toList(growable: false),
      );
    } catch (error) {
      if (_isCurrent) await _showAlert('保存失败', '$error');
    } finally {
      if (_isCurrent) setState(() => _busy = false);
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

  Future<void> _pickTime() async {
    var selected = _timeOfDay();
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
    final next =
        '${selected.hour.toString().padLeft(2, '0')}:${selected.minute.toString().padLeft(2, '0')}';
    if (next == _time) return;
    setState(() => _time = next);
    await _save();
  }

  DateTime _timeOfDay() {
    final parts = _time.split(':');
    final now = DateTime.now();
    return DateTime(
      now.year,
      now.month,
      now.day,
      int.tryParse(parts.isNotEmpty ? parts[0] : '') ?? 9,
      int.tryParse(parts.length > 1 ? parts[1] : '') ?? 0,
    );
  }

  Future<void> _toggleChannel(String channel, bool value) async {
    setState(() {
      final next = Set<String>.of(_channels);
      value ? next.add(channel) : next.remove(channel);
      _channels = next;
    });
    await _save();
  }

  @override
  Widget build(BuildContext context) {
    final c = AppSemanticColors.of(View.of(context).platformDispatcher.platformBrightness);
    Widget body;
    if (_loading) {
      body = const Center(child: CupertinoActivityIndicator(radius: 14));
    } else if (_error != null) {
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
            header: Text('提醒时间', style: AppType.footnote.copyWith(color: c.secondaryLabel)),
            children: [
              CupertinoListTile(
                title: Text('库存盘点提醒', style: AppType.body),
                additionalInfo: Text(_time, style: AppType.body.copyWith(color: c.secondaryLabel)),
                onTap: _busy ? null : _pickTime,
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Text(
              '到点提醒你整理药箱库存与效期；时间按北京时间生效。',
              style: AppType.footnote.copyWith(color: c.secondaryLabel),
            ),
          ),
          const SizedBox(height: 8),
          CupertinoListSection.insetGrouped(
            header: Text('提醒渠道', style: AppType.footnote.copyWith(color: c.secondaryLabel)),
            children: [
              CupertinoListTile(
                title: Text('微信订阅消息', style: AppType.body),
                subtitle: Text('需在微信内完成订阅', style: AppType.footnote),
                trailing: CupertinoSwitch(
                  value: _channels.contains('wechat'),
                  onChanged: _busy ? null : (value) => _toggleChannel('wechat', value),
                ),
              ),
              CupertinoListTile(
                title: Text('Android 本地通知', style: AppType.body),
                subtitle: Text('下次打开应用时按新时间重排', style: AppType.footnote),
                trailing: CupertinoSwitch(
                  value: _channels.contains('android'),
                  onChanged: _busy ? null : (value) => _toggleChannel('android', value),
                ),
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Text(
              '两个渠道都关闭后，排队的用药提醒会一并取消。',
              style: AppType.footnote.copyWith(color: c.secondaryLabel),
            ),
          ),
        ],
      );
    }
    return AppleScreen(title: '提醒与通知', child: body);
  }
}
