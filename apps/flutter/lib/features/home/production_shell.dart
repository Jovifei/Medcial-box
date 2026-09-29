import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_surfaces.dart';
import '../../data/api_auth_repository.dart';
import '../../data/api_client.dart';
import '../../data/api_medicine_repository.dart';
import '../../data/app_services.dart';
import '../../models/medicine_models.dart';
import '../my/my_page.dart';
import '../pending/pending_page.dart';

class ProductionShell extends StatefulWidget {
  const ProductionShell({super.key, required this.services, this.initialTab = 0});
  final AppServices services;
  final int initialTab;

  @override
  State<ProductionShell> createState() => _ProductionShellState();
}

class _ProductionShellState extends State<ProductionShell> {
  int selectedIndex = 0;

  @override
  void initState() {
    super.initState();
    selectedIndex = widget.initialTab.clamp(0, 2).toInt();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: IndexedStack(
      index: selectedIndex,
      children: [
        CabinetHomePage(
          repository: widget.services.medicines!,
          familyRepository: widget.services.families!,
        ),
        PendingPage(
          services: widget.services,
        ),
        MyPage(
          services: widget.services,
        ),
      ],
    ),
    bottomNavigationBar: NavigationBar(
      selectedIndex: selectedIndex,
      onDestinationSelected: (index) => setState(() => selectedIndex = index),
      destinations: const [
        NavigationDestination(icon: Icon(Icons.inventory_2_outlined), selectedIcon: Icon(Icons.inventory_2), label: '药箱'),
        NavigationDestination(icon: Icon(Icons.notifications_none_rounded), selectedIcon: Icon(Icons.notifications_rounded), label: '待处理'),
        NavigationDestination(icon: Icon(Icons.person_outline_rounded), selectedIcon: Icon(Icons.person_rounded), label: '我的'),
      ],
    ),
  );
}

class CabinetHomePage extends StatefulWidget {
  const CabinetHomePage({
    super.key,
    required this.repository,
    required this.familyRepository,
  });
  final ApiMedicineRepository repository;
  final ApiFamilyRepository familyRepository;

  @override
  State<CabinetHomePage> createState() => _CabinetHomePageState();
}

enum MedicineFilter { all, expiry, lowStock, missingInfo }

class _CabinetHomePageState extends State<CabinetHomePage> {
  final searchController = TextEditingController();
  String keyword = '';
  MedicineFilter filter = MedicineFilter.all;
  Future<void>? initialLoad;
  FamilyRecord? family;
  Object? failure;

  @override
  void initState() {
    super.initState();
    initialLoad = _load();
  }

  @override
  void dispose() {
    searchController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      await Future.wait([
        widget.repository.listMedicines(),
        widget.familyRepository.getCurrentFamily().then((value) => family = value),
      ]);
      if (mounted) setState(() => failure = null);
    } catch (error) {
      if (mounted) setState(() => failure = error);
    }
  }

  List<MedicineRecord> get _visibleMedicines => widget.repository.medicines.where((medicine) {
    final query = keyword.toLowerCase();
    final matchesQuery = query.isEmpty || [
      medicine.name,
      medicine.specification ?? '',
      medicine.manufacturer ?? '',
      medicine.purpose,
      ...medicine.activeIngredients,
      ...medicine.batches.map((batch) => batch.storageLocation ?? ''),
    ].any((value) => value.toLowerCase().contains(query));
    if (!matchesQuery) return false;
    return switch (filter) {
      MedicineFilter.all => true,
      MedicineFilter.expiry => medicine.batches.any((batch) => batch.isExpired || ['due_this_month', 'expiring_soon'].contains(batch.managementExpiryState.state)),
      MedicineFilter.lowStock => ['low', 'exhausted', 'unknown'].contains(medicine.stockStatus),
      MedicineFilter.missingInfo => medicine.batches.any((batch) => batch.expiryValue == null) || medicine.leaflet.reviewStatus == 'unverified',
    };
  }).toList(growable: false);

  int get _expiringCount => widget.repository.medicines.where((medicine) =>
      medicine.batches.any((batch) => batch.isExpired || ['due_this_month', 'expiring_soon'].contains(batch.managementExpiryState.state))).length;
  int get _lowCount => widget.repository.medicines.where((medicine) => ['low', 'exhausted'].contains(medicine.stockStatus)).length;
  int get _missingCount => widget.repository.medicines.where((medicine) => medicine.batches.any((batch) => batch.expiryValue == null) || medicine.leaflet.reviewStatus == 'unverified').length;

  Future<void> _refresh() async {
    await _load();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: GestureDetector(
        onTap: () => setState(() => filter = MedicineFilter.all),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('家庭药箱'),
            Text(
              family?.name ?? '同步家庭库存',
              style: const TextStyle(fontSize: 12, color: AppColors.muted),
            ),
          ],
        ),
      ),
      actions: [
        IconButton(
          tooltip: '导出和备份',
          onPressed: () => context.push('/export'),
          icon: const Icon(Icons.ios_share_rounded),
        ),
      ],
    ),
    floatingActionButton: FloatingActionButton.extended(
      onPressed: () => context.push('/medicine/new'),
      icon: const Icon(Icons.add_rounded),
      label: const Text('录入'),
    ),
    body: AnimatedBuilder(
      animation: widget.repository,
      builder: (context, _) => RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 96),
          children: [
            Text('家里的药，心里有数。', style: Theme.of(context).textTheme.headlineMedium),
            const SizedBox(height: 5),
            const Text('库存记录不代表适合服用，请按说明书或医护人员指导。'),
            const SizedBox(height: 14),
            if (widget.repository.isOffline)
              _ConnectionBanner(
                text: widget.repository.lastSyncedAt == null
                    ? '离线查看 · 显示本机缓存，修改不会自动上传'
                    : '离线查看 · 最近同步 ${_formatLastSync(widget.repository.lastSyncedAt!)} · 修改不会自动上传',
              ),
            if (failure != null && widget.repository.medicines.isEmpty)
              AppCard(
                color: const Color(0xFFFFF2ED),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(friendlyApiError(failure!), style: Theme.of(context).textTheme.bodyMedium),
                    const SizedBox(height: 10),
                    SoftButton(label: '重新加载', onPressed: _refresh),
                  ],
                ),
              ),
            _QuickStatus(
              expiring: _expiringCount,
              low: _lowCount,
              missing: _missingCount,
              onTap: (value) => setState(() => filter = value),
            ),
            const SizedBox(height: 14),
            TextField(
              controller: searchController,
              onChanged: (value) => setState(() => keyword = value.trim()),
              decoration: InputDecoration(
                prefixIcon: const Icon(Icons.search_rounded),
                hintText: '搜索药名、规格、厂家、成分、位置',
                suffixIcon: keyword.isEmpty
                    ? null
                    : IconButton(
                        tooltip: '清除搜索',
                        onPressed: () {
                          searchController.clear();
                          setState(() => keyword = '');
                        },
                        icon: const Icon(Icons.close_rounded),
                      ),
              ),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              children: [
                _filterChip('全部', MedicineFilter.all),
                _filterChip('临期/过期', MedicineFilter.expiry),
                _filterChip('库存不足', MedicineFilter.lowStock),
                _filterChip('待补资料', MedicineFilter.missingInfo),
              ],
            ),
            const SizedBox(height: 12),
            if (widget.repository.medicines.isEmpty && failure == null)
              _EmptyCabinet(onAdd: () => context.push('/medicine/new'))
            else if (_visibleMedicines.isEmpty)
              _NoSearchResults(onClear: () {
                searchController.clear();
                setState(() { keyword = ''; filter = MedicineFilter.all; });
              })
            else
              ..._visibleMedicines.map((medicine) => _MedicineCard(medicine: medicine)),
          ],
        ),
      ),
    ),
  );

  Widget _filterChip(String label, MedicineFilter value) => FilterChip(
    label: Text(label),
    selected: filter == value,
    onSelected: (_) => setState(() => filter = value),
  );
}

class _QuickStatus extends StatelessWidget {
  const _QuickStatus({required this.expiring, required this.low, required this.missing, required this.onTap});
  final int expiring;
  final int low;
  final int missing;
  final ValueChanged<MedicineFilter> onTap;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      _StatusBox(label: '临期/过期', count: expiring, color: AppColors.terracotta, onTap: () => onTap(MedicineFilter.expiry)),
      const SizedBox(width: 8),
      _StatusBox(label: '库存不足', count: low, color: AppColors.amber, onTap: () => onTap(MedicineFilter.lowStock)),
      const SizedBox(width: 8),
      _StatusBox(label: '待补资料', count: missing, color: AppColors.leaf, onTap: () => onTap(MedicineFilter.missingInfo)),
    ],
  );
}

class _StatusBox extends StatelessWidget {
  const _StatusBox({required this.label, required this.count, required this.color, required this.onTap});
  final String label;
  final int count;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Expanded(
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(16),
      child: AppCard(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 12),
        color: color.withValues(alpha: 0.08),
        child: Column(
          children: [
            Text('$count', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 20, color: color)),
            const SizedBox(height: 3),
            FittedBox(fit: BoxFit.scaleDown, child: Text(label, style: TextStyle(fontSize: 11, color: color))),
          ],
        ),
      ),
    ),
  );
}

class _MedicineCard extends StatelessWidget {
  const _MedicineCard({required this.medicine});
  final MedicineRecord medicine;

  @override
  Widget build(BuildContext context) {
    final batch = medicine.batches.isEmpty ? null : medicine.batches.reduce((a, b) {
      final aDate = a.managementExpiryDate ?? a.expiryValue;
      final bDate = b.managementExpiryDate ?? b.expiryValue;
      if (aDate == null) return bDate == null ? a : b;
      if (bDate == null) return a;
      return aDate.compareTo(bDate) <= 0 ? a : b;
    });
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Card(
        child: InkWell(
          borderRadius: BorderRadius.circular(22),
          onTap: () => context.push('/medicine/${medicine.id}'),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Text(medicine.name, style: Theme.of(context).textTheme.titleMedium),
                    ),
                    _MedicineStatus(medicine: medicine, batch: batch),
                  ],
                ),
                const SizedBox(height: 5),
                Text(medicine.specificationDisplay, style: Theme.of(context).textTheme.bodySmall),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 14,
                  runSpacing: 4,
                  children: [
                    Text('余量：${_totalDisplay(medicine.batches)}', style: Theme.of(context).textTheme.bodyMedium),
                    Text('最早期限：${batch?.managementExpiryDate ?? batch?.expiryDisplay ?? '待补充'}', style: Theme.of(context).textTheme.bodyMedium),
                    if (batch?.storageLocation?.isNotEmpty == true)
                      Text('位置：${batch!.storageLocation}', style: Theme.of(context).textTheme.bodyMedium),
                  ],
                ),
                const SizedBox(height: 6),
                Text(medicine.purpose, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: AppColors.leafDeep)),
              ],
            ),
          ),
        ),
      ),
    );
  }

  String _totalDisplay(List<BatchRecord> batches) {
    if (batches.isEmpty) return '无批次';
    final unknown = batches.any((batch) => batch.quantity == null);
    final groups = <String, int>{};
    for (final batch in batches) {
      if (batch.quantity != null) groups.update(batch.unit, (value) => value + batch.quantity!, ifAbsent: () => batch.quantity!);
    }
    final values = groups.entries.map((entry) => '${entry.value}${unitLabel(entry.key)}').join(' + ');
    if (unknown && values.isNotEmpty) return '$values + 未知';
    if (unknown) return '数量未知';
    return values.isEmpty ? '0' : values;
  }
}

class _MedicineStatus extends StatelessWidget {
  const _MedicineStatus({required this.medicine, required this.batch});
  final MedicineRecord medicine;
  final BatchRecord? batch;

  @override
  Widget build(BuildContext context) {
    final state = batch?.managementExpiryState.state ?? 'unknown';
    final (label, color, background) = batch?.isExpired == true || state == 'expired'
        ? ('已过期', AppColors.terracotta, const Color(0xFFF8E7E0))
        : ['due_this_month', 'expiring_soon'].contains(state)
            ? ('临期', AppColors.amber, const Color(0xFFFFF2DA))
            : medicine.stockStatus == 'low' || medicine.stockStatus == 'exhausted'
                ? ('库存不足', AppColors.terracotta, const Color(0xFFF8E7E0))
                : medicine.stockStatus == 'unknown'
                    ? ('库存待核对', AppColors.muted, const Color(0xFFEEF0ED))
                    : ('有效', AppColors.leafDeep, const Color(0xFFE7F1E9));
    return StatusPill(label: label, color: color, background: background);
  }
}

class _EmptyCabinet extends StatelessWidget {
  const _EmptyCabinet({required this.onAdd});
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) => AppCard(
    child: Column(
      children: [
        const Icon(Icons.inventory_2_outlined, size: 40, color: AppColors.muted),
        const SizedBox(height: 10),
        Text('还没有记录药品', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 6),
        const Text('拍药盒识别，核对后保存；也可以只填药品名称。'),
        const SizedBox(height: 14),
        PrimaryButton(label: '录入第一种药', icon: Icons.add, onPressed: onAdd),
      ],
    ),
  );
}

class _NoSearchResults extends StatelessWidget {
  const _NoSearchResults({required this.onClear});
  final VoidCallback onClear;
  @override
  Widget build(BuildContext context) => AppCard(
    child: Column(
      children: [
        const Text('没有匹配结果'),
        const SizedBox(height: 10),
        SoftButton(label: '清除搜索和筛选', onPressed: onClear),
      ],
    ),
  );
}

class _ConnectionBanner extends StatelessWidget {
  const _ConnectionBanner({required this.text});
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: AppCard(
      color: const Color(0xFFFFF2DA),
      padding: const EdgeInsets.all(12),
      child: Row(children: [const Icon(Icons.cloud_off_outlined), const SizedBox(width: 10), Expanded(child: Text(text))]),
    ),
  );
}

String _formatLastSync(DateTime value) {
  final local = value.toLocal();
  final year = local.year.toString().padLeft(4, '0');
  final month = local.month.toString().padLeft(2, '0');
  final day = local.day.toString().padLeft(2, '0');
  final hour = local.hour.toString().padLeft(2, '0');
  final minute = local.minute.toString().padLeft(2, '0');
  return '$year-$month-$day $hour:$minute';
}
