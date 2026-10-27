import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_surfaces.dart';
import '../../data/api_client.dart';
import '../../data/api_workflow_repository.dart';
import '../../data/app_services.dart';

class PendingPage extends StatefulWidget {
  const PendingPage({
    super.key,
    required this.services,
    this.restockOnly = false,
    this.onBack,
  });
  final AppServices services;
  final bool restockOnly;
  final VoidCallback? onBack;
  @override
  State<PendingPage> createState() => _PendingPageState();
}

class _PendingPageState extends State<PendingPage> {
  Future<void>? loadFuture;
  FamilySettingsRecord? settings;
  List<Map<String, dynamic>> restock = const [];
  List<Map<String, dynamic>> pending = const [];
  Map<String, dynamic>? stocktake;
  Object? failure;
  int _loadSequence = 0;

  @override
  void initState() {
    super.initState();
    loadFuture = _load();
  }

  Future<void> _load() async {
    final sequence = ++_loadSequence;
    final api = widget.services.api!;
    final epoch = api.identityEpoch;
    final scope = api.identityState?.scopeSignal.value;
    bool current() =>
        mounted &&
        sequence == _loadSequence &&
        epoch == api.identityEpoch &&
        scope == api.identityState?.scopeSignal.value;
    try {
      if (widget.restockOnly) {
        final items = await widget.services.workflow!.listRestockItems();
        if (!current()) return;
        setState(() {
          restock = items;
          failure = null;
        });
      } else {
        final values = await Future.wait<Object?>([
          widget.services.medicines!.listMedicines(),
          widget.services.workflow!.getSettings(),
          widget.services.workflow!.listRestockItems(),
          widget.services.workflow!.currentStocktake(),
          widget.services.workflow!.pendingNotifications(),
        ]);
        if (!current()) return;
        setState(() {
          settings = values[1] as FamilySettingsRecord;
          restock = values[2] as List<Map<String, dynamic>>;
          stocktake = values[3] as Map<String, dynamic>?;
          pending = values[4] as List<Map<String, dynamic>>;
          failure = null;
        });
      }
    } catch (error) {
      if (current()) setState(() => failure = error);
    }
  }

  @override
  void dispose() {
    _loadSequence++;
    super.dispose();
  }

  Future<void> _setInterval(String value) async {
    try {
      settings = await widget.services.workflow!.updateSettings(
        FamilySettingsRecord(
          stocktakeInterval: value,
          lastStocktakeAt: settings?.lastStocktakeAt,
        ),
      );
      if (mounted) setState(() {});
    } catch (error) {
      if (mounted) _error(error);
    }
  }

  Future<void> _openStocktake() async {
    try {
      final current =
          stocktake ?? await widget.services.workflow!.startStocktake();
      final id = current['id'] as String?;
      if (id != null && mounted) {
        await context.push('/stocktake/$id');
        _load();
      }
    } catch (error) {
      if (mounted) _error(error);
    }
  }

  Future<void> _updateRestock(Map<String, dynamic> item, String status) async {
    try {
      await widget.services.workflow!.updateRestockItem(
        item['id'] as String,
        status: status,
        version: item['version'] is int ? item['version']! as int : 1,
      );
      await _load();
    } catch (error) {
      if (mounted) _error(error);
    }
  }

  Future<void> _deleteRestock(Map<String, dynamic> item) async {
    try {
      await widget.services.workflow!.deleteRestockItem(item['id'] as String);
      await _load();
    } catch (error) {
      if (mounted) _error(error);
    }
  }

  void _error(Object error) =>
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(friendlyApiError(error))));

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      leading: widget.onBack == null
          ? null
          : BackButton(onPressed: widget.onBack),
      title: Text(widget.restockOnly ? '补货清单' : '待处理事项'),
    ),
    body: AnimatedBuilder(
      animation: widget.services.medicines!,
      builder: (context, _) => RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 6, 18, 24),
          children: [
            if (failure != null) ...[
              const SizedBox(height: 10),
              AppCard(
                color: const Color(0xFFFFF2ED),
                child: Text(friendlyApiError(failure!)),
              ),
            ],
            if (!widget.restockOnly) ...[
              Text(
                '先处理最重要的库存变化',
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: 6),
              const Text('提醒只说明需要核对，不代表药品适合服用。'),
              const SizedBox(height: 12),
              _PendingItems(
                items: pending
                    .where((item) => item['type'] != 'leaflet_missing')
                    .toList(),
                onStocktake: _openStocktake,
              ),
              AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            '家庭盘点',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                        ),
                        TextButton(
                          onPressed: () => _chooseInterval(context),
                          child: Text(
                            _intervalLabel(
                              settings?.stocktakeInterval ?? 'monthly',
                            ),
                          ),
                        ),
                      ],
                    ),
                    Text(
                      settings?.nextStocktakeAt == null
                          ? '建议定期核对批次余量'
                          : '下次盘点：${_formatDate(settings!.nextStocktakeAt!)}',
                    ),
                    if (stocktake != null) ...[
                      const SizedBox(height: 4),
                      const Text('有未完成的盘点，可以继续。'),
                    ],
                    const SizedBox(height: 10),
                    PrimaryButton(
                      label: stocktake == null ? '开始盘点' : '继续盘点',
                      icon: Icons.fact_check_outlined,
                      onPressed: _openStocktake,
                    ),
                  ],
                ),
              ),
            ],
            _RestockSection(
              items: restock,
              onPurchased: (item) => _updateRestock(item, 'purchased'),
              onDismiss: (item) => _updateRestock(item, 'dismissed'),
              onDelete: _deleteRestock,
            ),
            if (!widget.restockOnly) ...[
              AppCard(
                child: ExpansionTile(
                  tilePadding: EdgeInsets.zero,
                  title: const Text('资料完善建议'),
                  children: [
                    _PendingItems(
                      items: pending
                          .where((item) => item['type'] == 'leaflet_missing')
                          .toList(),
                      onStocktake: _openStocktake,
                    ),
                  ],
                ),
              ),
              AppCard(
                color: const Color(0xFFE9F1EB),
                child: const Text(
                  '微信主动提醒需先在已登录的小程序中授权可用模板。授权不可用时，本页仍保留完整待处理清单。',
                ),
              ),
            ],
          ],
        ),
      ),
    ),
  );

  Future<void> _chooseInterval(BuildContext context) async {
    final selected = await showAppSheet<String>(
      context,
      title: '盘点频率',
      builder: (sheetContext) => Column(
        children: [
          for (final entry in const [
            ('weekly', '每周'),
            ('monthly', '每月'),
            ('disabled', '关闭定期盘点'),
          ])
            ListTile(
              title: Text(entry.$2),
              trailing: settings?.stocktakeInterval == entry.$1
                  ? const Icon(Icons.check, color: AppColors.leaf)
                  : null,
              onTap: () => Navigator.pop(sheetContext, entry.$1),
            ),
        ],
      ),
    );
    if (selected != null) _setInterval(selected);
  }
}

class _PendingItems extends StatelessWidget {
  const _PendingItems({required this.items, required this.onStocktake});
  final List<Map<String, dynamic>> items;
  final VoidCallback onStocktake;

  @override
  Widget build(BuildContext context) => AppCard(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('需关注的事项', style: Theme.of(context).textTheme.titleMedium),
        if (items.isEmpty)
          const Padding(
            padding: EdgeInsets.only(top: 8),
            child: Text('目前没有需要处理的记录。'),
          )
        else
          for (final item in items)
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(item['medicineName'] as String? ?? '家庭药箱'),
              subtitle: Text(item['message'] as String? ?? '请核对'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () {
                final id = item['medicineId'] as String?;
                if (id == null && item['action'] == 'stocktake') {
                  onStocktake();
                } else if (item['action'] == 'restock') {
                  context.push('/restock');
                } else if (id != null && id.isNotEmpty) {
                  context.push('/medicine/$id');
                }
              },
            ),
      ],
    ),
  );
}

class _RestockSection extends StatelessWidget {
  const _RestockSection({
    required this.items,
    required this.onPurchased,
    required this.onDismiss,
    required this.onDelete,
  });
  final List<Map<String, dynamic>> items;
  final ValueChanged<Map<String, dynamic>> onPurchased;
  final ValueChanged<Map<String, dynamic>> onDismiss;
  final ValueChanged<Map<String, dynamic>> onDelete;

  @override
  Widget build(BuildContext context) => AppCard(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('家庭补货清单', style: Theme.of(context).textTheme.titleLarge),
        if (items.isEmpty)
          const Padding(
            padding: EdgeInsets.only(top: 8),
            child: Text('暂时没有待补货药品。'),
          )
        else
          ...items.map((item) {
            final needed = item['status'] == 'needed';
            return ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(item['medicineName'] as String? ?? '药品'),
              subtitle: Text(
                item['desiredQuantity'] == null
                    ? '数量待确认 · ${_unit(item['unit'] as String?)}'
                    : '目标：${item['desiredQuantity']}${_unit(item['unit'] as String?)}',
              ),
              trailing: needed
                  ? PopupMenuButton<String>(
                      tooltip: '补货操作',
                      onSelected: (action) => action == 'purchased'
                          ? onPurchased(item)
                          : action == 'dismissed'
                          ? onDismiss(item)
                          : onDelete(item),
                      itemBuilder: (_) => const [
                        PopupMenuItem(value: 'purchased', child: Text('已购买')),
                        PopupMenuItem(value: 'dismissed', child: Text('暂不补货')),
                        PopupMenuItem(value: 'delete', child: Text('从清单移除')),
                      ],
                    )
                  : Text(item['status'] == 'purchased' ? '已购买' : '已忽略'),
            );
          }),
        if (items.any((item) => item['status'] == 'needed'))
          const Text(
            '标记已购买不会增加库存；收到新药后请通过“新增批次”入库。',
            style: TextStyle(color: AppColors.muted),
          ),
      ],
    ),
  );
}

String _unit(String? unit) => switch (unit) {
  'tablet' => '片',
  'capsule' => '粒',
  'sachet' => '袋',
  'bottle' => '瓶',
  'box' => '盒',
  _ => '份',
};

String _intervalLabel(String interval) => switch (interval) {
  'weekly' => '每周',
  'disabled' => '已关闭',
  _ => '每月',
};

String _formatDate(String value) =>
    value.length >= 10 ? value.substring(0, 10) : value;
