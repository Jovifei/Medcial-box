import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:path_provider/path_provider.dart';

import '../../core/widgets/app_surfaces.dart';
import '../../core/widgets/expiry_date_wheel_picker.dart';
import '../../data/api_client.dart';
import '../../data/api_medicine_repository.dart';
import '../../data/api_workflow_repository.dart';
import '../../data/medicine_recognition.dart';
import '../../data/app_stores.dart';
import '../../data/medicine_draft_queue.dart';
import '../../domain/ingredient_match.dart';
import '../../models/medicine_models.dart';

enum _ImageAction { camera, gallery }

enum _DraftExitAction { keep, discard, continueEditing }

class MedicineEntryApiPage extends StatefulWidget {
  const MedicineEntryApiPage({
    super.key,
    required this.repository,
    required this.workflow,
    required this.localStore,
  });
  final ApiMedicineRepository repository;
  final ApiWorkflowRepository workflow;
  final LocalAppStore localStore;

  @override
  State<MedicineEntryApiPage> createState() => _MedicineEntryApiPageState();
}

class _MedicineEntryApiPageState extends State<MedicineEntryApiPage> {
  final nameController = TextEditingController();
  final specificationController = TextEditingController();
  final quantityController = TextEditingController();
  final expiryController = TextEditingController();
  final locationController = TextEditingController();
  final manufacturerController = TextEditingController();
  final approvalController = TextEditingController();
  final ingredientController = TextEditingController();
  final purposeController = TextEditingController();
  final afterOpenValueController = TextEditingController();
  final afterOpenDateController = TextEditingController();
  final imagePicker = ImagePicker();
  final recognition = MlKitMedicineRecognitionRepository();

  String unit = 'box';
  String expiryPrecision = 'unknown';
  String openedState = 'unknown';
  String afterOpenKind = 'duration';
  String? afterOpenUnit;
  String? openedAt;
  String? scannedCode;
  XFile? image;
  bool openingExpanded = false;
  bool categoryExpanded = false;
  late final MedicineDraftQueue draftQueue = MedicineDraftQueue(
    widget.localStore,
    isCurrent: () => mounted && _isDraftIdentityCurrent,
    scope: entryIdentity,
  );
  late final (ApiClient, LocalAppStore, String, int, String?, String?, String?)
  entryIdentity;
  Future<void> draftPersistence = Future.value();
  String draftId = DateTime.now().microsecondsSinceEpoch.toString();
  String? savedMedicineId;
  String? savedBatchId;
  String? frontPhotoId;
  String? expiryPhotoId;
  XFile? expiryImage;
  Timer? autoSave;
  int recognitionRequest = 0;
  bool moreExpanded = false;
  bool ingredientsVerified = false;
  bool recognizing = false;
  bool searchingCatalog = false;
  bool saving = false;
  Object? inventorySaveIntent;
  bool dirty = false;
  bool handlingBack = false;
  bool restoringDraft = true;
  bool touchedName = false;
  bool touchedExpiry = false;
  Map<String, dynamic>? attemptedPayload;
  Object? recognitionFailure;
  List<String> recognitionWarnings = const [];

  static const _draftKey = 'medicine-entry';
  bool restoredDraft = false;

  @override
  void initState() {
    super.initState();
    entryIdentity = _identitySnapshot();
    unawaited(_restoreDraft());
  }

  (ApiClient, LocalAppStore, String, int, String?, String?, String?)
  _identitySnapshot() {
    final api = widget.repository.api;
    final identity = api.identityState;
    return (
      api,
      widget.localStore,
      api.baseUrl,
      api.identityEpoch,
      identity?.generation,
      identity?.owner?.userId,
      identity?.owner?.familyId,
    );
  }

  bool get _isDraftIdentityCurrent => entryIdentity == _identitySnapshot();

  // Keep the queue and legacy draft writes in the same order, including
  // autosaves that were already running when the user chose to leave.
  Future<void> _persistDraft(Future<void> Function() operation) {
    final next = draftPersistence.then((_) async {
      if (mounted && _isDraftIdentityCurrent) await operation();
    });
    draftPersistence = next.catchError((Object _) {});
    return next;
  }

  Future<void> _restoreDraft() async {
    try {
      final queue = await draftQueue.list();
      if (!mounted || !_isDraftIdentityCurrent) return;
      final legacy = await widget.localStore.readDraft(_draftKey);
      final raw = legacy ?? (queue.isEmpty ? null : jsonEncode(queue.last));
      if (raw == null ||
          raw.isEmpty ||
          !mounted ||
          dirty ||
          !_isDraftIdentityCurrent) {
        return;
      }
      final json = jsonDecode(raw);
      if (json is! Map<String, dynamic>) {
        throw const FormatException('本地录入草稿格式无效');
      }
      _applyDraft(json);
    } catch (_) {
      if (mounted && _isDraftIdentityCurrent) {
        await _persistDraft(() => widget.localStore.deleteDraft(_draftKey))
            .catchError((Object _) {});
      }
    } finally {
      if (mounted) setState(() => restoringDraft = false);
    }
  }

  void _applyDraft(Map<String, dynamic> json) {
    nameController.text = json['name'] as String? ?? '';
    specificationController.text = json['specification'] as String? ?? '';
    quantityController.text = json['quantity'] as String? ?? '';
    expiryController.text = json['expiry'] as String? ?? '';
    locationController.text = json['location'] as String? ?? '';
    manufacturerController.text = json['manufacturer'] as String? ?? '';
    approvalController.text = json['approval'] as String? ?? '';
    ingredientController.text = json['ingredients'] as String? ?? '';
    purposeController.text = json['purpose'] as String? ?? '';
    ingredientsVerified = json['ingredientsVerified'] == true;
    afterOpenValueController.text = json['afterOpenValue'] as String? ?? '';
    afterOpenDateController.text = json['afterOpenDate'] as String? ?? '';
    unit = json['unit'] as String? ?? 'box';
    expiryPrecision = json['expiryPrecision'] as String? ?? 'unknown';
    openedState = json['openedState'] as String? ?? 'unknown';
    afterOpenKind = json['afterOpenKind'] as String? ?? 'duration';
    afterOpenUnit = json['afterOpenUnit'] as String?;
    openedAt = json['openedAt'] as String?;
    scannedCode = json['scannedCode'] as String?;
    openingExpanded = json['openingExpanded'] == true;
    moreExpanded = json['moreExpanded'] == true;
    draftId = json['id'] as String? ?? draftId;
    savedMedicineId = json['savedMedicineId'] as String?;
    attemptedPayload = json['attemptedPayload'] as Map<String, dynamic>?;
    touchedExpiry = json['touchedExpiry'] == true;
    savedBatchId = json['savedBatchId'] as String?;
    frontPhotoId = json['frontPhotoId'] as String?;
    expiryPhotoId = json['expiryPhotoId'] as String?;
    image = json['imagePath'] is String
        ? XFile(json['imagePath'] as String)
        : null;
    expiryImage = json['expiryImagePath'] is String
        ? XFile(json['expiryImagePath'] as String)
        : null;
    touchedName = false;
    restoredDraft = true;
  }

  Map<String, dynamic> _draftFields() => {
    'name': nameController.text,
    'specification': specificationController.text,
    'quantity': quantityController.text,
    'expiry': expiryController.text,
    'location': locationController.text,
    'manufacturer': manufacturerController.text,
    'approval': approvalController.text,
    'ingredients': ingredientController.text,
    'purpose': purposeController.text,
    'ingredientsVerified': ingredientsVerified,
    'afterOpenValue': afterOpenValueController.text,
    'afterOpenDate': afterOpenDateController.text,
    'unit': unit,
    'expiryPrecision': expiryPrecision,
    'openedState': openedState,
    'afterOpenKind': afterOpenKind,
    'afterOpenUnit': afterOpenUnit,
    'openedAt': openedAt,
    'scannedCode': scannedCode,
    'openingExpanded': openingExpanded,
    'moreExpanded': moreExpanded,
    'savedMedicineId': savedMedicineId,
    'attemptedPayload': attemptedPayload,
    'touchedExpiry': touchedExpiry,
    'savedBatchId': savedBatchId,
    'frontPhotoId': frontPhotoId,
    'expiryPhotoId': expiryPhotoId,
    'imagePath': image?.path,
    'expiryImagePath': expiryImage?.path,
    'status': savedMedicineId != null
        ? 'photos_pending'
        : recognizing
        ? 'recognizing'
        : recognitionFailure != null
        ? 'failed'
        : 'review',
  };
  Future<void> _saveDraft({bool legacy = true}) async {
    if (!mounted || !_isDraftIdentityCurrent) return;
    final id = draftId;
    final fields = _draftFields();
    await _persistDraft(() async {
      await draftQueue.save(id, fields);
      if (legacy && mounted && _isDraftIdentityCurrent) {
        await widget.localStore.saveDraft(
          _draftKey,
          jsonEncode({...fields, 'id': id}),
        );
      }
    });
  }

  Future<void> _chooseDraft() async {
    if (handlingBack || !_isDraftIdentityCurrent) return;
    final originalId = draftId;
    if (dirty) await _saveDraft(legacy: false);
    if (!mounted || !_isDraftIdentityCurrent || handlingBack) return;
    final drafts = await draftQueue.list();
    if (!mounted ||
        !_isDraftIdentityCurrent ||
        handlingBack ||
        draftId != originalId) {
      return;
    }
    final selected = await showAppSheet<Map<String, dynamic>>(
      context,
      title: '本机待核对草稿（${drafts.length}/10）',
      builder: (context) => ListView(
        shrinkWrap: true,
        children: [
          ...drafts.map(
            (draft) => ListTile(
              title: Text(draft['name'] as String? ?? '未命名药品'),
              subtitle: Text(
                draft['savedMedicineId'] != null ? '药已保存 · 照片待补' : '待核对 · 未入库',
              ),
              onTap: () => Navigator.pop(context, draft),
              trailing: IconButton(
                tooltip: '删除草稿',
                icon: const Icon(Icons.delete_outline),
                onPressed: () async {
                  await draftQueue.remove(draft['id'] as String);
                  if (context.mounted) Navigator.pop(context);
                },
              ),
            ),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, <String, dynamic>{}),
            child: const Text('新建一份草稿'),
          ),
        ],
      ),
    );
    if (selected == null ||
        !mounted ||
        !_isDraftIdentityCurrent ||
        handlingBack ||
        draftId != originalId) {
      return;
    }
    recognitionRequest++;
    if (selected.isEmpty) {
      if (drafts.length >= 10) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('最多10份，请先保存或删除草稿。')));
        return;
      }
      draftId = DateTime.now().microsecondsSinceEpoch.toString();
    }
    setState(() {
      _applyDraft(selected);
      dirty = false;
      recognizing = false;
      recognitionFailure = null;
      restoredDraft = selected.isNotEmpty;
    });
    final selectedId = draftId;
    await _persistDraft(() => widget.localStore.deleteDraft(_draftKey));
    if (selected.isNotEmpty &&
        mounted &&
        _isDraftIdentityCurrent &&
        !handlingBack &&
        draftId == selectedId) {
      await _saveDraft();
    }
  }

  void _markDirty() {
    if (!dirty && mounted) setState(() => dirty = true);
    autoSave?.cancel();
    if (handlingBack || !_isDraftIdentityCurrent) return;
    autoSave = Timer(const Duration(milliseconds: 200), () {
      if (mounted) {
        unawaited(_saveDraft(legacy: false).catchError((Object _) {}));
      }
    });
  }

  Future<void> _confirmLeave() async {
    if (handlingBack ||
        (!dirty && !restoredDraft) ||
        saving ||
        !_isDraftIdentityCurrent) {
      return;
    }
    final route = ModalRoute.of(context);
    if (route == null || !route.isCurrent) return;
    final navigator = Navigator.of(context);
    final id = draftId;
    bool isCurrentIntent() =>
        mounted && _isDraftIdentityCurrent && draftId == id && route.isCurrent;
    setState(() => handlingBack = true);
    autoSave?.cancel();
    _DraftExitAction? action;
    try {
      action = await showDialog<_DraftExitAction>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('保留这次录入？'),
          content: const Text('尚未保存的内容可以暂存在本机，之后继续核对。照片只在本机保留，确认保存前不会上传。'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(
                dialogContext,
                _DraftExitAction.continueEditing,
              ),
              child: const Text('继续编辑'),
            ),
            TextButton(
              onPressed: () =>
                  Navigator.pop(dialogContext, _DraftExitAction.discard),
              child: const Text('放弃修改'),
            ),
            FilledButton(
              onPressed: () =>
                  Navigator.pop(dialogContext, _DraftExitAction.keep),
              child: const Text('保留草稿'),
            ),
          ],
        ),
      );
      if (!isCurrentIntent() ||
          action == null ||
          action == _DraftExitAction.continueEditing) {
        return;
      }
      if (action == _DraftExitAction.keep) {
        // Edits remain available during slow storage. Only leave after both
        // stores have acknowledged the latest complete field snapshot.
        String snapshot;
        do {
          snapshot = jsonEncode(_draftFields());
          await _saveDraft();
          if (!isCurrentIntent()) return;
        } while (snapshot != jsonEncode(_draftFields()));
      } else {
        final snapshot = jsonEncode(_draftFields());
        await _persistDraft(() async {
          if (!isCurrentIntent()) return;
          await widget.localStore.deleteDraft(_draftKey);
          if (!isCurrentIntent()) return;
          await draftQueue.remove(id);
        });
        if (!isCurrentIntent()) return;
        if (snapshot != jsonEncode(_draftFields())) {
          // The discard decision did not cover edits entered while deleting.
          await _saveDraft();
          return;
        }
      }
      if (!isCurrentIntent()) return;
      setState(() {
        dirty = false;
        restoredDraft = action == _DraftExitAction.keep;
      });
      navigator.pop();
    } catch (_) {
      if (!mounted || !isCurrentIntent()) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            action == _DraftExitAction.discard
                ? '草稿删除失败，内容仍在当前页面。请重试。'
                : '草稿保存失败，内容仍在当前页面。请重试。',
          ),
          action: SnackBarAction(
            label: '重试',
            onPressed: () {
              if (isCurrentIntent()) unawaited(_confirmLeave());
            },
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => handlingBack = false);
      if (isCurrentIntent() && dirty) {
        _markDirty();
      }
    }
  }

  @override
  void dispose() {
    autoSave?.cancel();
    recognitionRequest++;
    nameController.dispose();
    specificationController.dispose();
    quantityController.dispose();
    expiryController.dispose();
    locationController.dispose();
    manufacturerController.dispose();
    approvalController.dispose();
    ingredientController.dispose();
    purposeController.dispose();
    afterOpenValueController.dispose();
    afterOpenDateController.dispose();
    super.dispose();
  }

  Future<void> _chooseImage({
    _ImageAction? action,
    bool expiryPhoto = false,
  }) async {
    action ??= await showAppSheet<_ImageAction>(
      context,
      title: '拍药盒',
      builder: (sheetContext) => Column(
        children: [
          choiceTile(
            sheetContext,
            icon: Icons.camera_alt_rounded,
            title: '拍照识别',
            subtitle: '照片只在本机识别，不会自动上传',
            onTap: () => Navigator.pop(sheetContext, _ImageAction.camera),
          ),
          const SizedBox(height: 10),
          choiceTile(
            sheetContext,
            icon: Icons.photo_library_outlined,
            title: '从相册选择',
            subtitle: '选择一张清晰的药盒照片',
            tint: const Color(0xFFF6EAD4),
            onTap: () => Navigator.pop(sheetContext, _ImageAction.gallery),
          ),
        ],
      ),
    );
    if (action == null || !mounted) return;
    try {
      final selected = await imagePicker.pickImage(
        source: action == _ImageAction.camera
            ? ImageSource.camera
            : ImageSource.gallery,
        imageQuality: 90,
        maxWidth: 1800,
      );
      if (selected == null || !mounted) return;
      final request = ++recognitionRequest;
      final support = await getApplicationSupportDirectory();
      final directory = Directory('${support.path}/medicine-draft-images');
      await directory.create(recursive: true);
      final originalBytes = await File(selected.path).readAsBytes();
      final extension =
          originalBytes.length > 3 &&
              originalBytes[0] == 137 &&
              originalBytes[1] == 80
          ? 'png'
          : 'jpg';
      final durable = await File(selected.path).copy(
        '${directory.path}/$draftId-${expiryPhoto ? 'expiry' : 'front'}.$extension',
      );
      if (!mounted || request != recognitionRequest) return;
      if (expiryPhoto) {
        expiryImage = XFile(durable.path);
      } else {
        image = XFile(durable.path);
      }
      _markDirty();
      await _saveDraft(legacy: false);
      if (expiryPhoto) {
        if (mounted) setState(() {});
        return;
      }
      setState(() {
        recognizing = true;
        recognitionFailure = null;
        recognitionWarnings = const [];
      });
      await _saveDraft(legacy: false);
      try {
        final draft = await recognition.recognize(selected);
        if (!mounted || request != recognitionRequest) return;
        if (!touchedName && nameController.text.trim().isEmpty) {
          nameController.text = draft.name;
        }
        if (specificationController.text.trim().isEmpty) {
          specificationController.text = draft.specification;
        }
        if (!touchedExpiry &&
            expiryController.text.trim().isEmpty &&
            draft.expiry != '待补充') {
          expiryController.text = draft.expiry;
          expiryPrecision = draft.expiry.length == 7 ? 'month' : 'day';
        }
        setState(() {
          recognizing = false;
          recognitionWarnings = draft.warnings;
        });
        await _saveDraft(legacy: false);
      } catch (error) {
        if (!mounted || request != recognitionRequest) return;
        setState(() {
          recognizing = false;
          recognitionFailure = error;
        });
        await _saveDraft(legacy: false);
      }
    } catch (error) {
      if (!mounted) return;
      final value = error.toString().toLowerCase();
      final denied = value.contains('permission') || value.contains('denied');
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(denied ? '相机或相册权限未开启，请在系统设置中允许访问。' : '无法打开相机或相册，请重试。'),
        ),
      );
    }
  }

  Future<void> _scanCode() async {
    final code = await Navigator.of(
      context,
    ).push<String>(MaterialPageRoute(builder: (_) => const _BarcodeScanPage()));
    if (!mounted || code == null) return;
    setState(() => scannedCode = code);
    _markDirty();
    await _searchCatalog(barcode: code);
  }

  Future<void> _searchCatalog({String? barcode}) async {
    final query = nameController.text.trim();
    if (barcode == null && query.isEmpty) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('请先识别或填写药品名称，或扫描药盒编码。')));
      return;
    }
    final consent = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('查询药品资料？'),
        content: Text(
          barcode == null
              ? '将把药品名称${manufacturerController.text.trim().isEmpty ? '' : '、厂家'}发送给药品资料服务，查询结果只作候选，需对照实物核验。不会上传照片。'
              : '将把刚扫描的药品编码发送给药品资料服务查询候选。不会上传照片；结果需对照实物核验。',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('暂不查询'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('同意并查询'),
          ),
        ],
      ),
    );
    if (consent != true || !mounted) return;
    setState(() => searchingCatalog = true);
    try {
      final result = await widget.workflow.searchMedicineCandidates(
        name: barcode == null ? query : null,
        manufacturer: manufacturerController.text.trim().isEmpty
            ? null
            : manufacturerController.text.trim(),
        approvalNumber: approvalController.text.trim().isEmpty
            ? null
            : approvalController.text.trim(),
        barcode: barcode,
        specification: specificationController.text.trim().isEmpty
            ? null
            : specificationController.text.trim(),
        consentToShare: true,
      );
      if (!mounted) return;
      final candidates = (result['candidates'] as List<dynamic>? ?? [])
          .whereType<Map<String, dynamic>>()
          .toList(growable: false);
      setState(() => searchingCatalog = false);
      if (candidates.isEmpty) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('没有查到匹配资料；仍可手工保存库存。')));
        return;
      }
      final selected = await showAppSheet<Map<String, dynamic>>(
        context,
        title: '选择候选资料',
        builder: (sheetContext) => ListView(
          shrinkWrap: true,
          children: [
            const Padding(
              padding: EdgeInsets.only(bottom: 10),
              child: Text('联网资料尚未核验。只有你选择的字段会补入空白项，不会覆盖已填写内容。'),
            ),
            ...candidates.map((candidate) {
              final leaflet = candidate['leaflet'] is Map<String, dynamic>
                  ? candidate['leaflet']! as Map<String, dynamic>
                  : const <String, dynamic>{};
              return Card(
                child: ListTile(
                  title: Text(candidate['name'] as String? ?? '未命名候选'),
                  subtitle: Text(
                    [
                      candidate['specification'] as String? ?? '',
                      candidate['manufacturer'] as String? ?? '',
                      candidate['approvalNumber'] as String? ?? '',
                      leaflet['purposeSummary'] as String? ?? '',
                    ].where((value) => value.isNotEmpty).join(' · '),
                  ),
                  trailing: const Icon(Icons.add_circle_outline_rounded),
                  onTap: () => Navigator.pop(sheetContext, candidate),
                ),
              );
            }),
          ],
        ),
      );
      if (selected == null || !mounted) return;
      _applyCandidate(selected);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('已补入候选资料。请核对后保存；来源状态仍为未核验。')),
      );
    } catch (error) {
      if (!mounted) return;
      setState(() => searchingCatalog = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('${friendlyApiError(error)} 仍可继续手动录入。')),
      );
    }
  }

  void _applyCandidate(Map<String, dynamic> candidate) {
    void fill(TextEditingController controller, Object? value) {
      if (controller.text.trim().isEmpty &&
          value is String &&
          value.trim().isNotEmpty) {
        controller.text = value.trim();
      }
    }

    fill(nameController, candidate['name']);
    fill(specificationController, candidate['specification']);
    fill(manufacturerController, candidate['manufacturer']);
    fill(approvalController, candidate['approvalNumber']);
    final ingredients = candidate['activeIngredients'];
    if (ingredientController.text.trim().isEmpty && ingredients is List) {
      ingredientController.text = ingredients.whereType<String>().join('，');
    }
    final leaflet = candidate['leaflet'];
    if (leaflet is Map<String, dynamic>) {
      fill(purposeController, leaflet['purposeSummary']);
    }
    _markDirty();
  }

  Future<void> _pickOpenedDate() async {
    final initial = DateTime.tryParse(openedAt ?? '') ?? DateTime.now();
    final date = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime(2000),
      lastDate: DateTime(2100),
      helpText: '选择开封日期',
    );
    if (date == null || !mounted) return;
    setState(() => openedAt = _date(date));
    _markDirty();
  }

  Future<void> _save() async {
    if (saving || handlingBack || !_isDraftIdentityCurrent) return;
    final route = ModalRoute.of(context);
    if (route == null || !route.isCurrent) return;
    final navigator = Navigator.of(context);
    final repository = widget.repository;
    final workflow = widget.workflow;
    final localStore = widget.localStore;
    final id = draftId;
    final intent = Object();
    final workflowApi = workflow.api;
    Object workflowIdentity() => (
      workflowApi.identityEpoch,
      workflowApi.identityState?.generation,
      workflowApi.identityState?.owner?.userId,
      workflowApi.identityState?.owner?.familyId,
    );
    final originalWorkflowIdentity = workflowIdentity();
    bool sameDraft() =>
        mounted &&
        draftId == id &&
        identical(widget.repository, repository) &&
        identical(widget.workflow, workflow) &&
        identical(widget.localStore, localStore) &&
        identical(inventorySaveIntent, intent);
    bool isCurrentIntent() =>
        sameDraft() &&
        route.isCurrent &&
        _isDraftIdentityCurrent &&
        workflowIdentity() == originalWorkflowIdentity;
    void requireCurrentIntent() {
      if (!isCurrentIntent()) {
        throw const ApiException(
          statusCode: 401,
          code: 'STALE_SESSION',
          message: '会话已变更，请重新加载。',
        );
      }
    }

    final name = nameController.text.trim();
    if (name.isEmpty) {
      setState(() => touchedName = true);
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('请填写药品名称。')));
      return;
    }
    double? quantity;
    final rawQuantity = quantityController.text.trim();
    if (rawQuantity.isNotEmpty) {
      // R08：按单位解析——毫升允许最多 3 位小数，计件单位要求非负整数。
      quantity = parseQuantityByUnit(rawQuantity, unit);
      if (quantity == null) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(quantityInputError(unit))));
        return;
      }
    }

    final rawExpiry = expiryController.text.trim();
    if (rawExpiry.isNotEmpty && !_validExpiry(rawExpiry, expiryPrecision)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('有效期格式或日期无效，请填写 YYYY-MM 或 YYYY-MM-DD。')),
      );
      return;
    }

    final batch = <String, Object?>{
      'quantity': quantity,
      'unit': unit,
      'expiry': {
        'value': rawExpiry.isEmpty ? null : rawExpiry,
        'precision': rawExpiry.isEmpty ? 'unknown' : expiryPrecision,
      },
      'storageLocation': _nullableText(locationController.text),
      'openedState': openedState,
    };
    if (openedState == 'opened') {
      batch['openedAt'] = openedAt;
      final limit = _afterOpeningLimit();
      if (limit != null) batch['afterOpeningLimit'] = limit;
    }

    final ingredients = ingredientController.text
        .split(RegExp(r'[,，、;；]'))
        .map((item) => item.trim())
        .where((item) => item.isNotEmpty)
        .toList();
    final verifiedIngredients = ingredientsVerified;
    final candidatePayload = <String, Object?>{
      'idempotencyKey': 'draft-$id',
      'name': name,
      'barcodeValue': _nullableText(scannedCode ?? ''),
      'specification': _nullableText(specificationController.text),
      'manufacturer': _nullableText(manufacturerController.text),
      'approvalNumber': _nullableText(approvalController.text),
      'activeIngredients': ingredients,
      'purposeCategory': _nullableText(purposeController.text),
      'leaflet': {
        'reviewStatus': verifiedIngredients ? 'user_confirmed' : 'unverified',
      },
      'batches': [batch],
    };
    final front = image;
    final expiryPhoto = expiryImage;
    inventorySaveIntent = intent;
    autoSave?.cancel();
    FocusScope.of(context).unfocus();
    setState(() => saving = true);
    try {
      bool uploadPhotos = false;
      if (front != null || expiryPhoto != null) {
        final consent = await showDialog<bool>(
          context: context,
          builder: (dialogContext) => AlertDialog(
            title: const Text('保存药盒照片？'),
            content: const Text('照片将上传并保存在此家庭的私有药品资料中，用于核对药盒和有效期。'),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext, false),
                child: const Text('只保存库存'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(dialogContext, true),
                child: const Text('确认上传照片'),
              ),
            ],
          ),
        );
        if (consent == null || !isCurrentIntent()) return;
        uploadPhotos = consent;
      }
      if (verifiedIngredients && ingredients.isNotEmpty) {
        var matches = const <MedicineRecord>[];
        try {
          final householdMedicines = await repository.listMedicines(
            isCurrent: isCurrentIntent,
          );
          requireCurrentIntent();
          matches = findVerifiedIngredientMatches(
            candidateIngredients: ingredients,
            medicines: householdMedicines,
            candidateIngredientsVerified: true,
          );
        } on ApiNetworkException {
          // The hint is best-effort only while the original intent is current.
        } on ApiException {
          // Stale requests are stopped by the intent check below.
        }
        if (!isCurrentIntent()) return;
        if (matches.isNotEmpty && mounted) {
          final proceed = await showDialog<bool>(
            context: context,
            builder: (dialogContext) => AlertDialog(
              title: const Text('家中已有相同成分记录'),
              content: Text(
                '成分资料已核验的药品：${matches.map((item) => item.name).take(6).join('、')}。请对照包装核对，这只是重复成分提醒，不是选药建议。仍要保存库存吗？',
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(dialogContext, false),
                  child: const Text('返回核对'),
                ),
                FilledButton(
                  onPressed: () => Navigator.pop(dialogContext, true),
                  child: const Text('仍然保存'),
                ),
              ],
            ),
          );
          if (proceed != true || !isCurrentIntent()) return;
        }
      }
      requireCurrentIntent();
      attemptedPayload ??= candidatePayload;
      await _saveDraft(legacy: false);
      requireCurrentIntent();
      final medicine = savedMedicineId == null
          ? await repository.createMedicine(
              attemptedPayload!,
              isCurrent: isCurrentIntent,
            )
          : await repository.getMedicine(
              savedMedicineId!,
              isCurrent: isCurrentIntent,
            );
      requireCurrentIntent();
      savedMedicineId = medicine.id;
      savedBatchId ??= medicine.batches.isEmpty
          ? null
          : medicine.batches.first.id;
      await _saveDraft(legacy: false);
      requireCurrentIntent();
      if (uploadPhotos) {
        Future<String> upload(XFile file, String purpose) async {
          final bytes = await file.readAsBytes();
          requireCurrentIntent();
          final photo = await workflow.uploadLeafletPhoto(
            medicine.id,
            bytes,
            mimeType: file.path.toLowerCase().endsWith('.png')
                ? 'image/png'
                : 'image/jpeg',
            source: 'user_capture',
            purpose: purpose,
            batchId: savedBatchId,
            isCurrent: isCurrentIntent,
          );
          requireCurrentIntent();
          return photo.id;
        }

        if (front != null) {
          final photoId = frontPhotoId ?? await upload(front, 'box_front');
          requireCurrentIntent();
          frontPhotoId = photoId;
          await _saveDraft(legacy: false);
          requireCurrentIntent();
          await workflow.setCoverPhoto(
            medicine.id,
            photoId,
            isCurrent: isCurrentIntent,
          );
          requireCurrentIntent();
        }
        if (expiryPhoto != null) {
          final photoId = expiryPhotoId ?? await upload(expiryPhoto, 'expiry');
          requireCurrentIntent();
          expiryPhotoId = photoId;
          await _saveDraft(legacy: false);
          requireCurrentIntent();
        }
      }
      await _persistDraft(() async {
        requireCurrentIntent();
        await localStore.deleteDraft(_draftKey);
        requireCurrentIntent();
        await draftQueue.remove(id);
      });
      requireCurrentIntent();
      setState(() {
        dirty = false;
        restoredDraft = false;
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('已保存到药箱。当前筛选可能隐藏新记录，可切换全部查看。')),
      );
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (isCurrentIntent()) navigator.pop(medicine.id);
      });
      WidgetsBinding.instance.scheduleFrame();
    } catch (error) {
      if (!isCurrentIntent()) return;
      if (savedMedicineId == null &&
          error is ApiException &&
          error.statusCode == 400) {
        attemptedPayload = null;
        await _saveDraft(legacy: false).catchError((Object _) {});
        if (!isCurrentIntent()) return;
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            savedMedicineId == null
                ? friendlyApiError(error)
                : '库存已保存，照片待补。草稿已保留，重试仅关联照片。',
          ),
        ),
      );
    } finally {
      // A superseded operation must never reset a newer page/draft operation.
      if (sameDraft()) setState(() => saving = false);
      if (isCurrentIntent() && dirty && attemptedPayload == null) _markDirty();
    }
  }

  Map<String, Object?>? _afterOpeningLimit() {
    if (afterOpenKind == 'date') {
      final date = afterOpenDateController.text.trim();
      return date.isEmpty ? null : {'date': date, 'source': 'user'};
    }
    final value = int.tryParse(afterOpenValueController.text.trim());
    if (value == null || value <= 0 || afterOpenUnit == null) return null;
    return {'value': value, 'unit': afterOpenUnit, 'source': 'user'};
  }

  Widget _optionalSection({
    required String title,
    required bool expanded,
    required VoidCallback onTap,
  }) => InkWell(
    onTap: onTap,
    child: Row(
      children: [
        Expanded(
          child: Text(title, style: Theme.of(context).textTheme.titleMedium),
        ),
        Icon(expanded ? Icons.expand_less_rounded : Icons.expand_more_rounded),
      ],
    ),
  );

  Future<void> _selectExpiryDate() async {
    final selected = await showExpiryDateWheelPicker(
      context,
      initialDate: expiryDateForPicker(expiryController.text),
    );
    if (selected == null || !mounted) return;
    final precision = expiryPrecision == 'month' ? 'month' : 'day';
    setState(() {
      expiryPrecision = precision;
      expiryController.text = formatExpiryDate(selected, precision: precision);
      touchedExpiry = true;
    });
    _markDirty();
  }

  void _setExpiryPrecision(String precision) {
    final current = expiryController.text.trim();
    setState(() {
      expiryPrecision = precision;
      if (precision == 'month' &&
          RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(current)) {
        expiryController.text = current.substring(0, 7);
      } else if (precision == 'day' &&
          RegExp(r'^\d{4}-\d{2}$').hasMatch(current)) {
        expiryController.clear();
      }
      touchedExpiry = true;
    });
    _markDirty();
  }

  double _labelWidth(Iterable<String> labels, TextStyle? style) {
    var width = 0.0;
    for (final label in labels) {
      final painter = TextPainter(
        text: TextSpan(text: label, style: style),
        textDirection: Directionality.of(context),
        textScaler: MediaQuery.textScalerOf(context),
      )..layout();
      if (painter.width > width) width = painter.width;
      painter.dispose();
    }
    return width.ceilToDouble();
  }

  Widget _quantityUnitFields({
    required Widget quantityField,
    required Widget unitField,
    required List<String> quantityLabels,
    required Iterable<String> unitLabels,
  }) => LayoutBuilder(
    builder: (context, constraints) {
      final theme = Theme.of(context);
      final padding =
          theme.inputDecorationTheme.contentPadding
              ?.resolve(Directionality.of(context))
              .horizontal ??
          32;
      final quantityWidth =
          _labelWidth(quantityLabels, theme.textTheme.bodyLarge) + padding + 16;
      // Reserve the arrow and its spacing as well as the widest unit, even
      // when a shorter unit is selected. Never shrink the user's text scale.
      final unitWidth =
          (_labelWidth(unitLabels, theme.textTheme.titleMedium) + padding + 32)
              .clamp(112.0, double.infinity);
      final stacked = constraints.maxWidth < quantityWidth + 10 + unitWidth;
      return Wrap(
        spacing: 10,
        runSpacing: 12,
        children: [
          SizedBox(
            width: stacked
                ? constraints.maxWidth
                : constraints.maxWidth - unitWidth - 10,
            child: quantityField,
          ),
          SizedBox(
            width: stacked ? constraints.maxWidth : unitWidth,
            child: unitField,
          ),
        ],
      );
    },
  );

  Widget _openingSegments({
    required Map<String, String> labels,
    required String selected,
    required ValueChanged<Set<String>> onSelectionChanged,
  }) => LayoutBuilder(
    builder: (context, constraints) {
      // Each equal-width segment needs a full label, the selected checkmark,
      // its gap and button padding. Stack before any label has to wrap.
      final segmentWidth =
          _labelWidth(labels.values, Theme.of(context).textTheme.labelLarge) +
          56;
      return SizedBox(
        width: constraints.maxWidth,
        child: SegmentedButton<String>(
          direction: constraints.maxWidth < segmentWidth * labels.length
              ? Axis.vertical
              : Axis.horizontal,
          segments: [
            for (final entry in labels.entries)
              ButtonSegment(value: entry.key, label: Text(entry.value)),
          ],
          selected: {selected},
          onSelectionChanged: onSelectionChanged,
        ),
      );
    },
  );

  @override
  Widget build(BuildContext context) => PopScope<Object?>(
    key: const ValueKey('medicine-entry-pop-scope'),
    canPop: !dirty && !restoredDraft && !saving && !handlingBack,
    onPopInvokedWithResult: (didPop, _) {
      if (!didPop && (dirty || restoredDraft) && !saving) {
        unawaited(_confirmLeave());
      }
    },
    child: Scaffold(
      appBar: AppBar(
        title: const Text('添加药品'),
        actions: [
          IconButton(
            tooltip: '本机草稿',
            onPressed: saving || handlingBack ? null : _chooseDraft,
            icon: const Icon(Icons.layers_outlined),
          ),
        ],
      ),
      bottomNavigationBar: Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: SafeArea(
          minimum: const EdgeInsets.fromLTRB(20, 8, 20, 12),
          child: PrimaryButton(
            label: saving
                ? '正在保存…'
                : attemptedPayload != null
                ? '重试原提交'
                : '核对后保存',
            icon: Icons.check_rounded,
            onPressed: saving || handlingBack ? null : _save,
          ),
        ),
      ),
      body: AbsorbPointer(
        absorbing: attemptedPayload != null || saving,
        child: AppPage(
          padding: const EdgeInsets.fromLTRB(18, 8, 18, 20),
          child: ListView(
            children: [
              if (attemptedPayload != null)
                const AppCard(
                  child: Text('原提交待确认，已锁定内容避免重复入库。请重试原提交；成功后在详情页修改。'),
                ),
              if (restoringDraft)
                const LinearProgressIndicator(semanticsLabel: '正在恢复本地草稿'),
              if (restoredDraft)
                const AppCard(
                  color: Color(0xFFE8F1EA),
                  child: Text('已恢复本机草稿，核对后逐份保存。'),
                ),
              AppCard(
                color: const Color(0xFFE8F1EA),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '拍药盒，或直接填写药名',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 6),
                    const Text('本机中文文字识别只生成草稿；请核对后保存。照片不会自动上传。'),
                    const SizedBox(height: 14),
                    PrimaryButton(
                      label: recognizing ? '正在识别…' : '拍药盒',
                      icon: Icons.camera_alt_rounded,
                      onPressed: recognizing
                          ? null
                          : () => _chooseImage(action: _ImageAction.camera),
                    ),
                    const SizedBox(height: 8),
                    SoftButton(
                      label: '扫码读取药盒编码',
                      icon: Icons.qr_code_scanner_rounded,
                      onPressed: saving ? null : _scanCode,
                    ),
                    TextButton.icon(
                      onPressed: recognizing
                          ? null
                          : () => _chooseImage(action: _ImageAction.gallery),
                      icon: const Icon(Icons.photo_library_outlined),
                      label: const Text('从相册选择'),
                    ),
                    if (nameController.text.trim().isNotEmpty ||
                        scannedCode != null) ...[
                      const SizedBox(height: 8),
                      SoftButton(
                        label: searchingCatalog ? '正在查询候选资料…' : '联网查询候选资料',
                        icon: Icons.manage_search_rounded,
                        onPressed: searchingCatalog
                            ? null
                            : () => _searchCatalog(),
                      ),
                    ],
                    if (image != null) ...[
                      const SizedBox(height: 12),
                      ClipRRect(
                        borderRadius: BorderRadius.circular(14),
                        child: Image.file(
                          File(image!.path),
                          height: 150,
                          width: double.infinity,
                          fit: BoxFit.cover,
                        ),
                      ),
                    ],
                    if (scannedCode != null) ...[
                      const SizedBox(height: 10),
                      SelectableText('药盒编码：$scannedCode'),
                      const Text('商品码和追溯码可能用途不同；读取编码不代表已查到药品资料。'),
                    ],
                    if (recognizing) ...[
                      const SizedBox(height: 12),
                      const LinearProgressIndicator(),
                      const SizedBox(height: 6),
                      const Text('正在识别药盒文字…'),
                    ],
                    if (recognitionFailure != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 10),
                        child: Text(
                          '识别失败，可继续手动保存：${friendlyApiError(recognitionFailure!)}',
                        ),
                      ),
                    if (recognitionWarnings.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text(recognitionWarnings.join('\n')),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '药品名称（唯一必填）',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: nameController,
                      onChanged: (_) {
                        touchedName = true;
                        _markDirty();
                      },
                      textCapitalization: TextCapitalization.sentences,
                      decoration: InputDecoration(
                        hintText: '例如：布洛芬缓释胶囊',
                        errorText:
                            touchedName && nameController.text.trim().isEmpty
                            ? '请填写药品名称'
                            : null,
                      ),
                    ),
                    const SizedBox(height: 14),
                    Text(
                      '库存与有效期（选填）',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 8),
                    _quantityUnitFields(
                      quantityLabels: const ['剩余数量', '未知可留空'],
                      unitLabels: kQuantityUnitValues.map(unitLabel),
                      quantityField: TextField(
                        controller: quantityController,
                        onChanged: (_) => _markDirty(),
                        keyboardType: const TextInputType.numberWithOptions(
                          decimal: true,
                        ),
                        decoration: const InputDecoration(
                          labelText: '剩余数量',
                          hintText: '未知可留空',
                        ),
                      ),
                      unitField: DropdownButtonFormField<String>(
                        key: ValueKey(unit),
                        initialValue: unit,
                        isExpanded: true,
                        decoration: const InputDecoration(labelText: '单位'),
                        // R08：单位选择器使用共享单位表，确保 ml/blister 始终在列，
                        // 避免 initialValue 找不到 item 触发断言。
                        items: kQuantityUnitValues
                            .map(
                              (value) => DropdownMenuItem<String>(
                                value: value,
                                child: Text(unitLabel(value)),
                              ),
                            )
                            .toList(growable: false),
                        onChanged: (value) {
                          setState(() => unit = value ?? 'box');
                          _markDirty();
                        },
                      ),
                    ),
                    const SizedBox(height: 12),
                    InkWell(
                      key: const ValueKey('api-expiry-date-field'),
                      onTap: _selectExpiryDate,
                      child: InputDecorator(
                        decoration: const InputDecoration(
                          labelText: '包装有效期',
                          suffixIcon: Icon(Icons.calendar_month_outlined),
                        ),
                        child: Text(
                          key: const ValueKey('api-expiry-date-value'),
                          expiryController.text.isEmpty
                              ? '滑动选择年、月、日'
                              : displayExpiryDate(expiryController.text),
                        ),
                      ),
                    ),
                    TextButton.icon(
                      onPressed: saving
                          ? null
                          : () => _chooseImage(
                              action: _ImageAction.camera,
                              expiryPhoto: true,
                            ),
                      icon: const Icon(Icons.add_a_photo_outlined),
                      label: Text(
                        expiryImage == null ? '补拍有效期照片' : '已保留有效期照片（可补拍）',
                      ),
                    ),
                    if (expiryController.text.isNotEmpty)
                      Align(
                        alignment: Alignment.centerLeft,
                        child: PopupMenuButton<String>(
                          tooltip: '选择有效期精度',
                          onSelected: _setExpiryPrecision,
                          itemBuilder: (_) => const [
                            PopupMenuItem(value: 'day', child: Text('精确到日')),
                            PopupMenuItem(value: 'month', child: Text('精确到月')),
                          ],
                          child: Padding(
                            padding: const EdgeInsets.only(top: 4),
                            child: Text(
                              '按包装印刷精度保存：${expiryPrecision == 'month' ? '年月' : '年月日'}　修改',
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ),
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
                    _optionalSection(
                      title: '开封信息（选填）',
                      expanded: openingExpanded,
                      onTap: () {
                        setState(() => openingExpanded = !openingExpanded);
                        _markDirty();
                      },
                    ),
                    if (openingExpanded) ...[
                      const SizedBox(height: 12),
                      _openingSegments(
                        labels: const {
                          'unknown': '未记录',
                          'unopened': '未开封',
                          'opened': '已开封',
                        },
                        selected: openedState,
                        onSelectionChanged: (value) {
                          setState(() => openedState = value.first);
                          _markDirty();
                        },
                      ),
                      if (openedState == 'opened') ...[
                        const SizedBox(height: 12),
                        SoftButton(
                          label: openedAt == null ? '选择开封日期' : '开封日期：$openedAt',
                          icon: Icons.event_outlined,
                          onPressed: _pickOpenedDate,
                        ),
                        const SizedBox(height: 10),
                        const Text('按说明书填写开封后的期限，不确定时留空。系统不会自动推定期限。'),
                        const SizedBox(height: 8),
                        _openingSegments(
                          labels: const {'duration': '经过时长', 'date': '截止日期'},
                          selected: afterOpenKind,
                          onSelectionChanged: (value) {
                            setState(() => afterOpenKind = value.first);
                            _markDirty();
                          },
                        ),
                        const SizedBox(height: 10),
                        if (afterOpenKind == 'duration')
                          _quantityUnitFields(
                            quantityLabels: const ['开封后期限', '例如 30'],
                            unitLabels: const ['选择', '天', '月'],
                            quantityField: TextField(
                              controller: afterOpenValueController,
                              onChanged: (_) => _markDirty(),
                              keyboardType: TextInputType.number,
                              decoration: const InputDecoration(
                                labelText: '开封后期限',
                                hintText: '例如 30',
                              ),
                            ),
                            unitField: DropdownButtonFormField<String>(
                              key: ValueKey(afterOpenUnit),
                              initialValue: afterOpenUnit,
                              isExpanded: true,
                              decoration: const InputDecoration(
                                labelText: '单位',
                              ),
                              hint: const Text('选择'),
                              items: const [
                                DropdownMenuItem(
                                  value: 'day',
                                  child: Text('天'),
                                ),
                                DropdownMenuItem(
                                  value: 'month',
                                  child: Text('月'),
                                ),
                              ],
                              onChanged: (value) {
                                setState(() => afterOpenUnit = value);
                                _markDirty();
                              },
                            ),
                          )
                        else
                          TextField(
                            controller: afterOpenDateController,
                            onChanged: (_) => _markDirty(),
                            keyboardType: TextInputType.datetime,
                            decoration: const InputDecoration(
                              label: Text('开封后截止日期'),
                              hintText: 'YYYY-MM-DD',
                            ),
                          ),
                      ],
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 12),
              AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _optionalSection(
                      title: '分类与位置（选填）',
                      expanded: categoryExpanded,
                      onTap: () =>
                          setState(() => categoryExpanded = !categoryExpanded),
                    ),
                    if (categoryExpanded) ...[
                      TextField(
                        controller: purposeController,
                        onChanged: (_) => _markDirty(),
                        decoration: const InputDecoration(
                          labelText: '用途分类 / 标签',
                          hintText: '保留你填写的分类文案',
                        ),
                      ),
                      TextField(
                        controller: locationController,
                        onChanged: (_) => _markDirty(),
                        decoration: const InputDecoration(
                          labelText: '存放位置（选填）',
                          hintText: '例如：厨房抽屉',
                        ),
                      ),
                    ],
                    const SizedBox(height: 12),
                    _optionalSection(
                      title: '更多资料（选填）',
                      expanded: moreExpanded,
                      onTap: () {
                        setState(() => moreExpanded = !moreExpanded);
                        _markDirty();
                      },
                    ),
                    if (moreExpanded) ...[
                      const SizedBox(height: 12),
                      TextField(
                        controller: specificationController,
                        onChanged: (_) => _markDirty(),
                        decoration: const InputDecoration(labelText: '规格'),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: manufacturerController,
                        onChanged: (_) => _markDirty(),
                        decoration: const InputDecoration(labelText: '厂家'),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: approvalController,
                        onChanged: (_) => _markDirty(),
                        decoration: const InputDecoration(labelText: '批准文号'),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: ingredientController,
                        onChanged: (_) => _markDirty(),
                        decoration: const InputDecoration(
                          labelText: '成分（多个请用逗号分开）',
                        ),
                      ),
                      CheckboxListTile(
                        contentPadding: EdgeInsets.zero,
                        value: ingredientsVerified,
                        onChanged: (value) {
                          setState(() => ingredientsVerified = value == true);
                          _markDirty();
                        },
                        title: const Text('已对照包装核对有效成分'),
                        subtitle: const Text('未核对的成分不会触发家庭内重复成分提示。'),
                      ),
                      const SizedBox(height: 12),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 10),
              Text(
                '数量和日期不确定时可以先留空。任何识别字段都需要人工核对后才会保存。',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

bool _validExpiry(String value, String precision) {
  final monthMatch = RegExp(r'^(\d{4})-(\d{2})$').firstMatch(value);
  if (precision == 'month' && monthMatch != null) {
    final month = int.parse(monthMatch.group(2)!);
    return month >= 1 && month <= 12;
  }
  final date = DateTime.tryParse(value);
  if (precision != 'day' || date == null || value.length != 10) return false;
  return '${date.year.toString().padLeft(4, '0')}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}' ==
      value;
}

String? _nullableText(String value) =>
    value.trim().isEmpty ? null : value.trim();
String _date(DateTime value) =>
    '${value.year.toString().padLeft(4, '0')}-${value.month.toString().padLeft(2, '0')}-${value.day.toString().padLeft(2, '0')}';

class _BarcodeScanPage extends StatefulWidget {
  const _BarcodeScanPage();

  @override
  State<_BarcodeScanPage> createState() => _BarcodeScanPageState();
}

class _BarcodeScanPageState extends State<_BarcodeScanPage> {
  bool handled = false;

  void _onDetect(BarcodeCapture capture) {
    if (handled || capture.barcodes.isEmpty) return;
    final code = capture.barcodes.first.rawValue?.trim();
    if (code == null || code.isEmpty) return;
    handled = true;
    Navigator.of(context).pop(code);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('扫描药盒编码')),
    body: Stack(
      children: [
        MobileScanner(
          onDetect: _onDetect,
          errorBuilder: (context, error) => ColoredBox(
            color: Colors.black,
            child: Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(
                      Icons.no_photography_outlined,
                      color: Colors.white,
                      size: 40,
                    ),
                    const SizedBox(height: 12),
                    Text(
                      error.errorCode.name == 'permissionDenied'
                          ? '相机权限未开启。请到系统设置 → 应用 → 家庭药箱 → 权限中允许相机，然后重试。'
                          : '相机暂不可用，请检查设备或重试。',
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: Colors.white),
                    ),
                    const SizedBox(height: 12),
                    FilledButton.tonal(
                      onPressed: () => Navigator.of(context).maybePop(),
                      child: const Text('返回录入'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
        const Align(
          alignment: Alignment.bottomCenter,
          child: Padding(
            padding: EdgeInsets.all(24),
            child: Card(
              child: Padding(
                padding: EdgeInsets.all(14),
                child: Text('对准药盒条形码或二维码。读取编码只生成候选，不代表药品资料已经核实。'),
              ),
            ),
          ),
        ),
      ],
    ),
  );
}
