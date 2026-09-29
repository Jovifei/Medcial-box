import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_surfaces.dart';
import '../../data/api_client.dart';
import '../../data/api_workflow_repository.dart';
import '../../data/app_services.dart';
import '../../models/medicine_models.dart';

class PendingPage extends StatefulWidget {
  const PendingPage({super.key, required this.services});
  final AppServices services;
  @override
  State<PendingPage> createState() => _PendingPageState();
}

class _PendingPageState extends State<PendingPage> {
  Future<void>? loadFuture;
  FamilySettingsRecord? settings;
  List<Map<String, dynamic>> restock = const [];
  Map<String, dynamic>? stocktake;
  Object? failure;

  @override
  void initState() {
    super.initState();
    loadFuture = _load();
  }

  Future<void> _load() async {
    try {
      await Future.wait([
        widget.services.medicines!.listMedicines(),
        widget.services.workflow!.getSettings().then((value) => settings = value),
        widget.services.workflow!.listRestockItems().then((value) => restock = value),
        widget.services.workflow!.currentStocktake().then((value) => stocktake = value),
      ]);
      if (mounted) setState(() => failure = null);
    } catch (error) {
      if (mounted) setState(() => failure = error);
    }
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
      final current = stocktake ?? await widget.services.workflow!.startStocktake();
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

  void _error(Object error) => ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(content: Text(friendlyApiError(error))),
  );

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('待处理事项')),
    body: AnimatedBuilder(
      animation: widget.services.medicines!,
      builder: (context, _) => RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 6, 18, 24),
          children: [
            Text('先处理最重要的库存变化', style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 6),
            const Text('提醒只说明需要核对，不代表药品适合服用。'),
            if (failure != null) ...[
              const SizedBox(height: 10),
              AppCard(color: const Color(0xFFFFF2ED), child: Text(friendlyApiError(failure!))),
            ],
            const SizedBox(height: 12),
            _IssueSection(
              title: '已过期 / 开封期限已到',
              color: AppColors.terracotta,
              items: _expired(widget.services.medicines!.medicines),
            ),
            _IssueSection(
              title: '临期',
              color: AppColors.amber,
              items: _expiring(widget.services.medicines!.medicines),
            ),
            _IssueSection(
              title: '库存不足',
              color: AppColors.terracotta,
              items: _low(widget.services.medicines!.medicines),
            ),
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(child: Text('家庭盘点', style: Theme.of(context).textTheme.titleLarge)),
                      TextButton(onPressed: () => _chooseInterval(context), child: Text(_intervalLabel(settings?.stocktakeInterval ?? 'monthly'))),
                    ],
                  ),
                  Text(settings?.nextStocktakeAt == null ? '建议定期核对批次余量' : '下次盘点：${_formatDate(settings!.nextStocktakeAt!)}'),
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
            _RestockSection(
              items: restock,
              onPurchased: (item) => _updateRestock(item, 'purchased'),
              onDismiss: (item) => _updateRestock(item, 'dismissed'),
              onDelete: _deleteRestock,
            ),
            _IssueSection(
              title: '待补充资料',
              color: AppColors.leaf,
              items: _missing(widget.services.medicines!.medicines),
            ),
            AppCard(
              color: const Color(0xFFE9F1EB),
              child: const Text('微信主动提醒需先在已登录的小程序中授权可用模板。授权不可用时，本页仍保留完整待处理清单。'),
            ),
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
          for (final entry in const [('weekly', '每周'), ('monthly', '每月'), ('disabled', '关闭定期盘点')])
            ListTile(
              title: Text(entry.$2),
              trailing: settings?.stocktakeInterval == entry.$1 ? const Icon(Icons.check, color: AppColors.leaf) : null,
              onTap: () => Navigator.pop(sheetContext, entry.$1),
            ),
        ],
      ),
    );
    if (selected != null) _setInterval(selected);
  }
}

class _Issue {
  const _Issue({required this.medicineId, required this.title, required this.detail, required this.batchId});
  final String medicineId;
  final String batchId;
  final String title;
  final String detail;
}

List<_Issue> _expired(List<MedicineRecord> medicines) => [
  for (final medicine in medicines)
    for (final batch in medicine.batches)
      if (batch.dispositionStatus != 'handled' &&
          (batch.isExpired || batch.managementExpiryState.state == 'expired'))
        _Issue(medicineId: medicine.id, batchId: batch.id, title: medicine.name, detail: '批次期限已到：${batch.managementExpiryDate ?? batch.expiryDisplay}'),
];

List<_Issue> _expiring(List<MedicineRecord> medicines) => [
  for (final medicine in medicines)
    for (final batch in medicine.batches)
      if (batch.dispositionStatus != 'handled' &&
          !batch.isExpired && ['due_this_month', 'expiring_soon'].contains(batch.managementExpiryState.state))
        _Issue(medicineId: medicine.id, batchId: batch.id, title: medicine.name, detail: '${batch.managementExpiryState.label.isEmpty ? '即将到期' : batch.managementExpiryState.label}：${batch.managementExpiryDate ?? batch.expiryDisplay}'),
];

List<_Issue> _low(List<MedicineRecord> medicines) => [
  for (final medicine in medicines)
    if (['low', 'exhausted'].contains(medicine.stockStatus))
      _Issue(medicineId: medicine.id, batchId: '', title: medicine.name, detail: medicine.stockStatus == 'exhausted' ? '当前余量为 0' : '当前余量已达到提醒阈值'),
];

List<_Issue> _missing(List<MedicineRecord> medicines) {
  final issues = <_Issue>[];
  for (final medicine in medicines) {
    final activeBatches = medicine.batches.where((batch) => batch.dispositionStatus != 'handled');
    final hasUnknownPackageExpiry = activeBatches.any((batch) => batch.expiryValue == null);
    final hasUnknownOpeningExpiry = activeBatches.any((batch) =>
        batch.openedState == 'opened' &&
        (batch.openedAt == null || batch.openedExpiryDate == null));
    if (hasUnknownPackageExpiry || hasUnknownOpeningExpiry || medicine.leaflet.reviewStatus == 'unverified') {
      issues.add(_Issue(
        medicineId: medicine.id,
        batchId: '',
        title: medicine.name,
        detail: hasUnknownPackageExpiry
            ? '有效期待补充'
            : hasUnknownOpeningExpiry
                ? '开封期限待补充'
                : '药品资料待核对',
      ));
    }
  }
  return issues;
}

class _IssueSection extends StatelessWidget {
  const _IssueSection({required this.title, required this.color, required this.items});
  final String title;
  final Color color;
  final List<_Issue> items;

  @override
  Widget build(BuildContext context) => AppCard(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(children: [Expanded(child: Text(title, style: Theme.of(context).textTheme.titleMedium)), StatusPill(label: '${items.length}', color: color, background: color.withValues(alpha: .1))]),
        if (items.isEmpty)
          const Padding(padding: EdgeInsets.only(top: 8), child: Text('目前没有需要处理的记录。'))
        else
          ...items.take(8).map((item) => ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(item.title),
            subtitle: Text(item.detail),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => context.push('/medicine/${item.medicineId}'),
          )),
      ],
    ),
  );
}

class _RestockSection extends StatelessWidget {
  const _RestockSection({required this.items, required this.onPurchased, required this.onDismiss, required this.onDelete});
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
          const Padding(padding: EdgeInsets.only(top: 8), child: Text('暂时没有待补货药品。'))
        else
          ...items.map((item) {
            final needed = item['status'] == 'needed';
            return ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(item['medicineName'] as String? ?? '药品'),
              subtitle: Text(item['desiredQuantity'] == null ? '数量待确认 · ${_unit(item['unit'] as String?)}' : '目标：${item['desiredQuantity']}${_unit(item['unit'] as String?)}'),
              trailing: needed
                  ? PopupMenuButton<String>(
                      tooltip: '补货操作',
                      onSelected: (action) => action == 'purchased' ? onPurchased(item) : action == 'dismissed' ? onDismiss(item) : onDelete(item),
                      itemBuilder: (_) => const [PopupMenuItem(value: 'purchased', child: Text('已购买')), PopupMenuItem(value: 'dismissed', child: Text('暂不补货')), PopupMenuItem(value: 'delete', child: Text('从清单移除'))],
                    )
                  : Text(item['status'] == 'purchased' ? '已购买' : '已忽略'),
            );
          }),
        if (items.any((item) => item['status'] == 'needed'))
          const Text('标记已购买不会增加库存；收到新药后请通过“新增批次”入库。', style: TextStyle(color: AppColors.muted)),
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

String _formatDate(String value) => value.length >= 10 ? value.substring(0, 10) : value;
