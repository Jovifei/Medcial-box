import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_surfaces.dart';
import '../../data/api_client.dart';
import '../../data/api_plan_repository.dart';
import '../../models/plan_models.dart';

/// 计划服药历史：以实例投影展示每次的日期/时间/结果与纠正事件。
class PlanHistoryPage extends StatefulWidget {
  const PlanHistoryPage({
    super.key,
    required this.repository,
    required this.planId,
  });
  final ApiPlanRepository repository;
  final String planId;

  @override
  State<PlanHistoryPage> createState() => _PlanHistoryPageState();
}

class _PlanHistoryPageState extends State<PlanHistoryPage> {
  Future<PlanHistory>? _future;

  @override
  void initState() {
    super.initState();
    _future = widget.repository.planHistory(widget.planId);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('服药历史')),
    body: FutureBuilder<PlanHistory>(
      future: _future,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError) {
          return AppPage(
            child: AppCard(
              color: const Color(0xFFFFF2ED),
              child: Text(friendlyApiError(snapshot.error!)),
            ),
          );
        }
        final history = snapshot.data;
        final records = history?.records ?? const <PlanHistoryRecord>[];
        if (records.isEmpty) {
          return const AppPage(child: AppCard(child: Text('还没有服药记录。')));
        }
        return AppPage(
          child: ListView(
            children: [
              AppCard(
                color: AppColors.mist,
                child: Text(
                  '共 ${records.length} 条记录 · ${history?.medicineName ?? ''}',
                ),
              ),
              const SizedBox(height: 12),
              ...records.map(_recordCard),
            ],
          ),
        );
      },
    ),
  );

  Widget _recordCard(PlanHistoryRecord record) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '${record.date} ${record.time}',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              Text(
                record.statusLabel,
                style: const TextStyle(color: AppColors.leafDeep),
              ),
            ],
          ),
          Text('${record.medicineName} · ${record.dosageText}'),
          if (!record.snapshotComplete) const Text('旧记录资料不完整，请结合原记录核对。'),
          if (record.corrected)
            const Padding(
              padding: EdgeInsets.only(top: 4),
              child: Text('该记录曾被纠正', style: TextStyle(color: AppColors.muted)),
            ),
          if (record.events.isNotEmpty) ...[
            const SizedBox(height: 8),
            ...record.events.map(
              (event) => Padding(
                padding: const EdgeInsets.only(bottom: 2),
                child: Text(
                  '${event.actionLabel} · ${event.actor ?? '家庭成员'} · ${_shortDateTime(event.at)}',
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ),
            ),
          ],
        ],
      ),
    ),
  );

  String _shortDateTime(String iso) {
    final parsed = DateTime.tryParse(iso)?.toLocal();
    if (parsed == null) return iso;
    String two(int v) => v.toString().padLeft(2, '0');
    return '${parsed.year}-${two(parsed.month)}-${two(parsed.day)} ${two(parsed.hour)}:${two(parsed.minute)}';
  }
}
