import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_surfaces.dart';
import '../../data/api_client.dart';
import '../../data/api_plan_repository.dart';
import '../../models/plan_models.dart';

/// 用药计划首页（第 4 个导航）：今日安排 + 计划列表。
/// 「今日」日期来自服务端上海日历，客户端不本地猜日期（对齐 R11）。
class PlansPage extends StatefulWidget {
  const PlansPage({
    super.key,
    required this.repository,
    this.onScheduleLoaded,
  });
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
  final Set<String> _confirming = <String>{};

  @override
  void initState() {
    super.initState();
    _load = _reload();
  }

  Future<void> _reload() async {
    try {
      final schedule = await widget.repository.schedule();
      widget.onScheduleLoaded?.call(schedule);
      final plans = await widget.repository.listPlans();
      if (!mounted) return;
      setState(() {
        _schedule = schedule;
        _plans = plans;
        _failure = null;
      });
    } catch (error) {
      if (mounted) setState(() => _failure = error);
    }
  }

  Future<void> _confirm(ScheduleEntry entry, String action) async {
    if (_confirming.contains(entry.occurrenceId)) return;
    setState(() => _confirming.add(entry.occurrenceId));
    final key =
        '${entry.occurrenceId}:$action:${DateTime.now().microsecondsSinceEpoch}';
    try {
      await widget.repository.confirmDose(
        entry.occurrenceId,
        action: action,
        idempotencyKey: key,
      );
      await _reload();
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(friendlyApiError(error))));
      }
    } finally {
      if (mounted) setState(() => _confirming.remove(entry.occurrenceId));
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
          schedule == null
              ? '正在读取今天的安排…'
              : '${schedule.date} · 日期以服务端为准',
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
    final busy = _confirming.contains(entry.occurrenceId);
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
          const AppCard(
            child: Text('还没有用药计划。点右下角“新建计划”，为家人安排每天该吃的药。'),
          )
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
                  subtitle: Text('${plan.careProfileName} · ${plan.scheduleLabel}'),
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
