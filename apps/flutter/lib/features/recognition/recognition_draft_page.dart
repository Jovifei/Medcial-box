import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/widgets/app_surfaces.dart';
import '../../core/widgets/expiry_date_wheel_picker.dart';
import '../../data/demo_repositories.dart';
import '../../data/medicine_recognition.dart';
import '../../models/medicine_models.dart';

class RecognitionDraftPage extends StatefulWidget {
  const RecognitionDraftPage({
    super.key,
    required this.image,
    required this.repository,
    required this.recognitionRepository,
  });
  final XFile image;
  final DemoMedicineRepository repository;
  final MedicineRecognitionRepository recognitionRepository;

  @override
  State<RecognitionDraftPage> createState() => _RecognitionDraftPageState();
}

class _RecognitionDraftPageState extends State<RecognitionDraftPage> {
  final nameController = TextEditingController();
  final specificationController = TextEditingController();
  final expiryController = TextEditingController();
  final quantityController = TextEditingController();
  String? unit;
  MedicineRecognitionDraft? draft;
  Object? failure;
  bool loading = true;

  @override
  void initState() {
    super.initState();
    _recognize();
  }

  @override
  void dispose() {
    nameController.dispose();
    specificationController.dispose();
    expiryController.dispose();
    quantityController.dispose();
    super.dispose();
  }

  Future<void> _recognize() async {
    setState(() {
      loading = true;
      failure = null;
    });
    try {
      final result = await widget.recognitionRepository.recognize(widget.image);
      if (!mounted) return;
      draft = result;
      nameController.text = result.name;
      specificationController.text = result.specification;
      expiryController.text = result.expiry;
      setState(() => loading = false);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        failure = error;
        loading = false;
      });
    }
  }

  void _save() {
    final name = nameController.text.trim();
    if (name.isEmpty) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('请先填写药品名称')));
      return;
    }
    final rawQuantity = quantityController.text.trim();
    final quantity = rawQuantity.isEmpty ? null : int.tryParse(rawQuantity);
    if (rawQuantity.isNotEmpty && (quantity == null || quantity < 0)) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('剩余数量需为非负整数')));
      return;
    }
    if (unit == null) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('请选择库存单位')));
      return;
    }
    widget.repository.addFromDraft(
      name: name,
      specification: specificationController.text.trim().isEmpty
          ? '规格待补充'
          : specificationController.text.trim(),
      expiry: expiryController.text.trim().isEmpty
          ? '待补充'
          : expiryController.text.trim(),
      quantity: quantity,
      unit: unit!,
    );
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('识别结果 · 人工核对')),
      body: AppPage(
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 28),
        child: ListView(
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(22),
              child: Image.file(
                File(widget.image.path),
                height: 220,
                width: double.infinity,
                fit: BoxFit.cover,
              ),
            ),
            const SizedBox(height: 16),
            if (loading)
              const AppCard(
                child: Row(
                  children: [
                    CircularProgressIndicator(),
                    SizedBox(width: 14),
                    Text('正在识别图片文字…'),
                  ],
                ),
              )
            else if (failure != null)
              AppCard(
                color: const Color(0xFFFFF3EF),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '识别失败，但不会影响手动录入。',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      '$failure',
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                    const SizedBox(height: 14),
                    SoftButton(label: '重新识别', onPressed: _recognize),
                  ],
                ),
              )
            else ...[
              if (draft!.warnings.isNotEmpty)
                AppCard(
                  color: const Color(0xFFFFF8E9),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '请核对以下提示',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 8),
                      ...draft!.warnings.map(
                        (warning) => Padding(
                          padding: const EdgeInsets.only(bottom: 4),
                          child: Text(
                            '• $warning',
                            style: Theme.of(context).textTheme.bodyMedium,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              const SizedBox(height: 12),
              AppCard(
                child: Column(
                  children: [
                    TextField(
                      controller: nameController,
                      decoration: const InputDecoration(labelText: '药品名称（必填）'),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: specificationController,
                      decoration: const InputDecoration(
                        labelText: '产品规格（可选，如 20g）',
                      ),
                    ),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      initialValue: unit,
                      hint: const Text('请选择包装单位'),
                      decoration: const InputDecoration(labelText: '库存单位'),
                      items: kQuantityUnitValues
                          .where((value) => value != 'ml')
                          .map(
                            (value) => DropdownMenuItem<String>(
                              value: value,
                              child: Text(unitLabel(value)),
                            ),
                          )
                          .toList(growable: false),
                      onChanged: (value) => setState(() => unit = value),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: quantityController,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                        labelText: '剩余数量（可选）',
                        hintText: '未知可留空',
                      ),
                    ),
                    const SizedBox(height: 12),
                    MedicineDateField(
                      key: const ValueKey('recognition-expiry-field'),
                      valueKey: const ValueKey('recognition-expiry-value'),
                      controller: expiryController,
                      label: '有效期（可选）',
                      onChanged: () => setState(() {}),
                    ),
                    const SizedBox(height: 18),
                    PrimaryButton(
                      label: '核对后保存',
                      icon: Icons.check_rounded,
                      onPressed: _save,
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              Text(
                '识别结果只是草稿，不会自动推断数量、剂量或适合谁服用。',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ],
        ),
      ),
    );
  }
}
