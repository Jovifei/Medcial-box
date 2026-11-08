import 'dart:ui';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_theme.dart';
import '../../core/theme/app_spacing.dart';
import '../../core/theme/app_typography.dart';
import '../../core/widgets/app_surfaces.dart';
import '../../data/api_client.dart';
import '../../data/api_plan_repository.dart';
import '../../data/dose_confirmation_operations.dart';
import '../../models/plan_models.dart';

/// 用药计划首页：今日安排与计划列表在页内切换。
/// 「今日」日期来自服务端上海日历，客户端不本地猜日期（对齐 R11）。
class PlansPage extends StatefulWidget {
  const PlansPage({super.key, required this.repository, this.onScheduleLoaded});
  final ApiPlanRepository repository;

  /// 今日安排加载后回灌给本地提醒服务，用于排服药到点提醒。
  final void Function(ScheduleDay schedule)? onScheduleLoaded;

  @override
  State<PlansPage> createState() => _PlansPageState();
}

class _PlansPageState extends State<PlansPage> {
  Future<void>? _load;
  ScheduleDay? _schedule;
  List<MedicationPlanSummary> _plans = const [];
  Object? _failure;
  late DoseConfirmationOperations _operations;
  int _loadSequence = 0;
  int? _scheduleEpoch;
  bool _loading = true;
  bool _showAll = false;

  @override
  void initState() {
    super.initState();
    _operations = DoseConfirmationOperations.forClient(widget.repository.api);
    _operations.addListener(_onOperationsChanged);
    _load = _reload();
    widget.repository.addListener(_onChanged);
  }

  void _onChanged() {
    if (mounted) _load = _reload();
  }

  void _onOperationsChanged() {
    if (mounted) setState(() {});
  }

  @override
  void didUpdateWidget(covariant PlansPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (identical(oldWidget.repository, widget.repository)) return;
    oldWidget.repository.removeListener(_onChanged);
    _operations.removeListener(_onOperationsChanged);
    _operations = DoseConfirmationOperations.forClient(widget.repository.api);
    _operations.addListener(_onOperationsChanged);
    widget.repository.addListener(_onChanged);
    _schedule = null;
    _plans = const [];
    _scheduleEpoch = null;
    _load = _reload();
  }

  @override
  void dispose() {
    widget.repository.removeListener(_onChanged);
    _operations.removeListener(_onOperationsChanged);
    _loadSequence++;
    super.dispose();
  }

  Future<void> _reload() async {
    final repository = widget.repository;
    final epoch = repository.api.identityEpoch;
    final sequence = ++_loadSequence;
    bool current() =>
        mounted &&
        identical(repository, widget.repository) &&
        epoch == repository.api.identityEpoch &&
        sequence == _loadSequence;
    setState(() {
      _loading = true;
      if (_scheduleEpoch != epoch) {
        _schedule = null;
        _plans = const [];
      }
    });
    try {
      final schedule = await repository.schedule();
      if (!current()) return;
      final plans = await repository.listPlans();
      if (!current()) return;
      setState(() {
        _schedule = schedule;
        _scheduleEpoch = epoch;
        _plans = plans;
        _failure = null;
        _loading = false;
      });
    } catch (error) {
      if (current()) {
        setState(() {
          _failure = error;
          _loading = false;
        });
      }
    }
  }

  Future<void> _confirm(ScheduleEntry entry, String action) async {
    final repository = widget.repository;
    final epoch = repository.api.identityEpoch;
    final schedule = _schedule;
    if (_scheduleEpoch != epoch) {
      await _reload();
      return;
    }
    if (_loading ||
        schedule == null ||
        !schedule.entries.any((item) => identical(item, entry))) {
      return;
    }
    final operations = _operations;
    DoseConfirmationAttempt? attempt;
    var acknowledged = false;
    try {
      attempt = operations.begin(
        occurrenceId: entry.occurrenceId,
        date: schedule.date,
        action: action,
      );
      if (attempt == null) return;
      await repository.confirmDose(
        entry.occurrenceId,
        action: attempt.action,
        idempotencyKey: attempt.key,
        onConfirmed: (status) {
          acknowledged = true;
          operations.complete(attempt!);
          if (!mounted ||
              !identical(repository, widget.repository) ||
              epoch != repository.api.identityEpoch ||
              _schedule?.date != schedule.date) {
            return;
          }
          setState(() {
            _schedule = ScheduleDay(
              date: schedule.date,
              entries: [
                for (final current in _schedule!.entries)
                  if (current.occurrenceId == entry.occurrenceId)
                    ScheduleEntry(
                      occurrenceId: current.occurrenceId,
                      planId: current.planId,
                      careProfileId: current.careProfileId,
                      careProfileName: current.careProfileName,
                      medicineName: current.medicineName,
                      dosageText: current.dosageText,
                      time: current.time,
                      status: status,
                      receiveDoseReminders: current.receiveDoseReminders,
                    )
                  else
                    current,
              ],
            );
          });
        },
      );
      if (mounted &&
          identical(repository, widget.repository) &&
          epoch == repository.api.identityEpoch) {
        await _reload();
      }
    } catch (error) {
      if (mounted &&
          identical(repository, widget.repository) &&
          epoch == repository.api.identityEpoch) {
        ScaffoldMessenger.of(context).clearSnackBars();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              error is UnresolvedDoseConfirmation
                  ? error.message
                  : acknowledged
                  ? '记录已保存，但后续同步未完成：${friendlyApiError(error)}'
                  : friendlyApiError(error),
            ),
          ),
        );
      }
    } finally {
      if (attempt != null) operations.release(attempt);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDark =
        View.of(context).platformDispatcher.platformBrightness ==
        Brightness.dark;
    return Scaffold(
      backgroundColor: Colors.transparent,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        title: const Text('用药计划', style: AppType.headline),
        flexibleSpace: ClipRect(
          child: BackdropFilter(
            filter: ImageFilter.blur(sigmaX: 24, sigmaY: 24),
            child: Container(
              color: isDark ? const Color(0xB3000000) : const Color(0xC2FFFFFF),
            ),
          ),
        ),
        actions: [
          IconButton(
            tooltip: '照护对象与权限',
            icon: const Icon(CupertinoIcons.person_2),
            onPressed: () => context.push('/care-profiles'),
          ),
        ],
      ),
      floatingActionButton: Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.paddingOf(context).bottom),
        child: FloatingActionButton.extended(
          heroTag: 'plans-add-plan',
          onPressed: () => context.push('/plans/new'),
          icon: const Icon(Icons.add_rounded),
          label: const Text('新建计划'),
        ),
      ),
      body: FutureBuilder<void>(
        future: _load,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done &&
              _schedule == null) {
            return const Center(child: CircularProgressIndicator());
          }
          return RefreshIndicator(
            onRefresh: _reload,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: EdgeInsets.fromLTRB(
                18,
                6,
                18,
                MediaQuery.paddingOf(context).bottom + 100,
              ),
              children: [
                if (_failure != null)
                  AppCard(
                    color: const Color(0xFFFFF2ED),
                    child: Text(friendlyApiError(_failure!)),
                  ),
                CupertinoSlidingSegmentedControl<bool>(
                  groupValue: _showAll,
                  children: const {
                    false: Padding(
                      padding: EdgeInsets.symmetric(vertical: 8),
                      child: Text('今天'),
                    ),
                    true: Padding(
                      padding: EdgeInsets.symmetric(vertical: 8),
                      child: Text('全部计划'),
                    ),
                  },
                  onValueChanged: (value) =>
                      setState(() => _showAll = value ?? false),
                ),
                const SizedBox(height: 16),
                if (_showAll)
                  _plansSection(context)
                else
                  _todaySection(context),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _todaySection(BuildContext context) {
    final schedule = _schedule;
    final entries = schedule?.entries ?? const <ScheduleEntry>[];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 0, 4, 6),
          child: Text(
            schedule == null ? '今日安排' : '今日安排 · ${schedule.date}',
            style: AppType.subhead.copyWith(
              color: CupertinoColors.secondaryLabel.resolveFrom(context),
            ),
          ),
        ),
        if (schedule != null && entries.isEmpty)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 18),
            decoration: BoxDecoration(
              color: CupertinoColors.secondarySystemBackground.resolveFrom(
                context,
              ),
              borderRadius: BorderRadius.circular(AppSpacing.cardRadius),
            ),
            child: Text(
              '今天没有需要确认的服药安排。',
              style: AppType.body.copyWith(
                color: CupertinoColors.secondaryLabel.resolveFrom(context),
              ),
            ),
          )
        else if (entries.isNotEmpty)
          // iOS plain list：同质长列表用连续行 + 分隔线，与首页一致。
          Container(
            decoration: BoxDecoration(
              color: CupertinoColors.secondarySystemBackground.resolveFrom(
                context,
              ),
              borderRadius: BorderRadius.circular(AppSpacing.cardRadius),
            ),
            clipBehavior: Clip.antiAlias,
            child: Column(
              children: [
                for (var i = 0; i < entries.length; i++) ...[
                  if (i > 0)
                    Divider(
                      height: 0.5,
                      thickness: 0.5,
                      indent: 14,
                      color: CupertinoColors.separator.resolveFrom(context),
                    ),
                  _entryRow(entries[i]),
                ],
              ],
            ),
          ),
      ],
    );
  }

  Widget _entryRow(ScheduleEntry entry) {
    final date = _schedule!.date;
    final pending = _operations.pendingFor(entry.occurrenceId, date);
    final busy = _loading || _operations.isBusy(entry.occurrenceId, date);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  entry.medicineName,
                  style: AppType.body.copyWith(fontWeight: FontWeight.w500),
                ),
              ),
              StatusPill(
                label: entry.statusLabel,
                color: entry.isPending ? AppColors.amber : AppColors.leafDeep,
                background: entry.isPending
                    ? const Color(0xFFF7EAD6)
                    : AppColors.mist,
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            '${entry.careProfileName} · ${entry.time} · ${entry.dosageText}',
            style: AppType.subhead.copyWith(
              color: CupertinoColors.secondaryLabel.resolveFrom(context),
            ),
          ),
          if (!entry.isPending && pending != null) ...[
            const SizedBox(height: 10),
            Text(
              '上次记录的返回结果尚未确定，请明确重试以核对结果。',
              style: AppType.footnote.copyWith(
                color: CupertinoColors.systemOrange.resolveFrom(context),
              ),
            ),
            const SizedBox(height: 8),
            SoftButton(
              label: '重试上次记录',
              icon: Icons.refresh_rounded,
              onPressed: busy ? null : () => _confirm(entry, pending.action),
            ),
          ],
          if (entry.isPending) ...[
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: SoftButton(
                    label: busy ? '处理中…' : '已服用',
                    icon: Icons.check_rounded,
                    onPressed: busy ? null : () => _confirm(entry, 'taken'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: SoftButton(
                    label: '跳过',
                    icon: Icons.close_rounded,
                    onPressed: busy ? null : () => _confirm(entry, 'skipped'),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _plansSection(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 0, 4, 6),
          child: Text(
            '我的用药计划',
            style: AppType.subhead.copyWith(
              color: CupertinoColors.secondaryLabel.resolveFrom(context),
            ),
          ),
        ),
        if (_plans.isEmpty)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 18),
            decoration: BoxDecoration(
              color: CupertinoColors.secondarySystemBackground.resolveFrom(
                context,
              ),
              borderRadius: BorderRadius.circular(AppSpacing.cardRadius),
            ),
            child: Text(
              '还没有用药计划。点右下角“新建计划”，为家人安排每天该吃的药。',
              style: AppType.body.copyWith(
                color: CupertinoColors.secondaryLabel.resolveFrom(context),
              ),
            ),
          )
        else
          Container(
            decoration: BoxDecoration(
              color: CupertinoColors.secondarySystemBackground.resolveFrom(
                context,
              ),
              borderRadius: BorderRadius.circular(AppSpacing.cardRadius),
            ),
            clipBehavior: Clip.antiAlias,
            child: Column(
              children: [
                for (var i = 0; i < _plans.length; i++) ...[
                  if (i > 0)
                    Divider(
                      height: 0.5,
                      thickness: 0.5,
                      indent: 14,
                      color: CupertinoColors.separator.resolveFrom(context),
                    ),
                  InkWell(
                    onTap: () => context.push('/plan/${_plans[i].id}'),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 14,
                        vertical: 12,
                      ),
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  _plans[i].medicineName,
                                  style: AppType.body.copyWith(
                                    fontWeight: FontWeight.w500,
                                  ),
                                ),
                                const SizedBox(height: 3),
                                Text(
                                  '${_plans[i].careProfileName} · ${_plans[i].scheduleLabel}',
                                  style: AppType.subhead.copyWith(
                                    color: CupertinoColors.secondaryLabel
                                        .resolveFrom(context),
                                  ),
                                ),
                              ],
                            ),
                          ),
                          StatusPill(
                            label: _plans[i].statusLabel,
                            color: _plans[i].isOngoing
                                ? AppColors.leafDeep
                                : AppColors.muted,
                            background: _plans[i].isOngoing
                                ? AppColors.mist
                                : const Color(0xFFEDEFEA),
                          ),
                          const SizedBox(width: 6),
                          Icon(
                            CupertinoIcons.chevron_forward,
                            size: 15,
                            color: CupertinoColors.separator.resolveFrom(
                              context,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
      ],
    );
  }
}


