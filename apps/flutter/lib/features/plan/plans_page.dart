import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_surfaces.dart';
import '../../data/api_client.dart';
import '../../data/api_plan_repository.dart';
import '../../data/dose_confirmation_operations.dart';
import '../../models/plan_models.dart';

/// 用药计划首页（第 4 个导航）：今日安排 + 计划列表。
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
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('用药计划'),
      actions: [
        IconButton(
          tooltip: '照护对象与权限',
          icon: const Icon(Icons.people_outline_rounded),
          onPressed: () => context.push('/care-profiles'),
        ),
      ],
    ),
    floatingActionButton: FloatingActionButton.extended(
      onPressed: () => context.push('/plans/new'),
      icon: const Icon(Icons.add_rounded),
      label: const Text('新建计划'),
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
            padding: const EdgeInsets.fromLTRB(18, 8, 18, 96),
            children: [
              if (_failure != null)
                AppCard(
                  color: const Color(0xFFFFF2ED),
                  child: Text(friendlyApiError(_failure!)),
                ),
              _todaySection(context),
              const SizedBox(height: 16),
              _plansSection(context),
            ],
          ),
        );
      },
    ),
  );

  Widget _todaySection(BuildContext context) {
    final schedule = _schedule;
    final entries = schedule?.entries ?? const <ScheduleEntry>[];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Eyebrow('今日安排'),
        const SizedBox(height: 6),
        Text(
          schedule == null ? '正在读取今天的安排…' : '${schedule.date} · 日期以服务端为准',
          style: Theme.of(context).textTheme.bodyMedium,
        ),
        const SizedBox(height: 10),
        if (schedule != null && entries.isEmpty)
          const AppCard(child: Text('今天没有需要确认的服药安排。')),
        ...entries.map(_entryCard),
      ],
    );
  }

  Widget _entryCard(ScheduleEntry entry) {
    final date = _schedule!.date;
    final pending = _operations.pendingFor(entry.occurrenceId, date);
    final busy = _loading || _operations.isBusy(entry.occurrenceId, date);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: AppCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    entry.medicineName,
                    style: Theme.of(context).textTheme.titleMedium,
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
              style: Theme.of(context).textTheme.bodyMedium,
            ),
            if (!entry.isPending && pending != null) ...[
              const SizedBox(height: 12),
              const Text('上次记录的返回结果尚未确定，请明确重试以核对结果。'),
              SoftButton(
                label: '重试上次记录',
                icon: Icons.refresh_rounded,
                onPressed: busy ? null : () => _confirm(entry, pending.action),
              ),
            ],
            if (entry.isPending) ...[
              const SizedBox(height: 12),
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
      ),
    );
  }

  Widget _plansSection(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Eyebrow('我的用药计划'),
        const SizedBox(height: 10),
        if (_plans.isEmpty)
          const AppCard(child: Text('还没有用药计划。点右下角“新建计划”，为家人安排每天该吃的药。'))
        else
          ..._plans.map(
            (plan) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: AppCard(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                child: ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(
                    plan.medicineName,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  subtitle: Text(
                    '${plan.careProfileName} · ${plan.scheduleLabel}',
                  ),
                  trailing: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      StatusPill(
                        label: plan.statusLabel,
                        color: plan.isOngoing
                            ? AppColors.leafDeep
                            : AppColors.muted,
                        background: plan.isOngoing
                            ? AppColors.mist
                            : const Color(0xFFEDEFEA),
                      ),
                      const Icon(
                        Icons.chevron_right_rounded,
                        color: AppColors.muted,
                      ),
                    ],
                  ),
                  onTap: () => context.push('/plan/${plan.id}'),
                ),
              ),
            ),
          ),
      ],
    );
  }
}
