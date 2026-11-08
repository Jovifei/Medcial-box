import 'dart:async';
import 'dart:ui';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_theme.dart';
import '../../core/theme/app_spacing.dart';
import '../../core/theme/app_typography.dart';
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
import '../medicine/archived_medicines_page.dart';
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
                PendingPage(services: widget.services, onBack: _closeAttention),
            ],
          ),
          PlansPage(repository: widget.services.plans!),
          MyPage(
            services: widget.services,
            familyManagementRequest: familyManagementRequest,
          ),
        ],
      ),
      bottomNavigationBar: CupertinoTabBar(
        // iOS 底部栏：半透明真模糊（栏内建 BackdropFilter）+ 线性图标 + 触感反馈。
        backgroundColor:
            View.of(context).platformDispatcher.platformBrightness ==
                Brightness.dark
            ? const Color(0xC8161616)
            : const Color(0xD9FFFFFF),
        currentIndex: selectedIndex,
        onTap: (index) {
          HapticFeedback.selectionClick();
          setState(() {
            selectedIndex = index;
            if (index == 0 && showAttention) {
              showAttention = false;
              cabinetRefreshVersion++;
            }
          });
        },
        items: const [
          BottomNavigationBarItem(
            icon: Icon(CupertinoIcons.archivebox, size: 24),
            activeIcon: Icon(CupertinoIcons.archivebox_fill, size: 24),
            label: '药箱',
          ),
          BottomNavigationBarItem(
            icon: Icon(CupertinoIcons.calendar, size: 24),
            activeIcon: Icon(CupertinoIcons.calendar, size: 24),
            label: '用药计划',
          ),
          BottomNavigationBarItem(
            icon: Icon(CupertinoIcons.person, size: 24),
            activeIcon: Icon(CupertinoIcons.person_fill, size: 24),
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
  bool loading = true;
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

  /// 已生效的筛选/排序条件数（用于导航栏徽标）。
  int get _filterCount =>
      (filter == MedicineFilter.all ? 0 : 1) +
      selectedPurposes.length +
      selectedPopulations.length +
      (sortOrder == 'expiry' ? 0 : 1);

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
    if (mounted) {
      setState(() {
        loading = true;
        failure = null;
      });
    }
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
          loading = false;
        });
      }
    } catch (error) {
      await pending;
      if (current()) {
        setState(() {
          failure = error;
          loading = false;
        });
      }
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
  Widget build(BuildContext context) {
    final isDark =
        View.of(context).platformDispatcher.platformBrightness ==
        Brightness.dark;
    final bottomInset = MediaQuery.paddingOf(context).bottom;
    return Scaffold(
      backgroundColor: Colors.transparent,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        title: const Text('JF小药箱', style: AppType.headline),
        flexibleSpace: ClipRect(
          // iOS 导航层玻璃：内容滚到栏下时实时模糊（DESIGN.md 允许的材质位置）。
          child: BackdropFilter(
            filter: ImageFilter.blur(sigmaX: 24, sigmaY: 24),
            child: Container(
              color: isDark ? const Color(0xB3000000) : const Color(0xC2FFFFFF),
            ),
          ),
        ),
        actions: [
          TextButton.icon(
            onPressed:
                widget.onManageFamily ??
                () => context.go('/home?tab=my&section=family'),
            icon: const Icon(CupertinoIcons.house),
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
            tooltip: '筛选与排序',
            onPressed: _showFilterSheet,
            icon: Badge(
              isLabelVisible: _filterCount > 0,
              label: Text('$_filterCount'),
              child: const Icon(CupertinoIcons.slider_horizontal_3),
            ),
          ),
          IconButton(
            tooltip: '关注事项',
            onPressed:
                widget.onAttention ?? () => context.go('/home?tab=pending'),
            icon: const Icon(CupertinoIcons.bell),
          ),
        ],
      ),
      floatingActionButton: Padding(
        padding: EdgeInsets.only(bottom: bottomInset),
        child: FloatingActionButton.extended(
          heroTag: 'cabinet-add-medicine',
          onPressed: _openEntry,
          icon: const Icon(Icons.add_rounded),
          label: const Text('录入'),
        ),
      ),
      body: AnimatedBuilder(
        animation: widget.repository,
        builder: (context, _) => RefreshIndicator(
          onRefresh: _refresh,
          child: ListView(
            padding: EdgeInsets.fromLTRB(16, 4, 16, bottomInset + 100),
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
              CupertinoSearchTextField(
                controller: searchController,
                onChanged: (value) => setState(() => keyword = value.trim()),
                placeholder: '搜索药名、规格、厂家、成分',
                style: AppType.body,
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                itemSize: 18,
              ),
              if (attentionUnavailable)
                TextButton.icon(
                  onPressed: _refresh,
                  icon: const Icon(Icons.refresh),
                  label: const Text('关注事项暂不可用，点击重试'),
                ),
              if (_actionable.isNotEmpty) ...[
                const SizedBox(height: 8),
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
                    return Container(
                      decoration: BoxDecoration(
                        color: CupertinoColors.secondarySystemBackground
                            .resolveFrom(context),
                        borderRadius: BorderRadius.circular(
                          AppSpacing.cardRadius,
                        ),
                      ),
                      child: CupertinoListTile.notched(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 10,
                        ),
                        leading: const Icon(
                          CupertinoIcons.exclamationmark_circle,
                          size: 20,
                          color: CupertinoColors.systemOrange,
                        ),
                        title: Text(parts.join(' · '), style: AppType.body),
                        trailing: const CupertinoListTileChevron(),
                        onTap:
                            widget.onAttention ??
                            () => context.go('/home?tab=pending'),
                      ),
                    );
                  },
                ),
              ],
              const SizedBox(height: 12),
              if (widget.repository.medicines.isEmpty && loading)
                const Center(child: CircularProgressIndicator())
              else if (widget.repository.medicines.isEmpty && failure != null)
                const SizedBox.shrink()
              else if (widget.repository.medicines.isEmpty)
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
                // iOS plain list：同质长列表用连续行 + 分隔线，不用每行一张卡片。
                Container(
                  decoration: BoxDecoration(
                    color: CupertinoColors.secondarySystemBackground
                        .resolveFrom(context),
                    borderRadius: BorderRadius.circular(AppSpacing.cardRadius),
                  ),
                  clipBehavior: Clip.antiAlias,
                  child: Column(
                    children: [
                      for (var i = 0; i < _visibleMedicines.length; i++) ...[
                        if (i > 0)
                          Divider(
                            height: 0.5,
                            thickness: 0.5,
                            indent: 74,
                            color: CupertinoColors.separator.resolveFrom(
                              context,
                            ),
                          ),
                        _MedicineRow(
                          medicine: _visibleMedicines[i],
                          imageLoader: imageLoader,
                        ),
                      ],
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }


  /// 筛选与排序：收进 iOS 弹层，把列表整行还给内容（不再平铺胶囊）。
  Future<void> _showFilterSheet() async {
    await showCupertinoModalPopup<void>(
      context: context,
      builder: (sheetContext) => StatefulBuilder(
        builder: (sheetContext, setSheetState) {
          void refresh(VoidCallback change) {
            change();
            setSheetState(() {});
            setState(() {});
          }

          Widget check(bool on) => on
              ? Icon(
                  CupertinoIcons.check_mark,
                  size: 18,
                  color: CupertinoTheme.of(sheetContext).primaryColor,
                )
              : const SizedBox.shrink();

          return Container(
            constraints: BoxConstraints(
              maxHeight: MediaQuery.sizeOf(sheetContext).height * 0.78,
            ),
            decoration: BoxDecoration(
              color: CupertinoColors.systemGroupedBackground.resolveFrom(
                sheetContext,
              ),
              borderRadius: const BorderRadius.vertical(
                top: Radius.circular(20),
              ),
            ),
            child: SafeArea(
              top: false,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 12, 8, 4),
                    child: Row(
                      children: [
                        Text('筛选与排序', style: AppType.headline),
                        const Spacer(),
                        CupertinoButton(
                          padding: EdgeInsets.zero,
                          minimumSize: Size.zero,
                          onPressed: () => refresh(() {
                            filter = MedicineFilter.all;
                            selectedPurposes.clear();
                            selectedPopulations.clear();
                            sortOrder = 'expiry';
                          }),
                          child: Text(
                            '重置',
                            style: AppType.body.copyWith(
                              color: CupertinoTheme.of(
                                sheetContext,
                              ).primaryColor,
                            ),
                          ),
                        ),
                        CupertinoButton(
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                          minimumSize: Size.zero,
                          onPressed: () => Navigator.of(sheetContext).pop(),
                          child: Text(
                            '完成',
                            style: AppType.headline.copyWith(
                              color: CupertinoTheme.of(
                                sheetContext,
                              ).primaryColor,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  Flexible(
                    child: SingleChildScrollView(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                        CupertinoListSection.insetGrouped(
                          header: const Text('状态'),
                          children: [
                            for (final entry in const [
                              (MedicineFilter.all, '全部'),
                              (MedicineFilter.expiry, '临期/过期'),
                              (MedicineFilter.lowStock, '库存不足'),
                              (MedicineFilter.missingInfo, '待补资料'),
                              (MedicineFilter.unknown, '数量/日期未知'),
                            ])
                              CupertinoListTile(
                                title: Text(entry.$2, style: AppType.body),
                                trailing: check(filter == entry.$1),
                                onTap: () => refresh(() => filter = entry.$1),
                              ),
                            CupertinoListTile(
                              title: Text('已归档药品', style: AppType.body),
                              trailing: const CupertinoListTileChevron(),
                              onTap: () {
                                Navigator.of(sheetContext).pop();
                                Navigator.of(context).push(
                                  MaterialPageRoute<void>(
                                    builder: (_) => ArchivedMedicinesPage(
                                      workflow: widget.workflow,
                                    ),
                                  ),
                                );
                              },
                            ),
                          ],
                        ),
                        CupertinoListSection.insetGrouped(
                          header: const Text('用途'),
                          children: [
                            for (final entry in _purposeLabels.entries)
                              CupertinoListTile(
                                title: Text(entry.value, style: AppType.body),
                                trailing: check(
                                  selectedPurposes.contains(entry.key),
                                ),
                                onTap: () => refresh(() {
                                  if (selectedPurposes.contains(entry.key)) {
                                    selectedPurposes.remove(entry.key);
                                  } else {
                                    selectedPurposes.add(entry.key);
                                  }
                                }),
                              ),
                          ],
                        ),
                        CupertinoListSection.insetGrouped(
                          header: const Text('人群'),
                          children: [
                            for (final entry in const [
                              ('adult', '成人'),
                              ('child', '儿童'),
                            ])
                              CupertinoListTile(
                                title: Text(entry.$2, style: AppType.body),
                                trailing: check(
                                  selectedPopulations.contains(entry.$1),
                                ),
                                onTap: () => refresh(() {
                                  if (selectedPopulations.contains(entry.$1)) {
                                    selectedPopulations.remove(entry.$1);
                                  } else {
                                    selectedPopulations.add(entry.$1);
                                  }
                                }),
                              ),
                          ],
                        ),
                        CupertinoListSection.insetGrouped(
                          header: const Text('排序'),
                          children: [
                            for (final entry in const [
                              ('expiry', '到期优先'),
                              ('recent', '最近录入'),
                              ('name', '药名排序'),
                            ])
                              CupertinoListTile(
                                title: Text(entry.$2, style: AppType.body),
                                trailing: check(sortOrder == entry.$1),
                                onTap: () => refresh(
                                  () => sortOrder = entry.$1,
                                ),
                              ),
                          ],
                        ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }


}

class _MedicineRow extends StatelessWidget {
  const _MedicineRow({required this.medicine, required this.imageLoader});
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
    final expired =
        batch?.isExpired == true ||
        batch?.managementExpiryState.state == 'expired';
    final expiringSoon = [
      'due_this_month',
      'expiring_soon',
    ].contains(batch?.managementExpiryState.state);
    final expiryDate =
        batch?.managementExpiryDate ?? batch?.expiryDisplay ?? '待补充';
    return InkWell(
          onTap: () => context.push('/medicine/${medicine.id}'),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(7),
                  child: PrivateMedicineImage(
                    loader: imageLoader,
                    medicineId: medicine.id,
                    photoId: medicine.coverPhotoId,
                    width: 46,
                    height: 46,
                    fit: BoxFit.cover,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              medicine.name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: AppType.body.copyWith(
                                fontWeight: FontWeight.w500,
                                color: CupertinoColors.label.resolveFrom(
                                  context,
                                ),
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          _MedicineStatus(medicine: medicine, batch: batch),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(
                        medicine.specificationDisplay,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppType.subhead.copyWith(
                          color: CupertinoColors.secondaryLabel.resolveFrom(
                            context,
                          ),
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text.rich(
                        TextSpan(
                          children: [
                            TextSpan(text: '余量 ${_totalDisplay(inCabinet)}'),
                            const TextSpan(text: '  ·  '),
                            TextSpan(text: '最早 $expiryDate'),
                          ],
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppType.caption1.copyWith(
                          color: expired
                              ? CupertinoColors.systemRed.resolveFrom(context)
                              : expiringSoon
                              ? CupertinoColors.systemOrange
                              : CupertinoColors.secondaryLabel.resolveFrom(
                                  context,
                                ),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 4),
                Icon(
                  CupertinoIcons.chevron_forward,
                  size: 15,
                  color: CupertinoColors.separator.resolveFrom(context),
                ),
              ],
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
        Text('还没有记录药品', style: Theme.of(context).textTheme.titleSmall),
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
