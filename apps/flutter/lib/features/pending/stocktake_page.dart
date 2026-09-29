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
      medicines = result;
      for (final medicine in result) {
        for (final batch in medicine.batches) {
          lines.putIfAbsent(batch.id, () => _StocktakeLineState(
            medicine: medicine,
            batch: batch,
            outcome: 'deferred',
            quantityController: TextEditingController(text: batch.quantity?.toString() ?? ''),
          ));
        }
      }
      setState(() => loading = false);
    } catch (exception) {
      if (mounted) setState(() { loading = false; error = friendlyApiError(exception); });
    }
  }

  Future<void> _submit() async {
    if (submitting) return;
    final payload = <Map<String, Object?>>[];
    for (final line in lines.values) {
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
    setState(() => submitting = true);
    try {
      results = await widget.workflow.submitStocktakeItems(widget.stocktakeId, payload);
      await widget.repository.listMedicines();
      if (mounted) setState(() {});
      final conflicts = results.where((item) => item['outcome'] == 'conflict' || item['outcome'] == 'not_found').length;
      _showError(conflicts == 0 ? '盘点结果已保存。' : '$conflicts 项发生并发变化，请刷新后核对冲突项。');
    } catch (exception) {
      if (mounted) _showError(friendlyApiError(exception));
    } finally {
      if (mounted) setState(() => submitting = false);
    }
  }

  Future<void> _complete() async {
    if (results.isEmpty || results.any((item) => item['outcome'] == 'conflict')) {
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
          Text(line.medicine.name, style: Theme.of(context).textTheme.titleMedium),
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
          if (conflict)
            const Padding(padding: EdgeInsets.only(top: 8), child: Text('家人同时修改了该批次；请刷新并重新核对。', style: TextStyle(color: AppColors.terracotta))),
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
  final MedicineRecord medicine;
  final BatchRecord batch;
  final TextEditingController quantityController;
  String outcome;
}
