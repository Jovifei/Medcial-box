import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/motion/app_motion.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_surfaces.dart';
import '../../data/demo_repositories.dart';
import '../../data/medicine_recognition.dart';
import '../../models/demo_models.dart';
import '../recognition/recognition_draft_page.dart';

enum _AddAction { camera, gallery, manual }

class HomePage extends StatefulWidget {
  const HomePage({super.key, required this.repository});
  final DemoMedicineRepository repository;

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  String keyword = '';
  final imagePicker = ImagePicker();
  final recognitionRepository = MlKitMedicineRecognitionRepository();

  @override
  void initState() {
    super.initState();
    _recoverLostImage();
  }

  Future<void> _recoverLostImage() async {
    try {
      final lost = await imagePicker.retrieveLostData();
      final files = lost.files;
      if (!mounted || files == null || files.isEmpty) return;
      await _openRecognitionDraft(files.first);
    } catch (_) {
      // Widget tests and non-Android preview targets have no picker channel.
    }
  }

  List<DemoMedicine> get filtered => widget.repository.medicines
      .where(
        (medicine) =>
            medicine.name.contains(keyword) ||
            medicine.purpose.contains(keyword),
      )
      .toList();

  Future<void> _showAddSheet() async {
    final action = await showAppSheet<_AddAction>(
      context,
      title: '录入家里的药',
      builder: (context) {
        return Column(
          children: [
            choiceTile(
              context,
              icon: Icons.camera_alt_rounded,
              title: '拍照识别',
              subtitle: '识别药盒和有效期，进入人工核对',
              onTap: () => Navigator.of(context).pop(_AddAction.camera),
            ),
            const SizedBox(height: 12),
            choiceTile(
              context,
              icon: Icons.photo_library_outlined,
              title: '从相册选择',
              subtitle: '选择一张药盒照片',
              onTap: () => Navigator.of(context).pop(_AddAction.gallery),
              tint: const Color(0xFFF6EAD4),
            ),
            const SizedBox(height: 12),
            choiceTile(
              context,
              icon: Icons.edit_note_rounded,
              title: '手动录入',
              subtitle: '只填名称也可以先保存',
              onTap: () => Navigator.of(context).pop(_AddAction.manual),
            ),
          ],
        );
      },
    );
    if (action == _AddAction.manual && mounted) {
      await _showManualSheet(context);
    } else if (action != null && mounted) {
      await _pickAndRecognize(
        action == _AddAction.camera ? ImageSource.camera : ImageSource.gallery,
      );
    }
  }

  Future<void> _pickAndRecognize(ImageSource source) async {
    try {
      final image = await imagePicker.pickImage(
        source: source,
        imageQuality: 90,
        maxWidth: 1800,
      );
      if (image == null || !mounted) return;
      await _openRecognitionDraft(image);
    } catch (error) {
      if (!mounted) return;
      final message = error.toString().toLowerCase();
      if (message.contains('cancel')) return;
      final permissionDenied =
          message.contains('permission') || message.contains('denied');
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            permissionDenied
                ? '相机或相册权限未开启，请到系统设置允许家庭药箱访问后重试。'
                : '无法打开相机或相册，请重试。',
          ),
        ),
      );
    }
  }

  Future<void> _openRecognitionDraft(XFile image) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (context) => RecognitionDraftPage(
          image: image,
          repository: widget.repository,
          recognitionRepository: recognitionRepository,
        ),
      ),
    );
    if (mounted) setState(() {});
  }

  Future<void> _showManualSheet(BuildContext parentContext) async {
    final controller = TextEditingController();
    final name = await showAppSheet<String>(
      parentContext,
      title: '快速手动录入',
      builder: (context) {
        return Column(
          children: [
            TextField(
              controller: controller,
              autofocus: true,
              decoration: const InputDecoration(
                labelText: '药品名称',
                hintText: '例如：布洛芬缓释胶囊',
              ),
            ),
            const SizedBox(height: 18),
            PrimaryButton(
              label: '保存到演示药箱',
              onPressed: () {
                final value = controller.text.trim();
                if (value.isNotEmpty) Navigator.of(context).pop(value);
              },
            ),
          ],
        );
      },
    );
    if (name != null && parentContext.mounted) {
      widget.repository.addDemoMedicine(name);
      setState(() {});
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('家庭药箱'),
            Text(
              '演示家庭 · Flutter 原型',
              style: TextStyle(
                fontSize: 12,
                color: AppColors.muted,
                fontWeight: FontWeight.w500,
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: '导出 Markdown',
            onPressed: () => context.push('/demo/export'),
            icon: const Icon(Icons.ios_share_rounded),
          ),
          const SizedBox(width: 8),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _showAddSheet,
        icon: const Icon(Icons.add_rounded),
        label: const Text('录入药品'),
      ),
      body: AnimatedBuilder(
        animation: widget.repository,
        builder: (context, child) => AppPage(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 100),
          child: ListView(
            children: [
              Text(
                '家里的药，心里有数。',
                style: Theme.of(context).textTheme.headlineMedium,
              ),
              const SizedBox(height: 6),
              Text(
                '演示数据用于查看交互，库存存在不等于适合服用。',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              const SizedBox(height: 20),
              _StatusSummary(medicines: widget.repository.medicines),
              const SizedBox(height: 18),
              TextField(
                onChanged: (value) => setState(() => keyword = value.trim()),
                decoration: const InputDecoration(
                  prefixIcon: Icon(Icons.search_rounded),
                  hintText: '搜索药名或用途',
                ),
              ),
              const SizedBox(height: 18),
              if (filtered.isEmpty)
                _EmptyState(onAdd: _showAddSheet)
              else
                ...filtered.asMap().entries.map(
                  (entry) =>
                      _MedicineCard(medicine: entry.value, index: entry.key),
                ),
              const SizedBox(height: 20),
              Text(
                '信息只用于家庭库存记录，请以包装说明书和医生或药师指导为准。',
                style: Theme.of(context).textTheme.bodySmall
                    ?.copyWith(color: AppColors.muted),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _StatusSummary extends StatelessWidget {
  const _StatusSummary({required this.medicines});
  final List<DemoMedicine> medicines;

  @override
  Widget build(BuildContext context) {
    final soon = medicines
        .where(
          (medicine) => medicine.batches.any(
            (batch) =>
                batch.state == ExpiryState.expiringSoon ||
                batch.state == ExpiryState.dueThisMonth,
          ),
        )
        .length;
    final unknown = medicines
        .where(
          (medicine) => medicine.batches.any(
            (batch) => batch.state == ExpiryState.unknown,
          ),
        )
        .length;
    return AppCard(
      color: AppColors.mist,
      padding: const EdgeInsets.all(18),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('库存状态', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 4),
                Text(
                  '每个批次独立记录有效期',
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ],
            ),
          ),
          _StatValue(value: '$soon', label: '临期'),
          const SizedBox(width: 18),
          _StatValue(value: '$unknown', label: '待补充', muted: true),
        ],
      ),
    );
  }
}

class _StatValue extends StatelessWidget {
  const _StatValue({
    required this.value,
    required this.label,
    this.muted = false,
  });
  final String value;
  final String label;
  final bool muted;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.end,
    children: [
      Text(
        value,
        style: Theme.of(context).textTheme.headlineMedium
            ?.copyWith(color: muted ? AppColors.muted : AppColors.terracotta),
      ),
      Text(
        label,
        style: Theme.of(context).textTheme.labelMedium
            ?.copyWith(color: AppColors.muted),
      ),
    ],
  );
}

class _MedicineCard extends StatelessWidget {
  const _MedicineCard({required this.medicine, required this.index});
  final DemoMedicine medicine;
  final int index;

  @override
  Widget build(BuildContext context) {
    final batch = medicine.batches.first;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: AppMotion.route + (AppMotion.stagger * index),
      curve: Curves.easeOutCubic,
      builder: (context, value, child) => Opacity(
        opacity: value,
        child: Transform.translate(
          offset: Offset(0, 12 * (1 - value)),
          child: child,
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Hero(
          tag: 'medicine-${medicine.id}',
          child: Material(
            color: Colors.transparent,
            child: InkWell(
              onTap: () => context.push('/demo/medicine/${medicine.id}'),
              borderRadius: BorderRadius.circular(22),
              child: AppCard(
                padding: const EdgeInsets.all(18),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            medicine.name,
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          const SizedBox(height: 6),
                          Text(
                            medicine.specification,
                            style: Theme.of(context).textTheme.bodyMedium,
                          ),
                          const SizedBox(height: 13),
                          Text(
                            '库存：${batch.quantity == null ? '数量未知' : '${batch.quantity}${batch.unit}'}',
                            style: Theme.of(context).textTheme.bodyMedium
                                ?.copyWith(color: AppColors.ink),
                          ),
                        ],
                      ),
                    ),
                    _ExpiryBadge(state: batch.state, expiry: batch.expiry),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ExpiryBadge extends StatelessWidget {
  const _ExpiryBadge({required this.state, required this.expiry});
  final ExpiryState state;
  final String expiry;

  @override
  Widget build(BuildContext context) {
    final (label, color, background) = switch (state) {
      ExpiryState.expired => (
        '已过期',
        AppColors.terracotta,
        const Color(0xFFF7E3DA),
      ),
      ExpiryState.dueThisMonth || ExpiryState.expiringSoon => (
        '临期',
        AppColors.amber,
        const Color(0xFFF9ECD7),
      ),
      ExpiryState.ok => ('有效', AppColors.leaf, const Color(0xFFE2EFE6)),
      ExpiryState.unknown => ('待补充', AppColors.muted, const Color(0xFFEDEFEA)),
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        StatusPill(label: label, color: color, background: background),
        const SizedBox(height: 9),
        Text(
          expiry,
          style: Theme.of(context).textTheme.labelMedium
              ?.copyWith(color: AppColors.muted),
        ),
      ],
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.onAdd});
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) => AppCard(
    child: Column(
      children: [
        const Icon(
          Icons.inventory_2_outlined,
          size: 42,
          color: AppColors.muted,
        ),
        const SizedBox(height: 12),
        Text('没有匹配的药品', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 6),
        Text('可以换个关键词，或先录入一种药。', style: Theme.of(context).textTheme.bodyMedium),
        const SizedBox(height: 16),
        SoftButton(label: '录入药品', onPressed: onAdd),
      ],
    ),
  );
}
