import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../core/widgets/app_surfaces.dart';
import '../../data/api_client.dart';
import '../../data/api_medicine_repository.dart';
import '../../models/medicine_models.dart';

/// Edits a fresh, versioned copy of one medicine within its original family.
class MedicineEditDetailsPage extends StatefulWidget {
  const MedicineEditDetailsPage({
    super.key,
    required this.repository,
    required this.medicineId,
  });

  final ApiMedicineRepository repository;
  final String medicineId;

  @override
  State<MedicineEditDetailsPage> createState() =>
      _MedicineEditDetailsPageState();
}

class _MedicineEditDetailsPageState extends State<MedicineEditDetailsPage> {
  final _name = TextEditingController();
  final _brand = TextEditingController();
  final _specification = TextEditingController();
  final _manufacturer = TextEditingController();
  final _approval = TextEditingController();
  final _ingredients = TextEditingController();
  final _purpose = TextEditingController();
  final _usage = TextEditingController();
  final _contraindications = TextEditingController();
  final _precautions = TextEditingController();
  late final int _epoch;
  late final String? _scope;
  MedicineRecord? _medicine;
  Object? _failure;
  bool _stale = false;
  bool _dirty = false;
  bool _saving = false;
  bool _allowExit = false;
  bool _ingredientsTouched = false;

  ApiClient get _api => widget.repository.api;
  bool get _current =>
      mounted &&
      !_stale &&
      _scope != null &&
      _api.identityEpoch == _epoch &&
      _api.identityState?.scopeSignal.value == _scope &&
      _api.identityState?.owner?.familyId != null;

  @override
  void initState() {
    super.initState();
    _epoch = _api.identityEpoch;
    _scope = _api.identityState?.scopeSignal.value;
    _api.identityEpochSignal.addListener(_identityChanged);
    _api.identityState?.scopeSignal.addListener(_identityChanged);
    if (_scope == null || _api.identityState?.owner?.familyId == null) {
      _stale = true;
    } else {
      _load();
    }
  }

  void _identityChanged() {
    if (!_current && mounted && !_stale) setState(() => _stale = true);
  }

  Future<void> _load() async {
    try {
      final medicine = await widget.repository.getMedicine(
        widget.medicineId,
        isCurrent: () => _current,
      );
      if (!_current) return;
      _name.text = medicine.name;
      _brand.text = medicine.brand ?? '';
      _specification.text = medicine.specification ?? '';
      _manufacturer.text = medicine.manufacturer ?? '';
      _approval.text = medicine.approvalNumber ?? '';
      _ingredients.text = medicine.activeIngredients.join('，');
      _purpose.text = medicine.leaflet.purposeSummary ?? '';
      _usage.text = medicine.leaflet.packageUsageSummary ?? '';
      _contraindications.text = medicine.leaflet.contraindicationsSummary ?? '';
      _precautions.text = medicine.leaflet.precautionsSummary ?? '';
      setState(() {
        _medicine = medicine;
        _failure = null;
      });
    } catch (error) {
      if (_current) setState(() => _failure = error);
    }
  }

  String? _optional(TextEditingController controller, String? original) {
    final value = controller.text.trim();
    if (value == (original ?? '').trim()) return original;
    return value.isEmpty ? null : value;
  }

  String _errorText(Object error) {
    if (error is FormatException) return error.message;
    if (error is ApiException && error.statusCode == 409) {
      return '版本冲突：这条记录已被修改，请保留输入并重新核对。';
    }
    if (error is ApiNetworkException) {
      return '保存结果尚未确认，请保留输入并重新核对。${error.message}';
    }
    return friendlyApiError(error);
  }

  Future<void> _save() async {
    final original = _medicine;
    if (!_current || original == null || _saving) return;
    final name = _name.text.trim();
    if (name.isEmpty) {
      setState(() => _failure = const FormatException('请填写药名。'));
      return;
    }
    final parsedIngredients = _ingredients.text
        .split(RegExp(r'[,，、;；\n]'))
        .map((value) => value.trim())
        .where((value) => value.isNotEmpty)
        .toList();
    final ingredients = !_ingredientsTouched ||
            listEquals(
              parsedIngredients,
              original.activeIngredients.map((item) => item.trim()).toList(),
            )
        ? original.activeIngredients
        : parsedIngredients;
    final brand = _optional(_brand, original.brand);
    final specification = _optional(_specification, original.specification);
    final manufacturer = _optional(_manufacturer, original.manufacturer);
    final approval = _optional(_approval, original.approvalNumber);
    final purpose = _optional(_purpose, original.leaflet.purposeSummary);
    final usage = _optional(_usage, original.leaflet.packageUsageSummary);
    final contraindications = _optional(
      _contraindications,
      original.leaflet.contraindicationsSummary,
    );
    final precautions = _optional(
      _precautions,
      original.leaflet.precautionsSummary,
    );
    final changed =
        name != original.name.trim() ||
        brand != original.brand ||
        specification != original.specification ||
        manufacturer != original.manufacturer ||
        approval != original.approvalNumber ||
        !listEquals(ingredients, original.activeIngredients) ||
        purpose != original.leaflet.purposeSummary ||
        usage != original.leaflet.packageUsageSummary ||
        contraindications != original.leaflet.contraindicationsSummary ||
        precautions != original.leaflet.precautionsSummary;
    final updated = MedicineRecord(
      id: original.id,
      name: name == original.name.trim() ? original.name : name,
      brand: brand,
      specification: specification,
      manufacturer: manufacturer,
      approvalNumber: approval,
      barcodeValue: original.barcodeValue,
      coverPhotoId: original.coverPhotoId,
      createdAt: original.createdAt,
      activeIngredients: ingredients,
      purposeCategory: original.purposeCategory,
      populationTags: original.populationTags,
      purposeTags: original.purposeTags,
      tagSource: original.tagSource,
      leaflet: LeafletRecord(
        purposeSummary: purpose,
        packageUsageSummary: usage,
        contraindicationsSummary: contraindications,
        precautionsSummary: precautions,
        source: original.leaflet.source,
        reviewStatus: changed ? 'unverified' : original.leaflet.reviewStatus,
      ),
      batches: original.batches,
      lowStockThreshold: original.lowStockThreshold,
      stockStatus: original.stockStatus,
      stockQuantity: original.stockQuantity,
      stockUnit: original.stockUnit,
      expiryState: original.expiryState,
      isArchived: original.isArchived,
      version: original.version,
      dosageNotes: original.dosageNotes,
    );
    setState(() {
      _saving = true;
      _failure = null;
    });
    try {
      await widget.repository.updateMedicine(
        updated,
        isCurrent: () => _current,
      );
      if (!_current) return;
      setState(() {
        _allowExit = true;
        _dirty = false;
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_current) Navigator.of(context).pop(true);
      });
    } catch (error) {
      if (_current) setState(() => _failure = error);
    } finally {
      if (_current) setState(() => _saving = false);
    }
  }

  Future<void> _confirmExit() async {
    if (_saving || !_dirty || _stale) return;
    final leave = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: const Text('放弃未保存的修改？'),
        content: const Text('这些资料尚未保存。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialog, false),
            child: const Text('继续编辑'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialog, true),
            child: const Text('放弃修改'),
          ),
        ],
      ),
    );
    if (!mounted || leave != true || !_current) return;
    setState(() => _allowExit = true);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) Navigator.of(context).pop();
    });
  }

  @override
  void dispose() {
    _api.identityEpochSignal.removeListener(_identityChanged);
    _api.identityState?.scopeSignal.removeListener(_identityChanged);
    for (final controller in [
      _name,
      _brand,
      _specification,
      _manufacturer,
      _approval,
      _ingredients,
      _purpose,
      _usage,
      _contraindications,
      _precautions,
    ]) {
      controller.dispose();
    }
    super.dispose();
  }

  Widget _field(
    String label,
    TextEditingController controller, {
    bool multiline = false,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: TextField(
      controller: controller,
      enabled: !_saving,
      maxLines: multiline ? null : 1,
      onChanged: (_) => setState(() {
        _dirty = true;
        if (identical(controller, _ingredients)) _ingredientsTouched = true;
      }),
      decoration: InputDecoration(labelText: label),
    ),
  );

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: _allowExit || _stale || (!_dirty && !_saving),
    onPopInvokedWithResult: (didPop, _) {
      if (!didPop) _confirmExit();
    },
    child: Scaffold(
      appBar: AppBar(title: const Text('编辑药品资料')),
      body: _stale
          ? const Center(child: Text('家庭或账号已变化，请返回后重新打开。'))
          : _medicine == null
          ? Center(
              child: _failure == null
                  ? const CircularProgressIndicator()
                  : Text(friendlyApiError(_failure!)),
            )
          : ListView(
              padding: const EdgeInsets.all(18),
              children: [
                _field('药名', _name),
                _field('品牌', _brand),
                _field('规格', _specification),
                _field('厂家', _manufacturer),
                _field('批准文号', _approval),
                _field('成分（多个请用逗号分开）', _ingredients, multiline: true),
                _field('功能与用途', _purpose, multiline: true),
                _field('用法用量原文', _usage, multiline: true),
                _field('禁忌', _contraindications, multiline: true),
                _field('注意事项', _precautions, multiline: true),
                const Text('修改包装或说明书资料后，需要重新核对。'),
              ],
            ),
      bottomNavigationBar: _stale || _medicine == null
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (_failure != null) ...[
                      Text(
                        _errorText(_failure!),
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                      const SizedBox(height: 8),
                    ],
                    PrimaryButton(
                      label: _saving ? '保存中…' : '保存资料',
                      onPressed: _saving ? null : _save,
                    ),
                  ],
                ),
              ),
            ),
    ),
  );
}
