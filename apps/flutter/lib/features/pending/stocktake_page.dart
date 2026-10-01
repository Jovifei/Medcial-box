import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_surfaces.dart';
import '../../data/api_client.dart';
import '../../data/api_medicine_repository.dart';
import '../../data/api_workflow_repository.dart';
import '../../models/medicine_models.dart';

class StocktakePage extends StatefulWidget {
  const StocktakePage({super.key, required this.repository, required this.workflow, required this.stocktakeId});
  final ApiMedicineRepository repository;
  final ApiWorkflowRepository workflow;
  final String stocktakeId;
  @override
  State<StocktakePage> createState() => _StocktakePageState();
}

class _StocktakePageState extends State<StocktakePage> {
  List<MedicineRecord> medicines = const [];
  final Map<String, _StocktakeLineState> lines = {};
  List<Map<String, dynamic>> results = const [];
  bool loading = true;
  bool submitting = false;
  String? error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { loading = true; error = null; });
    try {
      final result = await widget.repository.listMedicines();
      if (!mounted) return;
      _applySnapshot(result);
      setState(() => loading = false);
    } catch (exception) {
      if (mounted) setState(() { loading = false; error = friendlyApiError(exception); });
    }
  }

  /// 用服务端最新数据替换每行的批次快照（而不是保留旧快照），
  /// 这样冲突后重新提交携带的是新版本；用户的输入保留但标记需重新核对。
  void _applySnapshot(List<MedicineRecord> result) {
    medicines = result;
    final next = <String, _StocktakeLineState>{};
    for (final medicine in result) {
      for (final batch in medicine.batches) {
        final existing = lines[batch.id];
        if (existing == null) {
          next[batch.id] = _StocktakeLineState(
            medicine: medicine,
            batch: batch,
            outcome: 'deferred',
            quantityController: TextEditingController(text: batch.quantity?.toString() ?? ''),
          );
          continue;
        }
        final versionChanged = existing.batch.version != batch.version;
        existing
          ..medicine = medicine
          ..batch = batch;
        if (versionChanged && !existing.saved) existing.serverChanged = true;
        next[batch.id] = existing;
      }
    }
    // 服务端已删除的行不再参与本次盘点。
    for (final entry in lines.entries) {
      if (!next.containsKey(entry.key)) entry.value.quantityController.dispose();
    }
    lines
      ..clear()
      ..addAll(next);
  }

  Future<void> _submit() async {
    if (submitting) return;
    final payload = <Map<String, Object?>>[];
    for (final line in lines.values) {
      // 已保存的项不再重复提交；真正需要重试的是冲突、未找到和尚未提交的项。
      if (line.saved) continue;
      if (line.serverChanged) {
        _showError('“${line.medicine.name}”的批次已被家人修改，请核对最新数量后再保存。');
        return;
      }
      final int? quantity;
      if (line.outcome == 'adjusted') {
        quantity = int.tryParse(line.quantityController.text.trim());
        if (quantity == null || quantity < 0) {
          _showError('“${line.medicine.name}”的数量请输入 0 或正整数。');
          return;
        }
      } else if (line.outcome == 'empty') {
        quantity = 0;
      } else {
        quantity = null;
      }
      payload.add({
        'batchId': line.batch.id,
        'version': line.batch.version,
        'outcome': line.outcome,
        'quantity': ?quantity,
      });
    }
    if (payload.isEmpty) {
      _showError('没有需要提交的盘点项。');
      return;
    }
    setState(() => submitting = true);
    try {
      final submitted = await widget.workflow.submitStocktakeItems(widget.stocktakeId, payload);
      results = submitted;
      for (final item in submitted) {
        final batchId = item['batchId'];
        if (batchId is! String) continue;
        final line = lines[batchId];
        if (line == null) continue;
        if (item['outcome'] == 'saved') {
          line
            ..saved = true
            ..serverChanged = false;
        }
      }
      // 刷新快照：冲突项据此拿到服务端最新版本，下次提交不再重复发旧版本。
      final refreshed = await widget.repository.listMedicines();
      if (!mounted) return;
      _applySnapshot(refreshed);
      setState(() {});
      final conflicts = submitted.where((item) => item['outcome'] == 'conflict' || item['outcome'] == 'not_found').length;
      _showError(conflicts == 0 ? '盘点结果已保存。' : '$conflicts 项发生并发变化，已刷新最新版本，请重新核对冲突项。');
    } catch (exception) {
      if (mounted) _showError(friendlyApiError(exception));
    } finally {
      if (mounted) setState(() => submitting = false);
    }
  }

  Future<void> _complete() async {
    final unresolved = results.where((item) => item['outcome'] != 'saved').length;
    if (results.isEmpty || unresolved > 0) {
      _showError('请先保存盘点结果，并处理并发冲突。');
      return;
    }
    setState(() => submitting = true);
    try {
      await widget.workflow.completeStocktake(widget.stocktakeId);
      await widget.repository.listMedicines();
      if (mounted) context.pop();
    } catch (exception) {
      if (mounted) _showError(friendlyApiError(exception));
    } finally {
      if (mounted) setState(() => submitting = false);
    }
  }

  void _showError(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  @override
  void dispose() {
    for (final line in lines.values) {
      line.quantityController.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('批次盘点')),
    bottomNavigationBar: SafeArea(
      minimum: const EdgeInsets.fromLTRB(18, 8, 18, 10),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          PrimaryButton(label: submitting ? '正在保存…' : '保存盘点结果', icon: Icons.save_outlined, onPressed: submitting || loading ? null : _submit),
          if (results.isNotEmpty) ...[
            const SizedBox(height: 7),
            SoftButton(label: '完成本次盘点', onPressed: submitting ? null : _complete),
          ],
        ],
      ),
    ),
    body: AppPage(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
      child: loading
          ? const Center(child: CircularProgressIndicator())
          : error != null
              ? Column(children: [Text(error!), const SizedBox(height: 10), SoftButton(label: '重试', onPressed: _load)])
              : ListView(
                  children: [
                    const AppCard(color: Color(0xFFE9F1EB), child: Text('逐个核对实际余量。盘点只保存你的确认，不自动扣减或覆盖尚未确认的批次。')),
                    const SizedBox(height: 10),
                    if (lines.isEmpty)
                      const AppCard(child: Text('当前没有可盘点的库存批次。'))
                    else
                      ...lines.values.map(_lineCard),
                    if (results.isNotEmpty) ...[
                      const SizedBox(height: 12),
                      AppCard(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('保存结果', style: Theme.of(context).textTheme.titleMedium),
                            const SizedBox(height: 8),
                            ...results.map((item) => Text('${item['batchId']}: ${_resultLabel(item['outcome'] as String?)}${item['currentVersion'] == null ? '' : ' · 当前版本 ${item['currentVersion']}'}')),
                          ],
                        ),
                      ),
                    ],
                  ],
                ),
    ),
  );

  Widget _lineCard(_StocktakeLineState line) {
    final conflict = results.any((item) => item['batchId'] == line.batch.id && (item['outcome'] == 'conflict' || item['outcome'] == 'not_found'));
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(line.medicine.name, style: Theme.of(context).textTheme.titleMedium)),
              if (line.saved) const Text('已保存', style: TextStyle(color: AppColors.leaf)),
            ],
          ),
          Text('批号：${line.batch.lotNumber ?? '未记录'} · 当前：${line.batch.quantityDisplay}'),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(
            initialValue: line.outcome,
            decoration: const InputDecoration(labelText: '本次盘点'),
            items: const [
              DropdownMenuItem(value: 'unchanged', child: Text('数量无变化')),
              DropdownMenuItem(value: 'adjusted', child: Text('修改余量')),
              DropdownMenuItem(value: 'empty', child: Text('已用完（设为 0）')),
              DropdownMenuItem(value: 'handled', child: Text('已处理')),
              DropdownMenuItem(value: 'deferred', child: Text('暂不核对')),
            ],
            onChanged: (value) => setState(() => line.outcome = value ?? 'deferred'),
          ),
          if (line.outcome == 'adjusted') ...[
            const SizedBox(height: 8),
            TextField(controller: line.quantityController, keyboardType: TextInputType.number, decoration: InputDecoration(labelText: '实际余量（${unitLabel(line.batch.unit)}）')),
          ],
          if (line.serverChanged)
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text('家人已修改该批次：已载入最新版本，请重新核对后再保存。', style: TextStyle(color: AppColors.terracotta)),
            ),
          if (conflict)
            const Padding(padding: EdgeInsets.only(top: 8), child: Text('家人同时修改了该批次；已载入最新版本，请重新核对后再次保存。', style: TextStyle(color: AppColors.terracotta))),
        ],
      ),
    );
  }

  String _resultLabel(String? value) => switch (value) {
    'saved' => '已保存',
    'conflict' => '版本冲突',
    'not_found' => '记录不存在',
    _ => '未知结果',
  };
}

class _StocktakeLineState {
  _StocktakeLineState({required this.medicine, required this.batch, required this.outcome, required this.quantityController});
  /// 药品与批次快照必须可替换：刷新后要按服务端最新版本重新提交（A06）。
  MedicineRecord medicine;
  BatchRecord batch;
  final TextEditingController quantityController;
  String outcome;
  /// 已成功保存：重试时不再重复提交这一项。
  bool saved = false;
  /// 刷新后发现服务端版本已变化：提示用户重新核对，而不是继续提交旧版本。
  bool serverChanged = false;
}
