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
  Future<void> _editNote(DemoMedicine medicine) async {
    final controller = TextEditingController(text: medicine.personalNote);
    final note = await showAppSheet<String>(
      context,
      title: '个人剂量备注',
      builder: (context) => Column(
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
      ),
    );
    if (note != null) setState(() {});
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
        future: widget.repository.getMedicine(widget.medicineId),
        builder: (context, snapshot) {
          if (!snapshot.hasData) {
            return const Center(child: CircularProgressIndicator());
          }
          final medicine = snapshot.data!;
          final batch = medicine.batches.first;
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
                      _BatchRow(batch: batch),
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
                  onPressed: () => showAppSheet<void>(
                    context,
                    title: '添加批次',
                    builder: (context) => Column(
                      children: [
                        const TextField(
                          decoration: InputDecoration(
                            labelText: '数量',
                            hintText: '未知也可以先保存',
                          ),
                        ),
                        const SizedBox(height: 12),
                        const TextField(
                          decoration: InputDecoration(
                            labelText: '有效期',
                            hintText: '例如 2027-12-31',
                          ),
                        ),
                        const SizedBox(height: 16),
                        PrimaryButton(
                          label: '保存演示批次',
                          onPressed: () => Navigator.pop(context),
                        ),
                      ],
                    ),
                  ),
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
