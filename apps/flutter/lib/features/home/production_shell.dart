import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_surfaces.dart';
import '../../core/widgets/medicine_tags.dart';
import '../../core/widgets/private_medicine_image.dart';
import '../../data/api_auth_repository.dart';
import '../../data/api_client.dart';
import '../../data/api_medicine_repository.dart';
import '../../data/api_workflow_repository.dart';
import '../../data/app_services.dart';
import '../../models/medicine_models.dart';
import '../my/my_page.dart';
import '../pending/pending_page.dart';
import '../plan/plans_page.dart';

class ProductionShell extends StatefulWidget {
  const ProductionShell({
    super.key,
    required this.services,
    this.initialTab = 0,
    this.initialAttention = false,
    this.initialFamilyManagement = false,
  });
  final AppServices services;
  final int initialTab;
  final bool initialAttention;
  final bool initialFamilyManagement;

  @override
  State<ProductionShell> createState() => _ProductionShellState();
}

class _ProductionShellState extends State<ProductionShell>
    with WidgetsBindingObserver {
  int selectedIndex = 0;
  bool showAttention = false;
  int cabinetRefreshVersion = 0;
  int familyManagementRequest = 0;

  void _closeAttention() => setState(() {
    showAttention = false;
    cabinetRefreshVersion++;
  });

  @override
  void initState() {
    super.initState();
    selectedIndex = widget.initialTab.clamp(0, 2).toInt();
    showAttention = widget.initialAttention;
    if (widget.initialFamilyManagement) familyManagementRequest++;
    WidgetsBinding.instance.addObserver(this);
    unawaited(_refreshReminders());
  }

  @override
  void didUpdateWidget(covariant ProductionShell oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.initialTab != widget.initialTab) {
      selectedIndex = widget.initialTab.clamp(0, 2).toInt();
    }
    if (oldWidget.initialAttention != widget.initialAttention) {
      showAttention = widget.initialAttention;
    }
    if (oldWidget.initialFamilyManagement != widget.initialFamilyManagement &&
        widget.initialFamilyManagement) {
      selectedIndex = 2;
      familyManagementRequest++;
    }
  }

  Future<void> _refreshReminders() async {
    try {
      await widget.services.reminders.resume(widget.services.medicines!);
      await widget.services.plans!.onChanged?.call();
    } catch (_) {
      /* Notification permission failures do not block inventory. */
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_refreshReminders());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: selectedIndex != 0 || !showAttention,
    onPopInvokedWithResult: (didPop, _) {
      if (!didPop && selectedIndex == 0 && showAttention) {
        _closeAttention();
      }
    },
    child: Scaffold(
      body: IndexedStack(
        index: selectedIndex,
        children: [
          IndexedStack(
            index: showAttention ? 1 : 0,
            children: [
              CabinetHomePage(
                repository: widget.services.medicines!,
                familyRepository: widget.services.families!,
                workflow: widget.services.workflow!,
                imageLoader: widget.services.privateMedicineImages,
                refreshVersion: cabinetRefreshVersion,
                onAttention: () => setState(() => showAttention = true),
                onManageFamily: () => setState(() {
                  selectedIndex = 2;
                  familyManagementRequest++;
                }),
              ),
              if (showAttention)
                PendingPage(
                  services: widget.services,
                  onBack: _closeAttention,
                ),
            ],
          ),
          PlansPage(repository: widget.services.plans!),
          MyPage(
            services: widget.services,
            familyManagementRequest: familyManagementRequest,
          ),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: selectedIndex,
        onDestinationSelected: (index) => setState(() {
          selectedIndex = index;
          if (index == 0 && showAttention) {
            showAttention = false;
            cabinetRefreshVersion++;
          }
        }),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.inventory_2_outlined),
            selectedIcon: Icon(Icons.inventory_2),
            label: '药箱',
          ),
          NavigationDestination(
            icon: Icon(Icons.medication_outlined),
            selectedIcon: Icon(Icons.medication),
            label: '用药计划',
          ),
          NavigationDestination(
            icon: Icon(Icons.person_outline_rounded),
            selectedIcon: Icon(Icons.person_rounded),
            label: '我的',
          ),
        ],
      ),
    ),
  );
}

class CabinetHomePage extends StatefulWidget {
  const CabinetHomePage({
    super.key,
    required this.repository,
    required this.familyRepository,
    required this.workflow,
    this.imageLoader,
    this.onAttention,
    this.onManageFamily,
    this.refreshVersion = 0,
  });
  final ApiMedicineRepository repository;
  final ApiFamilyRepository familyRepository;
  final ApiWorkflowRepository workflow;
  final PrivateMedicineImageLoader? imageLoader;
  final VoidCallback? onAttention;
  final VoidCallback? onManageFamily;
  final int refreshVersion;

  @override
  State<CabinetHomePage> createState() => _CabinetHomePageState();
}

enum MedicineFilter { all, expiry, lowStock, missingInfo, unknown }

class _CabinetHomePageState extends State<CabinetHomePage> {
  late PrivateMedicineImageLoader imageLoader;
  int _loadSequence = 0;
  List<Map<String, dynamic>>? attention;
  bool attentionUnavailable = false;
  final searchController = TextEditingController();
  String keyword = '';
  String sortOrder = 'expiry';
  MedicineFilter filter = MedicineFilter.all;
  Future<void>? initialLoad;
  FamilyRecord? family;
  Object? failure;
  bool openingEntry = false;

  Future<void> _openEntry() async {
    if (openingEntry) return;
    openingEntry = true;
    try {
      await context.push('/medicine/new');
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('暂时无法打开录入页，请重试。')));
      }
    } finally {
      openingEntry = false;
    }
  }

  // 人群 / 用途标签多选筛选（S5-D）：空集合 = 不筛选；同维度任一命中即匹配。
  final Set<String> selectedPopulations = <String>{};
  final Set<String> selectedPurposes = <String>{};
  static const _purposeLabels = medicinePurposeLabels;
  String? filterPanel;

  @override
  void initState() {
    super.initState();
    imageLoader =
        widget.imageLoader ?? PrivateMedicineImageLoader(widget.workflow.api);
    initialLoad = _load();
  }

  @override
  void didUpdateWidget(covariant CabinetHomePage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.imageLoader != widget.imageLoader ||
        oldWidget.workflow.api != widget.workflow.api) {
      if (oldWidget.imageLoader == null) imageLoader.dispose();
      imageLoader =
          widget.imageLoader ?? PrivateMedicineImageLoader(widget.workflow.api);
    }
    if (oldWidget.repository != widget.repository ||
        oldWidget.familyRepository != widget.familyRepository ||
        oldWidget.workflow != widget.workflow) {
      family = null;
      attention = null;
      attentionUnavailable = false;
      failure = null;
      initialLoad = _load();
    } else if (oldWidget.refreshVersion != widget.refreshVersion) {
      initialLoad = _load();
    }
  }

  @override
  void dispose() {
    _loadSequence++;
    searchController.dispose();
    if (widget.imageLoader == null) imageLoader.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final sequence = ++_loadSequence;
    final api = widget.workflow.api;
    final epoch = api.identityEpoch;
    final scope = api.identityState?.scopeSignal.value;
    bool current() =>
        mounted &&
        sequence == _loadSequence &&
        epoch == api.identityEpoch &&
        scope == api.identityState?.scopeSignal.value;
    final pending = widget.workflow
        .pendingNotifications()
        .then<List<Map<String, dynamic>>?>(
          (value) => value,
          onError: (Object _) => null,
        );
    try {
      final values = await Future.wait<Object>([
        widget.repository.listMedicines(),
        widget.familyRepository.getCurrentFamily(),
      ]);
      final items = await pending;
      if (current()) {
        setState(() {
          family = values[1] as FamilyRecord;
          attention = items;
          attentionUnavailable = items == null;
          failure = null;
        });
      }
    } catch (error) {
      await pending;
      if (current()) setState(() => failure = error);
    }
  }

  bool _needsInfo(MedicineRecord medicine) =>
      medicine.specification == null ||
      medicine.manufacturer == null ||
      medicine.activeIngredients.isEmpty ||
      medicine.leaflet.reviewStatus == 'unverified';

  bool _hasUnknownInventory(MedicineRecord medicine) =>
      medicine.stockStatus == 'unknown' ||
      medicine.expiryState.state == 'unknown';

  List<MedicineRecord> get _visibleMedicines {
    final result = widget.repository.medicines.where((medicine) {
      final query = keyword.toLowerCase();
      final matchesQuery =
          query.isEmpty ||
          [
            medicine.name,
            medicine.specification ?? '',
            medicine.manufacturer ?? '',
            medicine.purpose,
            ...medicine.activeIngredients,
            ...medicine.batches.map((batch) => batch.storageLocation ?? ''),
          ].any((value) => value.toLowerCase().contains(query));
      if (!matchesQuery) return false;
      if (selectedPopulations.isNotEmpty &&
          !medicine.populationTags.any(
            (tag) => selectedPopulations.contains(tag),
          )) {
        return false;
      }
      if (selectedPurposes.isNotEmpty &&
          !medicine.purposeTags.any((tag) => selectedPurposes.contains(tag))) {
        return false;
      }
      return switch (filter) {
        MedicineFilter.all => true,
        MedicineFilter.expiry => medicine.batches.any(
          (batch) =>
              batch.dispositionStatus != 'handled' &&
              (batch.isExpired ||
                  [
                    'due_this_month',
                    'expiring_soon',
                  ].contains(batch.managementExpiryState.state)),
        ),
        MedicineFilter.lowStock => [
          'low',
          'exhausted',
        ].contains(medicine.stockStatus),
        MedicineFilter.missingInfo => _needsInfo(medicine),
        MedicineFilter.unknown => _hasUnknownInventory(medicine),
      };
    }).toList();
    String? expiry(MedicineRecord medicine) {
      final dates =
          medicine.batches
              .where((batch) => batch.dispositionStatus != 'handled')
              .map((batch) => batch.managementExpiryDate)
              .whereType<String>()
              .toList()
            ..sort();
      return dates.isEmpty ? null : dates.first;
    }

    result.sort((a, b) {
      final left = sortOrder == 'recent'
          ? a.createdAt
          : sortOrder == 'name'
          ? a.name
          : expiry(a);
      final right = sortOrder == 'recent'
          ? b.createdAt
          : sortOrder == 'name'
          ? b.name
          : expiry(b);
      if (left == null) return right == null ? a.name.compareTo(b.name) : 1;
      if (right == null) return -1;
      return sortOrder == 'recent'
          ? right.compareTo(left)
          : left.compareTo(right);
    });
    return result;
  }

  List<Map<String, dynamic>> get _actionable => (attention ?? const [])
      .where((item) => item['type'] != 'leaflet_missing')
      .toList();

  Future<void> _refresh() async {
    await _load();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('JF小药箱'),
      actions: [
        TextButton.icon(
          onPressed: widget.onManageFamily ??
              () => context.go('/home?tab=my&section=family'),
          icon: const Icon(Icons.home_outlined),
          label: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 100),
            child: Text(
              family?.name ?? '家庭',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ),
        IconButton(
          tooltip: '关注事项',
          onPressed:
              widget.onAttention ?? () => context.go('/home?tab=pending'),
          icon: const Icon(Icons.notifications_none_rounded),
        ),
      ],
    ),
    floatingActionButton: FloatingActionButton.extended(
      heroTag: 'cabinet-add-medicine',
      onPressed: _openEntry,
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
                    Text(
                      friendlyApiError(failure!),
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                    const SizedBox(height: 10),
                    SoftButton(label: '重新加载', onPressed: _refresh),
                  ],
                ),
              ),
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
            if (attentionUnavailable)
              TextButton.icon(
                onPressed: _refresh,
                icon: const Icon(Icons.refresh),
                label: const Text('关注事项暂不可用，点击重试'),
              ),
            if (_actionable.isNotEmpty) ...[
              const SizedBox(height: 12),
              Builder(
                builder: (context) {
                  final count = _actionable
                      .map((item) => item['medicineId'])
                      .whereType<String>()
                      .where((id) => id.isNotEmpty)
                      .toSet()
                      .length;
                  final stocktake = _actionable.any(
                    (item) =>
                        item['type'] == 'stocktake_due' &&
                        item['medicineId'] == null,
                  );
                  final parts = <String>[
                    if (count > 0) '需关注 $count 种',
                    if (stocktake) '药箱盘点',
                  ];
                  if (parts.isEmpty) return const SizedBox.shrink();
                  return AppCard(
                    color: const Color(0xFFFFF5E8),
                    padding: EdgeInsets.zero,
                    child: ListTile(
                      title: Text(parts.join(' · ')),
                      trailing: const Icon(Icons.chevron_right),
                      onTap:
                          widget.onAttention ??
                          () => context.go('/home?tab=pending'),
                    ),
                  );
                },
              ),
            ],
            const SizedBox(height: 12),
            Row(
              children: [
                _filterEntry('用途', 'purpose'),
                _filterEntry('人群', 'population'),
                _filterEntry('状态', 'status'),
                Expanded(
                  child: PopupMenuButton<String>(
                    tooltip: '排序',
                    initialValue: sortOrder,
                    onSelected: (value) => setState(() => sortOrder = value),
                    itemBuilder: (_) => const [
                      PopupMenuItem(value: 'expiry', child: Text('到期优先')),
                      PopupMenuItem(value: 'recent', child: Text('最近录入')),
                      PopupMenuItem(value: 'name', child: Text('药名排序')),
                    ],
                    child: const Padding(
                      padding: EdgeInsets.symmetric(vertical: 12),
                      child: Text('排序 ▾', textAlign: TextAlign.center),
                    ),
                  ),
                ),
              ],
            ),
            if (filterPanel != null)
              AppCard(
                padding: const EdgeInsets.all(12),
                child: Wrap(
                  spacing: 8,
                  runSpacing: 6,
                  children: [
                    if (filterPanel == 'purpose')
                      ..._purposeLabels.entries.map(
                        (entry) =>
                            _tagChip(entry.value, selectedPurposes, entry.key),
                      ),
                    if (filterPanel == 'population') ...[
                      _tagChip('成人', selectedPopulations, 'adult'),
                      _tagChip('儿童', selectedPopulations, 'child'),
                    ],
                    if (filterPanel == 'status') ...[
                      _filterChip('全部', MedicineFilter.all),
                      _filterChip('临期/过期', MedicineFilter.expiry),
                      _filterChip('库存不足', MedicineFilter.lowStock),
                      _filterChip('待补资料', MedicineFilter.missingInfo),
                      _filterChip('数量/日期未知', MedicineFilter.unknown),
                    ],
                  ],
                ),
              ),
            const SizedBox(height: 12),
            if (widget.repository.medicines.isEmpty && failure == null)
              const _EmptyCabinet()
            else if (_visibleMedicines.isEmpty)
              _NoSearchResults(
                onClear: () {
                  searchController.clear();
                  setState(() {
                    keyword = '';
                    filter = MedicineFilter.all;
                    selectedPopulations.clear();
                    selectedPurposes.clear();
                  });
                },
              )
            else
              ..._visibleMedicines.map(
                (medicine) =>
                    _MedicineCard(medicine: medicine, imageLoader: imageLoader),
              ),
          ],
        ),
      ),
    ),
  );

  Widget _filterEntry(String label, String panel) => Expanded(
    child: TextButton(
      onPressed: () =>
          setState(() => filterPanel = filterPanel == panel ? null : panel),
      style: TextButton.styleFrom(
        padding: const EdgeInsets.symmetric(vertical: 12),
        foregroundColor: filterPanel == panel ? AppColors.leaf : AppColors.ink,
      ),
      child: Text('$label ▾'),
    ),
  );

  Widget _filterChip(String label, MedicineFilter value) => FilterChip(
    label: Text(label),
    selected: filter == value,
    onSelected: (_) => setState(() => filter = value),
  );

  Widget _tagChip(String label, Set<String> bucket, String value) => FilterChip(
    label: Text(label),
    selected: bucket.contains(value),
    onSelected: (on) => setState(() {
      if (on) {
        bucket.add(value);
      } else {
        bucket.remove(value);
      }
    }),
  );
}

class _MedicineCard extends StatelessWidget {
  const _MedicineCard({required this.medicine, required this.imageLoader});
  final MedicineRecord medicine;
  final PrivateMedicineImageLoader imageLoader;

  @override
  Widget build(BuildContext context) {
    // B23：在库口径 = 未处置批次；已处理批次保留在详情/历史，不驱动卡片摘要。
    final inCabinet = medicine.batches
        .where((batch) => batch.dispositionStatus != 'handled')
        .toList();
    final batch = inCabinet.isEmpty
        ? null
        : inCabinet.reduce((a, b) {
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
                    ClipRRect(
                      borderRadius: BorderRadius.circular(12),
                      child: PrivateMedicineImage(
                        loader: imageLoader,
                        medicineId: medicine.id,
                        photoId: medicine.coverPhotoId,
                        width: 54,
                        height: 54,
                        fit: BoxFit.cover,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            medicine.name,
                            style: Theme.of(context).textTheme.titleMedium
                                ?.copyWith(
                                  fontWeight: FontWeight.bold,
                                  color: AppColors.ink,
                                ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            medicine.specificationDisplay,
                            style: Theme.of(context).textTheme.bodySmall
                                ?.copyWith(color: AppColors.muted),
                          ),
                        ],
                      ),
                    ),
                    _MedicineStatus(medicine: medicine, batch: batch),
                  ],
                ),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 14,
                  runSpacing: 4,
                  children: [
                    Text(
                      '余量：${_totalDisplay(inCabinet)}',
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                        color: AppColors.ink,
                      ),
                    ),
                    Text(
                      '最早期限：${batch?.managementExpiryDate ?? batch?.expiryDisplay ?? '待补充'}',
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                  ],
                ),
                if (medicine.purposeTags.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    children: medicine.purposeTags
                        .take(1)
                        .map(
                          (tag) => Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 8,
                              vertical: 2,
                            ),
                            decoration: BoxDecoration(
                              color: const Color(0xFFF1F5F9),
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: Text(
                              medicinePurposeLabels[tag] ?? tag,
                              style: const TextStyle(
                                fontSize: 11,
                                color: AppColors.muted,
                              ),
                            ),
                          ),
                        )
                        .toList(),
                  ),
                ] else if (medicine.purpose.isNotEmpty &&
                    medicine.purpose != '用途待补充') ...[
                  const SizedBox(height: 8),
                  Text(
                    medicine.purpose,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: AppColors.leafDeep,
                      fontSize: 12,
                    ),
                  ),
                ],
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
    final groups = <String, double>{};
    for (final batch in batches) {
      if (batch.quantity != null) {
        groups.update(
          batch.unit,
          (value) => value + batch.quantity!,
          ifAbsent: () => batch.quantity!,
        );
      }
    }
    final values = groups.entries
        .map((entry) => '${entry.value}${unitLabel(entry.key)}')
        .join(' + ');
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
    final (
      label,
      color,
      background,
    ) = batch?.isExpired == true || state == 'expired'
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
  const _EmptyCabinet();

  @override
  Widget build(BuildContext context) => AppCard(
    child: Column(
      children: [
        const Icon(
          Icons.inventory_2_outlined,
          size: 40,
          color: AppColors.muted,
        ),
        const SizedBox(height: 10),
        Text('还没有记录药品', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 6),
        const Text('拍药盒识别，核对后保存；也可以只填药品名称。'),
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
      child: Row(
        children: [
          const Icon(Icons.cloud_off_outlined),
          const SizedBox(width: 10),
          Expanded(child: Text(text)),
        ],
      ),
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
