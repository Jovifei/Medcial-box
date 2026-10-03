import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_surfaces.dart';
import '../../core/widgets/expiry_date_wheel_picker.dart';
import '../../core/widgets/medicine_tags.dart';
import '../../data/api_client.dart';
import '../../data/api_medicine_repository.dart';
import '../../data/api_workflow_repository.dart';
import '../../models/medicine_models.dart';

bool shouldSplitBatchOpening(BatchRecord batch, double openedQuantity) =>
    batch.openedState == 'unopened' && batch.quantity != null &&
    openedQuantity > 0 && batch.quantity! > openedQuantity;

class MedicineDetailApiPage extends StatefulWidget {
  const MedicineDetailApiPage({
    super.key,
    required this.repository,
    required this.workflow,
    required this.medicineId,
  });
  final ApiMedicineRepository repository;
  final ApiWorkflowRepository workflow;
  final String medicineId;

  @override
  State<MedicineDetailApiPage> createState() => _MedicineDetailApiPageState();
}

class _MedicineDetailApiPageState extends State<MedicineDetailApiPage> {
  late Future<MedicineRecord> medicineFuture;
  List<DosageNoteRecord> notes = const [];
  Object? notesFailure;
  bool submitting = false;

  @override
  void initState() {
    super.initState();
    medicineFuture = widget.repository.getMedicine(widget.medicineId);
    _loadNotes();
  }

  void _reload() {
    setState(() => medicineFuture = widget.repository.getMedicine(widget.medicineId));
    _loadNotes();
  }

  Future<void> _loadNotes() async {
    try {
      final result = await widget.repository.listDosageNotes(widget.medicineId);
      if (mounted) setState(() { notes = result; notesFailure = null; });
    } catch (error) {
      if (mounted) setState(() => notesFailure = error);
    }
  }

  Future<void> _editTags(MedicineRecord medicine) async {
    final populations = medicine.populationTags.toSet();
    final purposes = medicine.purposeTags.toSet();
    final result = await showAppSheet<bool>(
      context,
      title: '补充用途与分类',
      builder: (context) => StatefulBuilder(
        builder: (context, update) => Column(
          children: [
            MedicineTagFields(
              populations: populations,
              purposes: purposes,
              onChanged: () => update(() {}),
            ),
            const SizedBox(height: 14),
            PrimaryButton(
              label: '保存分类',
              onPressed: () => Navigator.pop(context, true),
            ),
          ],
        ),
      ),
    );
    if (result != true || !mounted) return;
    setState(() => submitting = true);
    try {
      await widget.repository.updateMedicine(
        medicine.copyWith(
          populationTags: populations.toList(),
          purposeTags: purposes.toList(),
          tagSource: 'user',
        ),
      );
      _reload();
    } catch (error) {
      if (mounted) _error(error);
    } finally {
      if (mounted) setState(() => submitting = false);
    }
  }

  Future<void> _addBatch(MedicineRecord medicine) async {
    final draft = await showAppSheet<_BatchDraft>(
      context,
      title: '新增库存批次',
      builder: (_) => const _BatchDraftForm(),
    );
    if (draft == null || !mounted) return;
    setState(() => submitting = true);
    try {
      await widget.repository.createBatch(medicine.id, draft.toPayload());
      _reload();
    } catch (error) {
      if (mounted) _error(error);
    } finally {
      if (mounted) setState(() => submitting = false);
    }
  }

  Future<void> _editQuantity(MedicineRecord medicine, BatchRecord batch) async {
    final result = await showAppSheet<_BatchDraft>(
      context,
      title: '修改库存批次',
      builder: (_) => _BatchDraftForm(batch: batch),
    );
    if (result == null || !mounted) return;
    setState(() => submitting = true);
    try {
      await widget.repository.updateBatch(
        medicine.id,
        batch.copyWith(
          quantity: result.quantity,
          unit: result.unit,
          clearConversion: result.unit != batch.unit,
          expiryValue: result.expiry,
          expiryPrecision: result.precision,
          lotNumber: result.lotNumber,
          clearLotNumber: result.lotNumber == null,
          storageLocation: result.storageLocation,
          clearStorageLocation: result.storageLocation == null,
        ),
      );
      _reload();
    } catch (error) {
      if (mounted) _error(error);
    } finally {
      if (mounted) setState(() => submitting = false);
    }
  }

  Future<void> _markOpened(MedicineRecord medicine, BatchRecord batch) async {
    final draft = await showAppSheet<_OpeningDraft>(
      context,
      title: '记录开封信息',
      builder: (_) => _OpeningDraftForm(batch: batch),
    );
    if (draft == null || !mounted) return;
    setState(() => submitting = true);
    try {
      if (shouldSplitBatchOpening(batch, draft.splitQuantity)) {
        await widget.repository.splitAndOpenBatch(
          medicine: medicine,
          batch: batch,
          openedQuantity: draft.splitQuantity,
          openedAt: draft.openedAt,
          afterOpeningLimit: draft.limit,
        );
      } else {
        await widget.repository.updateBatch(
          medicine.id,
          batch.copyWith(
            openedState: 'opened',
            openedAt: draft.openedAt,
            afterOpeningLimit: draft.limit,
          ),
        );
      }
      _reload();
    } catch (error) {
      if (mounted) _error(error);
    } finally {
      if (mounted) setState(() => submitting = false);
    }
  }

  Future<void> _editThreshold(MedicineRecord medicine) async {
    final result = await showAppSheet<_ThresholdResult>(
      context,
      title: '库存不足提醒',
      builder: (_) => _ThresholdForm(initial: medicine.lowStockThreshold),
    );
    if (result == null || !mounted) return;
    setState(() => submitting = true);
    try {
      await widget.repository.updateMedicine(
        medicine.copyWith(
          lowStockThreshold: result.enabled
              ? StockThreshold(quantity: result.quantity.toDouble(), unit: result.unit)
              : null,
          clearLowStockThreshold: !result.enabled,
        ),
      );
      _reload();
    } catch (error) {
      if (mounted) _error(error);
    } finally {
      if (mounted) setState(() => submitting = false);
    }
  }

  Future<void> _editNote(MedicineRecord medicine) async {
    final mine = notes.where((note) => note.isMine).firstOrNull;
    final content = await showAppSheet<String>(
      context,
      title: '个人剂量备注',
      builder: (_) => _PersonalNoteForm(initial: mine?.content ?? ''),
    );
    if (content == null || !mounted) return;
    setState(() => submitting = true);
    try {
      if (mine == null) {
        await widget.repository.createDosageNote(medicine.id, content: content);
      } else {
        await widget.repository.updateDosageNote(medicine.id, mine, content: content);
      }
      await _loadNotes();
    } catch (error) {
      if (mounted) _error(error);
    } finally {
      if (mounted) setState(() => submitting = false);
    }
  }

  Future<void> _addRestock(MedicineRecord medicine) async {
    final units = medicine.lowStockThreshold?.unit ?? medicine.batches.firstOrNull?.unit ?? 'box';
    final quantity = medicine.lowStockThreshold?.quantity;
    try {
      await widget.workflow.addRestockItem(
        medicineId: medicine.id,
        desiredQuantity: quantity,
        unit: units,
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已加入家庭补货清单')));
      }
    } catch (error) {
      if (mounted) _error(error);
    }
  }

  Future<void> _archive(MedicineRecord medicine) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('归档这项药品？'),
        content: Text('“${medicine.name}”将从当前药箱移至归档记录，可在后续恢复。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('归档')),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await widget.repository.archiveMedicine(medicine.id);
      if (mounted) context.pop();
    } catch (error) {
      if (mounted) _error(error);
    }
  }

  Future<void> _trashBatch(MedicineRecord medicine, BatchRecord batch) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('移入回收站？'),
        content: const Text('这个批次会从当前库存隐藏，可在“我的 → 回收站”中恢复。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('移入回收站')),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await widget.repository.deleteBatch(medicine.id, batch.id);
      _reload();
    } catch (error) {
      if (mounted) _error(error);
    }
  }

  void _error(Object error) => ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(content: Text(friendlyApiError(error))),
  );

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('药品详情'),
      actions: [
        PopupMenuButton<String>(
          tooltip: '更多操作',
          onSelected: (value) async {
            if (value == 'tags') {
              final medicine = await medicineFuture;
              if (mounted && !submitting) _editTags(medicine);
            }
            if (value == 'archive') {
              final medicine = await medicineFuture;
              if (mounted) _archive(medicine);
            }
          },
          itemBuilder: (_) => const [PopupMenuItem(value: 'tags', child: Text('补充用途与分类')), PopupMenuItem(value: 'archive', child: Text('归档药品'))],
        ),
      ],
    ),
    body: FutureBuilder<MedicineRecord>(
      future: medicineFuture,
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
                  Text(snapshot.hasError ? friendlyApiError(snapshot.error!) : '找不到这项药品'),
                  const SizedBox(height: 12),
                  SoftButton(label: '返回药箱', onPressed: () => context.pop()),
                ],
              ),
            ),
          );
        }
        final medicine = snapshot.data!;
        return Stack(
          children: [
            AppPage(
              padding: const EdgeInsets.fromLTRB(18, 10, 18, 30),
              child: ListView(
                children: [
                  AppCard(
                    color: const Color(0xFFE9F1EB),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(medicine.name, style: Theme.of(context).textTheme.headlineSmall),
                        const SizedBox(height: 6),
                        Text(medicine.specificationDisplay),
                        const SizedBox(height: 12),
                        InkWell(
                          onTap: submitting ? null : () => _editTags(medicine),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(vertical: 8),
                            child: Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    medicine.purposeTags.isEmpty
                                        ? medicine.purpose
                                        : medicine.purposeTags
                                              .map(
                                                (v) =>
                                                    medicinePurposeLabels[v] ??
                                                    v,
                                              )
                                              .join(' · '),
                                    style: Theme.of(context)
                                        .textTheme
                                        .titleMedium
                                        ?.copyWith(color: AppColors.leafDeep),
                                  ),
                                ),
                                const Icon(Icons.edit_outlined),
                              ],
                            ),
                          ),
                        ),
                        const SizedBox(height: 6),
                        Text('资料状态：${_leafletStatus(medicine.leaflet.reviewStatus)}'),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  AppCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(child: Text('库存批次', style: Theme.of(context).textTheme.titleLarge)),
                            IconButton(tooltip: '添加批次', onPressed: submitting ? null : () => _addBatch(medicine), icon: const Icon(Icons.add_circle_outline_rounded)),
                          ],
                        ),
                        if (medicine.batches.isEmpty)
                          const Padding(padding: EdgeInsets.symmetric(vertical: 10), child: Text('暂无库存批次。'))
                        else
                          ...medicine.batches.map((batch) => _BatchCard(
                            batch: batch,
                            onQuantity: () => _editQuantity(medicine, batch),
                            onOpen: batch.openedState == 'opened' ? null : () => _markOpened(medicine, batch),
                            onTrash: () => _trashBatch(medicine, batch),
                          )),
                        const SizedBox(height: 4),
                        SoftButton(label: '新增一个批次', icon: Icons.add, onPressed: submitting ? null : () => _addBatch(medicine)),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  AppCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(child: Text('库存提醒', style: Theme.of(context).textTheme.titleMedium)),
                            TextButton(onPressed: submitting ? null : () => _editThreshold(medicine), child: const Text('设置')),
                          ],
                        ),
                        Text(medicine.lowStockThreshold == null
                            ? '未开启低库存提醒'
                            : '当库存 ≤ ${quantityText(medicine.lowStockThreshold!.quantity)}${unitLabel(medicine.lowStockThreshold!.unit)} 时提示 · 当前状态：${_stockLabel(medicine.stockStatus)}'),
                        if (medicine.stockStatus == 'unknown')
                          const Padding(padding: EdgeInsets.only(top: 5), child: Text('含未知数量或无法换算单位时，库存状态会显示待核对。')),
                        const SizedBox(height: 8),
                        SoftButton(label: '加入补货清单', icon: Icons.shopping_cart_outlined, onPressed: () => _addRestock(medicine)),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  AppCard(
                    child: ExpansionTile(
                      tilePadding: EdgeInsets.zero,
                      title: Text('说明书与资料来源', style: Theme.of(context).textTheme.titleMedium),
                      subtitle: Text(_leafletStatus(medicine.leaflet.reviewStatus)),
                      children: [
                        _InfoLine(label: '用途摘要', value: medicine.leaflet.purposeSummary),
                        _InfoLine(label: '说明书用法用量', value: medicine.leaflet.packageUsageSummary),
                        _InfoLine(label: '禁忌', value: medicine.leaflet.contraindicationsSummary),
                        _InfoLine(label: '注意事项', value: medicine.leaflet.precautionsSummary),
                        _InfoLine(label: '资料来源', value: medicine.leaflet.source),
                        const Padding(padding: EdgeInsets.only(bottom: 8), child: Text('联网资料或图片内容仍需按厂家、规格和批准文号人工核对。')),
                        Padding(
                          padding: const EdgeInsets.only(bottom: 10),
                          child: SoftButton(
                            label: '查看或添加说明书照片',
                            icon: Icons.photo_library_outlined,
                            onPressed: () => context.push('/medicine/${medicine.id}/leaflet-photos'),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  AppCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(child: Text('个人剂量备注', style: Theme.of(context).textTheme.titleMedium)),
                            TextButton(onPressed: submitting ? null : () => _editNote(medicine), child: Text(notes.any((note) => note.isMine) ? '编辑' : '添加')),
                          ],
                        ),
                        if (notesFailure != null)
                          Text('备注暂时无法加载：${friendlyApiError(notesFailure!)}')
                        else if (notes.where((note) => note.isMine).isEmpty)
                          const Text('只显示你自己的个人备注；默认不导出。')
                        else
                          Text(notes.firstWhere((note) => note.isMine).content),
                        const SizedBox(height: 6),
                        const Text('此备注用于家庭记录，不由系统生成或验证用药方案。', style: TextStyle(color: AppColors.muted)),
                      ],
                    ),
                  ),
                  const SizedBox(height: 14),
                  Text('药品库存仅用于记录；请以包装说明书和专业医护人员意见为准。', style: Theme.of(context).textTheme.bodySmall),
                ],
              ),
            ),
            if (submitting)
              const Positioned.fill(
                child: ColoredBox(
                  color: Color(0x22000000),
                  child: Center(child: CircularProgressIndicator()),
                ),
              ),
          ],
        );
      },
    ),
  );
}

class _BatchCard extends StatelessWidget {
  const _BatchCard({required this.batch, required this.onQuantity, required this.onOpen, required this.onTrash});
  final BatchRecord batch;
  final VoidCallback onQuantity;
  final VoidCallback? onOpen;
  final VoidCallback onTrash;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(top: 10, bottom: 6),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(color: const Color(0xFFF7F9F6), borderRadius: BorderRadius.circular(15), border: Border.all(color: AppColors.line)),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(child: Text('批次 ${batch.lotNumber ?? '未记录'}', style: Theme.of(context).textTheme.titleMedium)),
            PopupMenuButton<String>(
              tooltip: '批次操作',
              onSelected: (value) { if (value == 'trash') onTrash(); if (value == 'edit') onQuantity(); },
              itemBuilder: (_) => const [PopupMenuItem(value: 'edit', child: Text('修改库存批次')), PopupMenuItem(value: 'trash', child: Text('移入回收站'))],
            ),
          ],
        ),
        Text('余量：${batch.quantityDisplay}'),
        Text('包装有效期：${batch.expiryDisplay}（${batch.expiryPrecision == 'month' ? '精确到月' : batch.expiryPrecision == 'day' ? '精确到日' : '未知'}）'),
        Text('开封状态：${_openedLabel(batch.openedState)}${batch.openedAt == null ? '' : ' · ${batch.openedAt}'}'),
        if (batch.afterOpeningLimit != null)
          Text('开封期限：${batch.afterOpeningLimit!.isDate ? batch.afterOpeningLimit!.date : '${batch.afterOpeningLimit!.value}${batch.afterOpeningLimit!.unit == 'month' ? '个月' : '天'}'} · ${batch.afterOpeningLimit!.source ?? '来源待核对'}'),
        if (batch.managementExpiryDate != null)
          Text('建议管理期限：${batch.managementExpiryDate}（${batch.managementExpirySource == 'opened' ? '开封期限' : '包装有效期'}）'),
        if (batch.storageLocation?.isNotEmpty == true) Text('位置：${batch.storageLocation}'),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 6,
          children: [
            OutlinedButton.icon(onPressed: onQuantity, icon: const Icon(Icons.edit_outlined), label: const Text('修改库存批次')),
            if (onOpen != null)
              OutlinedButton.icon(onPressed: onOpen, icon: const Icon(Icons.lock_open_outlined), label: const Text('标记开封')),
          ],
        ),
      ],
    ),
  );
}

class _BatchDraft {
  const _BatchDraft({required this.quantity, required this.unit, required this.expiry, required this.precision, required this.lotNumber, required this.storageLocation});
  final double? quantity;
  final String unit;
  final String? expiry;
  final String precision;
  final String? lotNumber;
  final String? storageLocation;

  Map<String, Object?> toPayload() => {
    'quantity': quantity,
    'unit': unit,
    'lotNumber': lotNumber,
    'expiry': {'value': expiry, 'precision': precision},
    'storageLocation': storageLocation,
    'openedState': 'unknown',
  };
}

class _BatchDraftForm extends StatefulWidget {
  const _BatchDraftForm({this.batch});
  final BatchRecord? batch;
  @override
  State<_BatchDraftForm> createState() => _BatchDraftFormState();
}

class _BatchDraftFormState extends State<_BatchDraftForm> {
  late final quantity = TextEditingController(
    text: widget.batch?.quantity == null
        ? ''
        : quantityText(widget.batch!.quantity),
  );
  late final expiry = TextEditingController(
    text: widget.batch?.expiryValue ?? '',
  );
  late final lot = TextEditingController(text: widget.batch?.lotNumber ?? '');
  late final location = TextEditingController(
    text: widget.batch?.storageLocation ?? '',
  );
  late String unit = widget.batch?.unit ?? 'box';
  late String precision = widget.batch?.expiryPrecision == 'month'
      ? 'month'
      : 'day';
  Future<void> _invalid(String message) => showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('请核对批次信息'),
      content: Text(message),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('知道了'),
        ),
      ],
    ),
  );

  @override
  void dispose() {
    quantity.dispose();
    expiry.dispose();
    lot.dispose();
    location.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Column(
    children: [
      TextField(
        controller: quantity,
        keyboardType: const TextInputType.numberWithOptions(decimal: true),
        decoration: const InputDecoration(labelText: '数量（必填）'),
      ),
      const SizedBox(height: 10),
      DropdownButtonFormField<String>(
        initialValue: unit,
        decoration: const InputDecoration(labelText: '单位'),
        items: kQuantityUnitValues
            .map(
              (value) => DropdownMenuItem<String>(
                value: value,
                child: Text(unitLabel(value)),
              ),
            )
            .toList(growable: false),
        onChanged: (value) => setState(() => unit = value ?? 'box'),
      ),
      const SizedBox(height: 10),
      MedicineDateField(
        controller: expiry,
        label: '包装有效期（必填）',
        precision: precision,
        onChanged: () => setState(() {}),
      ),
      SegmentedButton<String>(
        segments: const [
          ButtonSegment(value: 'day', label: Text('精确到日')),
          ButtonSegment(value: 'month', label: Text('精确到月')),
        ],
        selected: {precision},
        onSelectionChanged: (v) => setState(() {
          precision = v.first;
          if (expiry.text.isNotEmpty) {
            expiry.text = formatExpiryDate(
              expiryDateForPicker(expiry.text),
              precision: precision,
            );
          }
        }),
      ),
      const SizedBox(height: 10),
      TextField(
        controller: lot,
        decoration: const InputDecoration(labelText: '批号（选填）'),
      ),
      const SizedBox(height: 10),
      TextField(
        controller: location,
        decoration: const InputDecoration(labelText: '存放位置（选填）'),
      ),
      const SizedBox(height: 14),
      PrimaryButton(
        label: widget.batch == null ? '新增批次' : '保存修改',
        onPressed: () {
          final rawQuantity = quantity.text.trim();
          // R08：按单位解析——毫升允许最多 3 位小数，计件单位要求非负整数；空＝未知。
          final parsed = rawQuantity.isEmpty
              ? null
              : parseQuantityByUnit(rawQuantity, unit);
          if (parsed == null) {
            _invalid(
              rawQuantity.isEmpty ? '请填写数量并选择单位。' : quantityInputError(unit),
            );
            return;
          }
          final rawExpiry = expiry.text.trim();
          final precision = this.precision;
          if (rawExpiry.isEmpty || !_validExpiry(rawExpiry, precision)) {
            _invalid('请选择包装有效期；精确到月或日请按实物标注核对。');
            return;
          }
          Navigator.pop(
            context,
            _BatchDraft(
              quantity: parsed,
              unit: unit,
              expiry: rawExpiry.isEmpty ? null : rawExpiry,
              precision: precision,
              lotNumber: _nullableText(lot.text),
              storageLocation: _nullableText(location.text),
            ),
          );
        },
      ),
    ],
  );
}

class _OpeningDraft {
  const _OpeningDraft({required this.openedAt, required this.splitQuantity, this.limit});
  final String openedAt;
  final double splitQuantity;
  final AfterOpeningLimit? limit;
}

class _OpeningDraftForm extends StatefulWidget {
  const _OpeningDraftForm({required this.batch});
  final BatchRecord batch;
  @override
  State<_OpeningDraftForm> createState() => _OpeningDraftFormState();
}

class _OpeningDraftFormState extends State<_OpeningDraftForm> {
  late final date = TextEditingController(text: widget.batch.openedAt ?? _date(DateTime.now()));
  final value = TextEditingController();
  final expiryDate = TextEditingController();
  final split = TextEditingController(text: '1');
  String unit = 'day';
  String kind = 'duration';
  @override
  void dispose() { date.dispose(); value.dispose(); expiryDate.dispose(); split.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) => Column(
    children: [
      MedicineDateField(controller: date, label: '开封日期', onChanged: () => setState(() {})),
      if (widget.batch.openedState == 'unopened' &&
          widget.batch.quantity != null && widget.batch.quantity! > 1) ...[
        const SizedBox(height: 10),
        TextField(controller: split, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: InputDecoration(labelText: '从未开封库存拆出数量（${unitLabel(widget.batch.unit)}）', hintText: '默认 1')),
        const Padding(padding: EdgeInsets.only(top: 5), child: Text('拆分将通过一次药品版本更新同时保存，原批次的有效期和批号会保留。')),
      ] else if (widget.batch.openedState != 'unopened' &&
          widget.batch.quantity != null && widget.batch.quantity! > 1) ...[
        const SizedBox(height: 8),
        const Text('开封状态尚未核实。本次会将整批记录为已开封，不会拆分余量；如只开封了部分，请先核实并标记该批次为未开封。'),
      ],
      const SizedBox(height: 10),
      SegmentedButton<String>(
        segments: const [ButtonSegment(value: 'duration', label: Text('按经过时长')), ButtonSegment(value: 'date', label: Text('直接截止日期'))],
        selected: {kind},
        onSelectionChanged: (values) => setState(() => kind = values.first),
      ),
      const SizedBox(height: 10),
      if (kind == 'duration')
        Row(children: [
          Expanded(child: TextField(controller: value, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: '开封后期限', hintText: '不确定留空'))),
          const SizedBox(width: 8),
          Expanded(child: DropdownButtonFormField<String>(initialValue: unit, decoration: const InputDecoration(labelText: '单位'), items: const [DropdownMenuItem(value: 'day', child: Text('天')), DropdownMenuItem(value: 'month', child: Text('月'))], onChanged: (v) => setState(() => unit = v ?? 'day'))),
        ])
      else
        MedicineDateField(controller: expiryDate, label: '开封后截止日期（选填）', onChanged: () => setState(() {})),
      const SizedBox(height: 14),
      PrimaryButton(label: widget.batch.openedState != 'unopened' &&
          widget.batch.quantity != null && widget.batch.quantity! > 1 ? '确认整批已开封' : '保存开封信息', onPressed: () {
        final openDate = date.text.trim();
        if (!_validExpiry(openDate, 'day')) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('请填写有效的开封日期。')));
          return;
        }
        final splitRaw = split.text.trim();
        // R08：拆出数量按批次单位解析——毫升可小数，计件单位必须整数；留空默认 1。
        final splitQuantity = splitRaw.isEmpty ? 1.0 : parseQuantityByUnit(splitRaw, widget.batch.unit);
        if (splitQuantity == null) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(quantityInputError(widget.batch.unit, prefix: '拆分数量'))));
          return;
        }
        if (widget.batch.openedState == 'unopened' && widget.batch.quantity != null && widget.batch.quantity! > 1 && (splitQuantity <= 0 || splitQuantity >= widget.batch.quantity!)) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('拆分数量需大于 0 且小于当前批次余量，须保留正余量。')));
          return;
        }
        AfterOpeningLimit? limit;
        if (kind == 'date') {
          final raw = expiryDate.text.trim();
          if (raw.isNotEmpty && !_validExpiry(raw, 'day')) {
            ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('开封后截止日期无效。')));
            return;
          }
          if (raw.isNotEmpty) limit = AfterOpeningLimit.date(date: raw, source: 'user');
        } else {
          final raw = value.text.trim();
          final parsed = raw.isEmpty ? null : int.tryParse(raw);
          if (raw.isNotEmpty && (parsed == null || parsed <= 0)) {
            ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('开封期限请输入正整数。')));
            return;
          }
          if (parsed != null) limit = AfterOpeningLimit.duration(value: parsed, unit: unit, source: 'user');
        }
        Navigator.pop(context, _OpeningDraft(openedAt: openDate, splitQuantity: splitQuantity, limit: limit));
      }),
    ],
  );
}

class _ThresholdResult {
  const _ThresholdResult({required this.enabled, required this.quantity, required this.unit});
  final bool enabled;
  final double quantity;
  final String unit;
}

class _ThresholdForm extends StatefulWidget {
  const _ThresholdForm({required this.initial});
  final StockThreshold? initial;
  @override
  State<_ThresholdForm> createState() => _ThresholdFormState();
}

class _ThresholdFormState extends State<_ThresholdForm> {
  // R08：整数阈值回显"10"而不是"10.0"。
  late final controller = TextEditingController(text: widget.initial == null ? '2' : quantityText(widget.initial!.quantity));
  late String unit = widget.initial?.unit ?? 'box';
  bool enabled = true;
  @override
  void dispose() { controller.dispose(); super.dispose(); }
  @override
  Widget build(BuildContext context) => Column(
    children: [
      SwitchListTile.adaptive(title: const Text('开启低库存提醒'), value: enabled, onChanged: (value) => setState(() => enabled = value)),
      if (enabled) ...[
        TextField(controller: controller, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: '提醒阈值', helperText: '库存小于或等于此值时提示')),
        const SizedBox(height: 10),
        DropdownButtonFormField<String>(initialValue: unit, decoration: const InputDecoration(labelText: '阈值单位'), items: kQuantityUnitValues.map((value) => DropdownMenuItem<String>(value: value, child: Text(unitLabel(value)))).toList(growable: false), onChanged: (value) => setState(() => unit = value ?? 'box')),
        const SizedBox(height: 8),
        const Text('不同单位仅在有用户确认的包装换算数时合计；未知数量会显示为“库存待核对”。'),
      ],
      const SizedBox(height: 12),
      PrimaryButton(label: '保存提醒设置', onPressed: () {
        // R08：阈值按单位解析——毫升可小数，计件单位必须整数；关闭时忽略输入。
        final quantity = parseQuantityByUnit(controller.text, unit);
        if (enabled && quantity == null) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(unitAllowsDecimals(unit) ? '阈值请输入不小于 0 的数字（毫升最多 3 位小数）。' : '阈值请输入 0 或正整数。')));
          return;
        }
        Navigator.pop(context, _ThresholdResult(enabled: enabled, quantity: quantity ?? 0, unit: unit));
      }),
    ],
  );
}

class _PersonalNoteForm extends StatefulWidget {
  const _PersonalNoteForm({required this.initial});
  final String initial;
  @override
  State<_PersonalNoteForm> createState() => _PersonalNoteFormState();
}

class _PersonalNoteFormState extends State<_PersonalNoteForm> {
  late final controller = TextEditingController(text: widget.initial);
  @override
  void dispose() { controller.dispose(); super.dispose(); }
  @override
  Widget build(BuildContext context) => Column(
    children: [
      TextField(controller: controller, maxLines: 4, decoration: const InputDecoration(hintText: '只记录家庭个人备注，不自动生成用药方案。')),
      const SizedBox(height: 12),
      PrimaryButton(label: '保存备注', onPressed: () {
        if (controller.text.trim().isNotEmpty) Navigator.pop(context, controller.text.trim());
      }),
    ],
  );
}

class _InfoLine extends StatelessWidget {
  const _InfoLine({required this.label, required this.value});
  final String label;
  final String? value;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [SizedBox(width: 96, child: Text(label, style: const TextStyle(color: AppColors.muted))), Expanded(child: Text(value?.isNotEmpty == true ? value! : '待补充'))]),
  );
}

String _stockLabel(String value) => switch (value) {
  'low' => '库存不足',
  'exhausted' => '已用完',
  'ok' => '充足',
  _ => '待核对',
};

String _openedLabel(String value) => switch (value) {
  'opened' => '已开封',
  'unopened' => '未开封',
  _ => '未记录',
};

String _leafletStatus(String value) => switch (value) {
  'matched' => '已匹配资料，等待本人核对',
  'user_confirmed' => '本人已核对资料',
  _ => '资料未核验',
};

String? _nullableText(String value) => value.trim().isEmpty ? null : value.trim();

String _date(DateTime value) =>
    '${value.year.toString().padLeft(4, '0')}-${value.month.toString().padLeft(2, '0')}-${value.day.toString().padLeft(2, '0')}';

bool _validExpiry(String value, String precision) {
  final monthMatch = RegExp(r'^(\d{4})-(\d{2})$').firstMatch(value);
  if (precision == 'month' && monthMatch != null) {
    final month = int.parse(monthMatch.group(2)!);
    return month >= 1 && month <= 12;
  }
  final date = DateTime.tryParse(value);
  if (precision != 'day' || date == null || value.length != 10) return false;
  return _date(date) == value;
}
