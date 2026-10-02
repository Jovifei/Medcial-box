import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_surfaces.dart';
import '../../data/api_client.dart';
import '../../data/api_workflow_repository.dart';
import '../../data/api_medicine_repository.dart';

class TrashPage extends StatefulWidget {
  const TrashPage({super.key, required this.workflow, required this.medicines});
  final ApiWorkflowRepository workflow;
  final ApiMedicineRepository medicines;
  @override
  State<TrashPage> createState() => _TrashPageState();
}

class _TrashPageState extends State<TrashPage> {
  late Future<List<Map<String, dynamic>>> items = widget.workflow.listTrash();

  Future<void> _restore(Map<String, dynamic> item) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('恢复这条记录？'),
        content: Text('“${item['name'] ?? '库存记录'}”会回到家庭药箱。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('恢复')),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await widget.workflow.restoreTrashItem(item['type'] as String, item['id'] as String);
      // 只刷新活动库存（R15）：含归档查询会把归档记录写回共享快照，污染首页与到期提醒。
      await widget.medicines.listMedicines();
      if (mounted) setState(() => items = widget.workflow.listTrash());
    } catch (error) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(friendlyApiError(error))));
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('回收站')),
    body: AppPage(
      child: FutureBuilder<List<Map<String, dynamic>>>(
        future: items,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator());
          if (snapshot.hasError) return Center(child: Text(friendlyApiError(snapshot.error!)));
          final records = snapshot.data ?? const [];
          if (records.isEmpty) return const Center(child: Text('回收站是空的。'));
          return ListView(
            children: [
              const AppCard(color: Color(0xFFE9F1EB), child: Text('移入回收站的记录会保留 30 天。恢复后库存会重新显示。')),
              ...records.map((item) => AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(item['name'] as String? ?? '库存记录', style: Theme.of(context).textTheme.titleMedium),
                    const SizedBox(height: 5),
                    Text('类型：${item['type'] ?? '药品'} · 删除于：${_date(item['deletedAt'] as String?)}'),
                    Text('回收站保留至：${_date(item['expiresAt'] as String?)}'),
                    if (item['quantity'] != null) Text('余量：${item['quantity']}${_unit(item['unit'] as String?)}'),
                    const SizedBox(height: 10),
                    SoftButton(label: '恢复记录', icon: Icons.restore_rounded, onPressed: () => _restore(item)),
                  ],
                ),
              )),
            ],
          );
        },
      ),
    ),
  );
}

class AuditPage extends StatefulWidget {
  const AuditPage({super.key, required this.workflow});
  final ApiWorkflowRepository workflow;
  @override
  State<AuditPage> createState() => _AuditPageState();
}

class _AuditPageState extends State<AuditPage> {
  late Future<List<Map<String, dynamic>>> events = widget.workflow.listAuditEvents();
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('家庭变更记录')),
    body: AppPage(
      child: FutureBuilder<List<Map<String, dynamic>>>(
        future: events,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator());
          if (snapshot.hasError) return Center(child: Text(friendlyApiError(snapshot.error!)));
          final records = snapshot.data ?? const [];
          if (records.isEmpty) return const Center(child: Text('还没有变更记录。'));
          return ListView(
            children: records.map((event) => AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(event['summary'] as String? ?? event['action'] as String? ?? '更新了家庭库存', style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 4),
                  Text('${event['actorDisplayName'] ?? event['actorName'] ?? '家庭成员'} · ${_date(event['createdAt'] as String?)}', style: const TextStyle(color: AppColors.muted)),
                  if (event['details'] != null) Text('${event['details']}'),
                ],
              ),
            )).toList(growable: false),
          );
        },
      ),
    ),
  );
}

String _unit(String? unit) => switch (unit) {
  'tablet' => '片', 'capsule' => '粒', 'sachet' => '袋', 'bottle' => '瓶', 'box' => '盒', _ => '份',
};
String _date(String? value) => value == null || value.length < 10 ? value ?? '未知' : value.substring(0, 10);
