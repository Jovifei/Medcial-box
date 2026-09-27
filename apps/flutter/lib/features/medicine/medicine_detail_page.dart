import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_surfaces.dart';
import '../../data/demo_repositories.dart';
import '../../models/demo_models.dart';

class MedicineDetailPage extends StatefulWidget {
  const MedicineDetailPage({
    super.key,
    required this.repository,
    required this.medicineId,
  });
  final DemoMedicineRepository repository;
  final String medicineId;

  @override
  State<MedicineDetailPage> createState() => _MedicineDetailPageState();
}

class _MedicineDetailPageState extends State<MedicineDetailPage> {
  late Future<DemoMedicine> _medicineFuture;

  @override
  void initState() {
    super.initState();
    _medicineFuture = widget.repository.getMedicine(widget.medicineId);
  }

  void _reloadMedicine() {
    setState(() {
      _medicineFuture = widget.repository.getMedicine(widget.medicineId);
    });
  }

  Future<void> _editNote(DemoMedicine medicine) async {
    final note = await showAppSheet<String>(
      context,
      title: '个人剂量备注',
      builder: (_) => _PersonalNoteSheet(initialNote: medicine.personalNote),
    );
    if (note != null && mounted) {
      widget.repository.updatePersonalNote(medicine.id, note);
      _reloadMedicine();
    }
  }

  Future<void> _addBatch() async {
    await showAppSheet<void>(
      context,
      title: '添加批次',
      builder: (sheetContext) => _AddBatchSheet(
        onSave: (quantity, unit, expiry) {
          widget.repository.addBatch(
            medicineId: widget.medicineId,
            quantity: quantity,
            unit: unit,
            expiry: expiry,
          );
          Navigator.pop(sheetContext);
          if (mounted) _reloadMedicine();
        },
      ),
    );
  }

  Future<void> _archive(DemoMedicine medicine) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('归档这项药品？'),
        content: Text('“${medicine.name}”会从演示药箱首页移除。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('归档'),
          ),
        ],
      ),
    );
    if (confirmed == true && mounted) {
      widget.repository.archive(medicine.id);
      context.pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: const BackButton(),
        title: const Text('药品详情'),
        actions: [
          IconButton(
            tooltip: '归档药品',
            onPressed: () async {
              final medicine = await widget.repository.getMedicine(
                widget.medicineId,
              );
              if (mounted) {
                _archive(medicine);
              }
            },
            icon: const Icon(Icons.archive_outlined),
          ),
        ],
      ),
      body: FutureBuilder<DemoMedicine>(
        future: _medicineFuture,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError || !snapshot.hasData) {
            return AppPage(
              child: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      '找不到这项药品',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 12),
                    SoftButton(label: '返回药箱', onPressed: () => context.pop()),
                  ],
                ),
              ),
            );
          }
          final medicine = snapshot.data!;
          return AppPage(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 28),
            child: ListView(
              children: [
                Hero(
                  tag: 'medicine-${medicine.id}',
                  child: Material(
                    color: Colors.transparent,
                    child: AppCard(
                      color: AppColors.mist,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            medicine.name,
                            style: Theme.of(context).textTheme.headlineMedium,
                          ),
                          const SizedBox(height: 8),
                          Text(
                            medicine.specification,
                            style: Theme.of(context).textTheme.bodyMedium,
                          ),
                          const SizedBox(height: 18),
                          Text(
                            medicine.purpose,
                            style: Theme.of(context).textTheme.titleMedium
                                ?.copyWith(color: AppColors.leafDeep),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 14),
                AppCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '批次与有效期',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 14),
                      if (medicine.batches.isEmpty)
                        const Text('暂无批次记录，可在下方添加。')
                      else
                        ...medicine.batches.map(
                          (batch) => _BatchRow(batch: batch),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                AppCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '说明书状态',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 8),
                      Text(
                        _leafletLabel(medicine.leafletStatus),
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                      const SizedBox(height: 12),
                      const Text(
                        '库存记录用于家庭管理，库存存在不等于适合服用。',
                        style: TextStyle(color: AppColors.muted),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                AppCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text(
                            '个人备注',
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          TextButton(
                            onPressed: () => _editNote(medicine),
                            child: const Text('编辑'),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Text(
                        medicine.personalNote.isEmpty
                            ? '还没有备注'
                            : medicine.personalNote,
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 20),
                SoftButton(
                  label: '添加一个批次',
                  icon: Icons.add,
                  onPressed: _addBatch,
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  String _leafletLabel(LeafletReviewStatus status) => switch (status) {
    LeafletReviewStatus.userConfirmed => '本人已核对说明书摘要',
    LeafletReviewStatus.matched => '已匹配资料，等待本人核对',
    LeafletReviewStatus.unverified => '资料未核验',
  };
}

class _PersonalNoteSheet extends StatefulWidget {
  const _PersonalNoteSheet({required this.initialNote});
  final String initialNote;

  @override
  State<_PersonalNoteSheet> createState() => _PersonalNoteSheetState();
}

class _PersonalNoteSheetState extends State<_PersonalNoteSheet> {
  late final TextEditingController controller;

  @override
  void initState() {
    super.initState();
    controller = TextEditingController(text: widget.initialNote);
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Column(
    children: [
      TextField(
        controller: controller,
        maxLines: 4,
        decoration: const InputDecoration(hintText: '只记录家人的实际备注，不自动生成用药方案'),
      ),
      const SizedBox(height: 16),
      PrimaryButton(
        label: '保存备注',
        onPressed: () => Navigator.of(context).pop(controller.text.trim()),
      ),
    ],
  );
}

class _AddBatchSheet extends StatefulWidget {
  const _AddBatchSheet({required this.onSave});
  final void Function(int? quantity, String unit, String expiry) onSave;

  @override
  State<_AddBatchSheet> createState() => _AddBatchSheetState();
}

class _AddBatchSheetState extends State<_AddBatchSheet> {
  final quantityController = TextEditingController();
  final expiryController = TextEditingController();
  final unitController = TextEditingController(text: '盒');

  @override
  void dispose() {
    quantityController.dispose();
    expiryController.dispose();
    unitController.dispose();
    super.dispose();
  }

  void _save() {
    final rawQuantity = quantityController.text.trim();
    int? quantity;
    if (rawQuantity.isNotEmpty) {
      final parsed = int.tryParse(rawQuantity);
      if (parsed == null || parsed < 0) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('数量需为不小于 0 的整数，或留空表示未知')));
        return;
      }
      quantity = parsed;
    }
    widget.onSave(quantity, unitController.text, expiryController.text);
  }

  @override
  Widget build(BuildContext context) => Column(
    children: [
      TextField(
        controller: quantityController,
        keyboardType: TextInputType.number,
        decoration: const InputDecoration(labelText: '数量', hintText: '未知也可以留空'),
      ),
      const SizedBox(height: 12),
      TextField(
        controller: unitController,
        decoration: const InputDecoration(labelText: '数量单位'),
      ),
      const SizedBox(height: 12),
      TextField(
        controller: expiryController,
        decoration: const InputDecoration(
          labelText: '有效期',
          hintText: '例如 2027-12-31',
        ),
      ),
      const SizedBox(height: 16),
      PrimaryButton(label: '保存演示批次', onPressed: _save),
    ],
  );
}

class _BatchRow extends StatelessWidget {
  const _BatchRow({required this.batch});
  final DemoBatch batch;

  @override
  Widget build(BuildContext context) {
    final state = batch.state == ExpiryState.expiringSoon
        ? '临期'
        : batch.state == ExpiryState.unknown
        ? '待补充'
        : '有效';
    return Row(
      children: [
        const Icon(Icons.inventory_2_outlined, color: AppColors.leaf),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '批次 ${batch.lotNumber ?? '未记录'}',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 4),
              Text(
                '库存：${batch.quantity == null ? '数量未知' : '${batch.quantity}${batch.unit}'} · 有效期：${batch.expiry}',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ],
          ),
        ),
        StatusPill(
          label: state,
          color: AppColors.amber,
          background: const Color(0xFFF9ECD7),
        ),
      ],
    );
  }
}
