import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/widgets/app_surfaces.dart';
import '../../data/api_client.dart';
import '../../data/api_plan_repository.dart';
import '../../models/plan_models.dart';

/// 计划详情：展示、暂停/恢复/结束（携带版本号）、进入编辑与历史。
class PlanDetailPage extends StatefulWidget {
  const PlanDetailPage({
    super.key,
    required this.repository,
    required this.planId,
  });
  final ApiPlanRepository repository;
  final String planId;

  @override
  State<PlanDetailPage> createState() => _PlanDetailPageState();
}

class _PlanDetailPageState extends State<PlanDetailPage> {
  Future<void>? _load;
  PlanDetail? _detail;
  Object? _failure;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load = _reload();
  }

  Future<void> _reload() async {
    try {
      final detail = await widget.repository.getPlan(widget.planId);
      if (!mounted) return;
      setState(() {
        _detail = detail;
        _failure = null;
      });
    } catch (error) {
      if (mounted) setState(() => _failure = error);
    }
  }

  Future<bool> _confirm(String title, String body) async {
    final result = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: Text(body),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('确定'),
          ),
        ],
      ),
    );
    return result == true;
  }

  Future<void> _changeStatus(String action, String label) async {
    final plan = _detail?.plan;
    if (plan == null || _busy) return;
    if (!await _confirm('$label这条计划', '$label后，已确认的历史记录保持不变。')) return;
    setState(() => _busy = true);
    try {
      await widget.repository.changeStatus(
        plan.id,
        action: action,
        version: plan.version,
      );
      await _reload();
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(friendlyApiError(error))));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('计划详情')),
    body: FutureBuilder<void>(
      future: _load,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done &&
            _detail == null) {
          return const Center(child: CircularProgressIndicator());
        }
        final detail = _detail;
        return AppPage(
          child: RefreshIndicator(
            onRefresh: _reload,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              children: [
                if (_failure != null && detail == null)
                  AppCard(
                    color: const Color(0xFFFFF2ED),
                    child: Text(friendlyApiError(_failure!)),
                  )
                else if (detail != null) ..._planCards(context, detail),
              ],
            ),
          ),
        );
      },
    ),
  );

  List<Widget> _planCards(BuildContext context, PlanDetail detail) {
    final plan = detail.plan;
    return [
      AppCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    plan.medicineName,
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
                StatusPill(
                  label: plan.statusLabel,
                  color: plan.isOngoing
                      ? const Color(0xFF315F46)
                      : const Color(0xFF718078),
                  background: plan.isOngoing
                      ? const Color(0xFFE7F0E9)
                      : const Color(0xFFEDEFEA),
                ),
              ],
            ),
            const SizedBox(height: 10),
            _line(context, '照护对象', plan.careProfileName),
            _line(context, '剂量', plan.dosageText),
            _line(context, '时间安排', plan.scheduleLabel),
            _line(
              context,
              '有效期',
              '${plan.startDate}${plan.endDate == null ? ' 起' : ' 至 ${plan.endDate}'}',
            ),
            if (!detail.canManage)
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: Text('你对此计划只有查看权限。'),
              ),
          ],
        ),
      ),
      const SizedBox(height: 14),
      AppCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SoftButton(
              label: '查看服药历史',
              icon: Icons.history_rounded,
              onPressed: () => context.push('/plan/${plan.id}/history'),
            ),
            if (detail.canManage && plan.status != 'ended') ...[
              const SizedBox(height: 10),
              PrimaryButton(
                label: '编辑计划',
                icon: Icons.edit_outlined,
                onPressed: _busy
                    ? null
                    : () => context.push('/plan/${plan.id}/edit'),
              ),
              const SizedBox(height: 10),
              SoftButton(
                label: plan.status == 'paused' ? '恢复计划' : '暂停计划',
                icon: plan.status == 'paused'
                    ? Icons.play_circle_outline_rounded
                    : Icons.pause_circle_outline_rounded,
                onPressed: _busy
                    ? null
                    : () => _changeStatus(
                        plan.status == 'paused' ? 'resume' : 'pause',
                        plan.status == 'paused' ? '恢复' : '暂停',
                      ),
              ),
              const SizedBox(height: 10),
              SoftButton(
                label: '结束计划',
                icon: Icons.stop_circle_outlined,
                onPressed: _busy
                    ? null
                    : () => _changeStatus('end', '结束'),
              ),
            ],
          ],
        ),
      ),
    ];
  }

  Widget _line(BuildContext context, String label, String value) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 76,
          child: Text(label, style: Theme.of(context).textTheme.bodyMedium),
        ),
        Expanded(child: Text(value)),
      ],
    ),
  );
}
