import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:path_provider/path_provider.dart';

import '../../core/widgets/app_surfaces.dart';
import '../../core/widgets/expiry_date_wheel_picker.dart';
import '../../core/widgets/medicine_tags.dart';
import '../../data/api_client.dart';
import '../../data/api_medicine_repository.dart';
import '../../data/api_workflow_repository.dart';
import '../../data/medicine_recognition.dart';
import '../../data/app_stores.dart';
import '../../data/medicine_draft_queue.dart';
import '../../data/medicine_owned_photo.dart';
import '../../domain/ingredient_match.dart';
import '../../models/medicine_models.dart';

enum _ImageAction { camera, gallery }

bool _isProductBarcode(String code) => RegExp(r'^\d{8,14}$').hasMatch(code);
bool _isTraceabilityCode(String code) => RegExp(r'^\d{20}$').hasMatch(code);

String _recognitionErrorMessage(Object error) {
  if (error is FileSystemException) return '无法读取本机照片，请重新选择或拍照。';
  if (error is FormatException) {
    const messages = {
      '请选择不超过 4 MB 的药盒照片。',
      '照片格式或大小不正确。',
      '仅支持 JPEG 或 PNG 药盒照片。',
    };
    return messages.contains(error.message)
        ? error.message
        : '识别结果格式异常，请重试或手动录入。';
  }
  if (error is MissingPluginException || error is PlatformException) {
    return '本机识别暂不可用，可选择 AI 识别或手动录入。';
  }
  return friendlyApiError(error);
}

enum _DraftExitAction { keep, discard, continueEditing }

class _DraftSaveFailure implements Exception {
  const _DraftSaveFailure();
}

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
  final brandController = TextEditingController();
  final leafletControllers = {
    for (final key in [
      'purposeSummary',
      'packageUsageSummary',
      'precautionsSummary',
      'contraindicationsSummary',
    ])
      key: TextEditingController(),
  };
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
  final photoDrafts = <Map<String, dynamic>>[];
  bool usePhotoAsCover = true;
  bool cleanupPending = false;
  bool get _isCleanupDraft =>
      cleanupPending ||
      photoDrafts.any((photo) => photo['cleanupState'] != null);
  void _showCleanupHint() {
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('此草稿仅待本机清理，请从“导入草稿”的删除入口重试；不会再次入库或上传。')),
      );
    }
  }

  String cleanupMessage = "本机照片清理未完成，草稿已保留，请稍后重试。";
  bool openingExpanded = false;
  bool categoryExpanded = true;
  bool locationExpanded = false;
  Timer? recognitionTimer;
  int recognitionSeconds = 0;
  final populationTags = <String>{};
  final purposeTags = <String>{};
  bool purposeTagsTouched = false;
  late final MedicineDraftQueue draftQueue = MedicineDraftQueue(
    widget.localStore,
    isCurrent: () => mounted && _isDraftIdentityCurrent,
    scope: entryIdentity,
    ownerKey: widget.repository.api.identityState?.owner == null
        ? null
        : base64Url.encode(
            utf8.encode(
              jsonEncode([
                widget.repository.api.baseUrl,
                entryIdentity.$6,
                entryIdentity.$7,
              ]),
            ),
          ),
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
  String? _verifiedIngredientContent;
  int _ingredientRevision = 0;
  int _catalogRequest = 0;

  List<String> get _ingredientValues => ingredientController.text
      .split(RegExp(r'[,，、;；]'))
      .map((item) => item.trim())
      .where((item) => item.isNotEmpty)
      .toList();

  // Only normalize separators and surrounding whitespace, exactly as Save does.
  // Never infer that different ingredient names or doses are equivalent.
  String get _ingredientContent => jsonEncode(_ingredientValues);
  String _lastIngredientContent = '[]';

  bool get ingredientsVerified =>
      _verifiedIngredientContent != null &&
      _verifiedIngredientContent == _ingredientContent;

  set ingredientsVerified(bool value) {
    _verifiedIngredientContent = value && _ingredientValues.isNotEmpty
        ? _ingredientContent
        : null;
  }

  void _ingredientsChanged() {
    final content = _ingredientContent;
    if (content == _lastIngredientContent) return;
    _lastIngredientContent = content;
    _ingredientRevision++;
    if (_verifiedIngredientContent != null) {
      setState(() => _verifiedIngredientContent = null);
    }
  }

  bool recognizing = false;
  bool searchingCatalog = false;
  bool saving = false;
  Object? inventorySaveIntent;
  bool dirty = false;
  bool handlingBack = false;
  bool restoringDraft = false;
  bool touchedName = false;
  bool touchedExpiry = false;
  Map<String, dynamic>? attemptedPayload;
  Object? recognitionFailure;
  List<String> recognitionWarnings = const [];

  String get _draftKey => entryIdentity.$6 == null || entryIdentity.$7 == null
      ? 'medicine-entry'
      : 'medicine-entry.${base64Url.encode(utf8.encode(jsonEncode([entryIdentity.$3, entryIdentity.$6, entryIdentity.$7])))}';
  bool restoredDraft = false;

  @override
  void initState() {
    super.initState();
    entryIdentity = _identitySnapshot();
    ingredientController.addListener(_ingredientsChanged);
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

  void _applyDraft(Map<String, dynamic> json) {
    // A response belongs to the selected draft instance, even when IDs match.
    _catalogRequest++;
    searchingCatalog = false;
    nameController.text = json['name'] as String? ?? '';
    brandController.text = json['brand'] as String? ?? '';
    final leaflet = json['leaflet'];
    if (leaflet is Map) {
      for (final entry in leafletControllers.entries) {
        entry.value.text = leaflet[entry.key] as String? ?? '';
      }
    }
    specificationController.text = json['specification'] as String? ?? '';
    quantityController.text = json['quantity'] as String? ?? '';
    expiryController.text = json['expiry'] as String? ?? '';
    locationController.text = json['location'] as String? ?? '';
    manufacturerController.text = json['manufacturer'] as String? ?? '';
    approvalController.text = json['approval'] as String? ?? '';
    ingredientController.text = json['ingredients'] as String? ?? '';
    purposeController.text = json['purpose'] as String? ?? '';
    populationTags
      ..clear()
      ..addAll(
        (json['populationTags'] as List? ?? []).whereType<String>().where(
          medicinePopulationLabels.containsKey,
        ),
      );
    purposeTags
      ..clear()
      ..addAll(
        (json['purposeTags'] as List? ?? []).whereType<String>().where(
          medicinePurposeLabels.containsKey,
        ),
      );
    purposeTagsTouched = json['purposeTagsTouched'] == true;
    // Legacy booleans cannot prove which content was confirmed. Keep the draft,
    // but require reconfirmation unless its stored content binding matches.
    _verifiedIngredientContent =
        json['ingredientsVerified'] == true &&
            _ingredientValues.isNotEmpty &&
            json['verifiedIngredientContent'] == _ingredientContent
        ? _ingredientContent
        : null;
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
    photoDrafts
      ..clear()
      ..addAll(
        (json['photos'] as List? ?? []).whereType<Map<String, dynamic>>().map(
          (photo) => Map<String, dynamic>.from(photo),
        ),
      );
    usePhotoAsCover = json['usePhotoAsCover'] != false;
    cleanupPending = json['cleanupPending'] == true;
    if (photoDrafts.any(
      (photo) => photo['path'] == image?.path && photo['cleanupState'] != null,
    )) {
      image = null;
    }
    if (photoDrafts.any(
      (photo) =>
          photo['path'] == expiryImage?.path && photo['cleanupState'] != null,
    )) {
      expiryImage = null;
    }
    _syncPhotoDrafts();
    touchedName = false;
    restoredDraft = true;
  }

  void _syncPhotoDrafts([List<Map<String, dynamic>>? target]) {
    final photos = target ?? photoDrafts;
    for (final item in [
      (image, 'box_front', frontPhotoId),
      (expiryImage, 'expiry', expiryPhotoId),
    ]) {
      final file = item.$1;
      if (file != null && !photos.any((photo) => photo['path'] == file.path)) {
        photos.add({
          'path': file.path,
          'purpose': item.$2,
          'uploadedId': item.$3,
        });
      }
    }
  }

  Map<String, dynamic> _draftFields() {
    final photos = List<Map<String, dynamic>>.of(photoDrafts);
    _syncPhotoDrafts(photos);
    return {
      'name': nameController.text,
      'brand': brandController.text,
      'leaflet': {
        for (final entry in leafletControllers.entries)
          entry.key: entry.value.text,
      },
      'specification': specificationController.text,
      'quantity': quantityController.text,
      'expiry': expiryController.text,
      'location': locationController.text,
      'manufacturer': manufacturerController.text,
      'approval': approvalController.text,
      'ingredients': ingredientController.text,
      'purpose': purposeController.text,
      'populationTags': populationTags.toList(),
      'purposeTags': purposeTags.toList(),
      'purposeTagsTouched': purposeTagsTouched,
      'ingredientsVerified': ingredientsVerified,
      'verifiedIngredientContent': ingredientsVerified
          ? _verifiedIngredientContent
          : null,
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
      'photos': photos
          .map((photo) => Map<String, dynamic>.from(photo))
          .toList(),
      'usePhotoAsCover': usePhotoAsCover,
      'cleanupPending': cleanupPending,
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
  }

  Future<bool> _saveDraft({bool legacy = true}) async {
    if (!mounted || !_isDraftIdentityCurrent) return false;
    final id = draftId;
    final fields = _draftFields();
    var acknowledged = false;
    await _persistDraft(() async {
      acknowledged = await draftQueue.save(id, fields);
      if (!acknowledged) return;
      if (legacy && mounted && _isDraftIdentityCurrent) {
        final previous = await widget.localStore.readDraft(_draftKey);
        if (!mounted || !_isDraftIdentityCurrent) return;
        if (previous != null && previous.isNotEmpty) {
          final value = jsonDecode(previous);
          if (value is! Map || value['id'] != id) return;
        }
        await widget.localStore.saveDraft(
          _draftKey,
          jsonEncode({...fields, 'id': id}),
        );
      }
    });
    return acknowledged;
  }

  // Explicit decisions require a durable ACK. Autosave keeps using the
  // best-effort bool API, without showing unsolicited failure prompts.
  Future<void> _requireDraftSave({bool legacy = true}) async {
    try {
      if (!await _saveDraft(legacy: legacy)) throw const _DraftSaveFailure();
    } catch (_) {
      throw const _DraftSaveFailure();
    }
  }

  void _showDraftSaveFailure() {
    if (mounted && _isDraftIdentityCurrent) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('草稿保存失败，内容仍在当前页面。请重试。')));
    }
  }

  String _editableSnapshot() {
    final fields = _draftFields()
      ..remove('cleanupPending')
      ..remove('status');
    for (final photo in (fields['photos'] as List)) {
      (photo as Map).remove('cleanupState');
    }
    return jsonEncode(fields);
  }

  Future<bool> _cleanupDraftPhotos(
    String id,
    Map<String, dynamic> fields,
  ) async {
    final photos = (fields['photos'] as List? ?? [])
        .whereType<Map<String, dynamic>>()
        .toList();
    final owned = photos.where((photo) => photo['ownedLocal'] != null).toList();
    if (photos.isEmpty) return true;
    var unknown = false;
    cleanupMessage = "本机照片清理未完成，草稿已保留，请稍后重试。";
    bool current() => mounted && _isDraftIdentityCurrent;
    if (!current()) return false;
    if (id == draftId) {
      recognitionRequest++;
      recognitionTimer?.cancel();
      setState(() {
        cleanupPending = true;
        recognizing = false;
      });
    }
    void sync(Map<String, dynamic> photo) {
      if (id != draftId) return;
      for (final local in photoDrafts.where(
        (local) => local['path'] == photo['path'],
      )) {
        local['cleanupState'] = photo['cleanupState'];
      }
    }

    Future<bool> persist() => draftQueue.save(id, {
      ...fields,
      'photos': photos,
      'cleanupPending': true,
    });
    final support = owned.isEmpty
        ? null
        : await getApplicationSupportDirectory();
    if (!current()) return false;
    for (final photo in photos) {
      if (photo['ownedLocal'] == null) {
        unknown = true;
        photo['cleanupState'] = 'unknown';
        sync(photo);
        cleanupMessage = '旧照片归属未确认，已保留照片和草稿，未执行删除。';
        if (!await persist() || !current()) return false;
        continue;
      }
      if (photo['cleanupState'] == 'done') continue;
      photo['cleanupState'] = 'pending';
      sync(photo);
      if (!await persist() || !current()) return false;
      if (!await cleanupMedicinePhoto(
        supportPath: support!.path,
        draftId: id,
        photo: photo,
        isCurrent: current,
      )) {
        return false;
      }
      photo['cleanupState'] = 'done';
      sync(photo);
      if (!await persist() || !current()) return false;
    }
    return current() && !unknown;
  }

  Future<void> _deleteOwnLegacyDraft(String id) async {
    final raw = await widget.localStore.readDraft(_draftKey);
    if (!mounted || !_isDraftIdentityCurrent || raw == null || raw.isEmpty) {
      return;
    }
    try {
      final value = jsonDecode(raw);
      if (value is Map && value['id'] == id) {
        await widget.localStore.deleteDraft(_draftKey);
      }
    } on FormatException {
      /* Unknown legacy content is preserved. */
    }
  }

  Future<void> _chooseDraft() async {
    if (handlingBack || !_isDraftIdentityCurrent) return;
    final originalId = draftId;
    if (dirty) {
      try {
        await _requireDraftSave(legacy: false);
      } catch (_) {
        if (mounted && _isDraftIdentityCurrent && draftId == originalId) {
          _showDraftSaveFailure();
        }
        return;
      }
    }
    if (!mounted || !_isDraftIdentityCurrent || handlingBack) return;
    final drafts = await draftQueue.list();
    final legacy = await widget.localStore.readDraft(_draftKey);
    if (legacy != null && legacy.isNotEmpty) {
      try {
        final value = jsonDecode(legacy);
        if (value is Map<String, dynamic> &&
            value['id'] is String &&
            !drafts.any((draft) => draft['id'] == value['id'])) {
          drafts.add(value);
        }
      } on FormatException {
        /* Keep unrecognized legacy drafts untouched. */
      }
    }
    if (!mounted ||
        !_isDraftIdentityCurrent ||
        handlingBack ||
        draftId != originalId) {
      return;
    }
    final selected = await showAppSheet<Map<String, dynamic>>(
      context,
      title: '恢复未完成的药品录入',
      builder: (context) => Material(
        type: MaterialType.transparency,
        child: ListView(
          shrinkWrap: true,
          children: [
            ...drafts.map(
              (draft) => ListTile(
                title: Text(draft['name'] as String? ?? '未命名药品'),
                subtitle: Text(
                  draft['savedMedicineId'] != null
                      ? '药已保存 · 照片待补'
                      : '待核对 · 未入库',
                ),
                onTap: () => Navigator.pop(context, draft),
                trailing: IconButton(
                  tooltip: '删除草稿',
                  icon: const Icon(Icons.delete_outline),
                  onPressed: () async {
                    if (!await _cleanupDraftPhotos(
                      draft['id'] as String,
                      draft,
                    )) {
                      if (mounted) {
                        ScaffoldMessenger.of(
                          this.context,
                        ).showSnackBar(SnackBar(content: Text(cleanupMessage)));
                      }
                      return;
                    }
                    await draftQueue.remove(draft['id'] as String);
                    if (mounted && _isDraftIdentityCurrent) {
                      await _deleteOwnLegacyDraft(draft['id'] as String);
                      if (mounted &&
                          _isDraftIdentityCurrent &&
                          draftId == draft['id']) {
                        recognitionRequest++;
                        setState(() {
                          _applyDraft({
                            'id': DateTime.now().microsecondsSinceEpoch
                                .toString(),
                          });
                          dirty = false;
                          restoredDraft = false;
                        });
                      }
                    }
                    if (context.mounted) Navigator.pop(context);
                  },
                ),
              ),
            ),
          ],
        ),
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
    setState(() {
      _applyDraft(selected);
      dirty = false;
      recognizing = false;
      recognitionFailure = null;
      restoredDraft = selected.isNotEmpty;
    });
    final selectedId = draftId;

    if (selected.isNotEmpty &&
        mounted &&
        _isDraftIdentityCurrent &&
        !handlingBack &&
        draftId == selectedId) {
      try {
        await _requireDraftSave();
      } catch (_) {
        if (mounted && _isDraftIdentityCurrent && draftId == selectedId) {
          _showDraftSaveFailure();
        }
      }
    }
  }

  void _markDirty() {
    if (!dirty && mounted) setState(() => dirty = true);
    autoSave?.cancel();
    if (handlingBack || !_isDraftIdentityCurrent) return;
    autoSave = Timer(const Duration(milliseconds: 200), () {
      if (mounted) {
        unawaited(_saveDraft(legacy: false).catchError((Object _) => false));
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
          await _requireDraftSave();
          if (!isCurrentIntent()) return;
        } while (snapshot != jsonEncode(_draftFields()));
      } else {
        final snapshot = _editableSnapshot();
        if (!await _cleanupDraftPhotos(id, _draftFields())) {
          throw StateError('本机照片清理未完成，草稿已保留。');
        }
        if (!isCurrentIntent()) return;
        await _persistDraft(() async {
          if (!isCurrentIntent()) return;
          await _deleteOwnLegacyDraft(id);
          if (!isCurrentIntent()) return;
          await draftQueue.remove(id);
        });
        if (!isCurrentIntent()) return;
        if (snapshot != _editableSnapshot()) {
          // The discard decision did not cover edits entered while deleting.
          await _requireDraftSave();
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
            action == _DraftExitAction.discard && cleanupPending
                ? cleanupMessage
                : action == _DraftExitAction.discard
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
    recognitionTimer?.cancel();
    brandController.dispose();
    for (final controller in leafletControllers.values) {
      controller.dispose();
    }
    nameController.dispose();
    specificationController.dispose();
    quantityController.dispose();
    expiryController.dispose();
    locationController.dispose();
    manufacturerController.dispose();
    approvalController.dispose();
    ingredientController.removeListener(_ingredientsChanged);
    ingredientController.dispose();
    purposeController.dispose();
    afterOpenValueController.dispose();
    afterOpenDateController.dispose();
    super.dispose();
  }

  Future<void> _chooseImage({
    _ImageAction? action,
    bool expiryPhoto = false,
    bool leafletPhoto = false,
  }) async {
    if (_isCleanupDraft) {
      _showCleanupHint();
      return;
    }
    if (!_isDraftIdentityCurrent) return;
    final entryDraftId = draftId;
    action ??= await showAppSheet<_ImageAction>(
      context,
      title: '拍药盒',
      builder: (sheetContext) => Column(
        children: [
          choiceTile(
            sheetContext,
            icon: Icons.camera_alt_rounded,
            title: '拍照识别',
            subtitle: '可选本机或 AI 识别，发送前确认',
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
    if (action == null ||
        !mounted ||
        !_isDraftIdentityCurrent ||
        draftId != entryDraftId) {
      return;
    }
    if (_isCleanupDraft) {
      _showCleanupHint();
      return;
    }
    Directory? unregisteredDirectory;
    final request = ++recognitionRequest;
    final previousPhotos = (image, expiryImage, frontPhotoId, expiryPhotoId);
    void restorePreviousPhotos() {
      image = previousPhotos.$1;
      expiryImage = previousPhotos.$2;
      frontPhotoId = previousPhotos.$3;
      expiryPhotoId = previousPhotos.$4;
    }

    try {
      final selected = await imagePicker.pickImage(
        source: action == _ImageAction.camera
            ? ImageSource.camera
            : ImageSource.gallery,
        imageQuality: 90,
        maxWidth: 1800,
      );
      if (selected == null ||
          !mounted ||
          !_isDraftIdentityCurrent ||
          draftId != entryDraftId ||
          request != recognitionRequest) {
        return;
      }
      if (_isCleanupDraft) {
        _showCleanupHint();
        return;
      }
      final support = await getApplicationSupportDirectory();
      if (!mounted ||
          !_isDraftIdentityCurrent ||
          draftId != entryDraftId ||
          request != recognitionRequest) {
        return;
      }
      final directory = Directory('${support.path}/medicine-draft-images');
      await directory.create(recursive: true);
      final originalBytes = await File(selected.path).readAsBytes();
      final extension =
          originalBytes.length > 3 &&
              originalBytes[0] == 137 &&
              originalBytes[1] == 80
          ? 'png'
          : 'jpg';
      if (!mounted ||
          request != recognitionRequest ||
          !_isDraftIdentityCurrent) {
        return;
      }
      final purpose = leafletPhoto
          ? 'leaflet'
          : expiryPhoto
          ? 'expiry'
          : 'box_front';
      final ownedDirectory = await directory.createTemp('$draftId-$purpose-');
      unregisteredDirectory = ownedDirectory;
      if (!mounted ||
          request != recognitionRequest ||
          !_isDraftIdentityCurrent) {
        return;
      }
      final path = '${ownedDirectory.path}/original.$extension';
      final pendingPhoto = <String, dynamic>{
        'path': path,
        'purpose': purpose,
        'state': 'reserved',
        'ownedLocal': {
          'supportPath': support.path,
          'directory': ownedDirectory.path,
          'draftId': draftId,
          'purpose': purpose,
          'path': path,
        },
      };
      _syncPhotoDrafts();
      photoDrafts.add(pendingPhoto);
      final reserved = await _saveDraft(legacy: false)
          .catchError((Object _) => throw const _DraftSaveFailure());
      if (!reserved) {
        photoDrafts.remove(pendingPhoto);
        if (mounted && _isDraftIdentityCurrent) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('本机照片草稿保存失败，未复制或发送照片，请重试。')),
          );
        }
        return;
      }
      // Durable ownership must precede private bytes, including process death.
      unregisteredDirectory = null;
      if (!mounted ||
          request != recognitionRequest ||
          !_isDraftIdentityCurrent) {
        return;
      }
      final durable = await File(selected.path).copy(path);
      if (!mounted ||
          request != recognitionRequest ||
          !_isDraftIdentityCurrent) {
        return;
      }
      pendingPhoto['state'] = 'ready';
      try {
        await _requireDraftSave(legacy: false);
      } catch (_) {
        pendingPhoto['state'] = 'reserved';
        rethrow;
      }
      if (!mounted ||
          request != recognitionRequest ||
          !_isDraftIdentityCurrent) {
        return;
      }
      if (expiryPhoto) {
        expiryImage = XFile(durable.path);
        expiryPhotoId = null;
      } else if (!leafletPhoto) {
        image = XFile(durable.path);
        frontPhotoId = null;
      }
      _markDirty();
      try {
        await _requireDraftSave(legacy: false);
      } catch (_) {
        restorePreviousPhotos();
        rethrow;
      }
      if (!mounted ||
          request != recognitionRequest ||
          !_isDraftIdentityCurrent) {
        return;
      }
      setState(() {
        recognizing = true;
        recognitionFailure = null;
        recognitionWarnings = const [];
      });
      await _requireDraftSave(legacy: false);
      try {
        if (!mounted ||
            request != recognitionRequest ||
            !_isDraftIdentityCurrent) {
          return;
        }
        final useServer = await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: Text(leafletPhoto ? '识别说明书文字？' : '使用 AI 识别药盒？'),
            content: const Text(
              '照片将发送到当前家庭药箱服务，由其配置的识别模型生成药名和分类草稿，不会在识别接口保存照片。请核对后再保存。',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: Text(leafletPhoto ? '取消' : '仅本机识别'),
              ),
              TextButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('AI 识别'),
              ),
            ],
          ),
        );
        if (!mounted ||
            request != recognitionRequest ||
            !_isDraftIdentityCurrent) {
          return;
        }
        if (useServer == null || (leafletPhoto && useServer != true)) {
          setState(() => recognizing = false);
          return;
        }
        recognitionTimer?.cancel();
        setState(() => recognitionSeconds = 0);
        recognitionTimer = Timer.periodic(const Duration(seconds: 1), (_) {
          if (mounted) setState(() => recognitionSeconds++);
        });
        final draft =
            await (useServer == true
                    ? ApiMedicineRecognitionRepository(
                        widget.repository.api,
                        purpose: leafletPhoto ? 'leaflet' : 'box_front',
                        isCurrent: () =>
                            mounted &&
                            request == recognitionRequest &&
                            draftId == entryDraftId &&
                            _isDraftIdentityCurrent &&
                            !_isCleanupDraft,
                      )
                    : recognition)
                .recognize(XFile(durable.path));
        if (!mounted ||
            request != recognitionRequest ||
            !_isDraftIdentityCurrent) {
          return;
        }
        recognitionTimer?.cancel();
        if (brandController.text.trim().isEmpty) {
          brandController.text = draft.brand ?? '';
        }
        if (manufacturerController.text.trim().isEmpty) {
          manufacturerController.text = draft.manufacturer ?? '';
        }
        if (populationTags.isEmpty) {
          populationTags.addAll(
            draft.populationTags.where(medicinePopulationLabels.containsKey),
          );
        }
        for (final entry in leafletControllers.entries) {
          if (entry.value.text.trim().isEmpty) {
            entry.value.text = draft.leaflet[entry.key] ?? '';
          }
        }
        if (!touchedName && nameController.text.trim().isEmpty) {
          nameController.text = draft.name;
        }
        if (purposeController.text.trim().isEmpty &&
            draft.purposeCategory != null) {
          purposeController.text = draft.purposeCategory!;
        }
        if (purposeTags.isEmpty && !purposeTagsTouched) {
          purposeTags.addAll(
            draft.purposeTags.where(medicinePurposeLabels.containsKey),
          );
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
        await _requireDraftSave(legacy: false);
      } catch (error) {
        if (!mounted ||
            request != recognitionRequest ||
            !_isDraftIdentityCurrent ||
            draftId != entryDraftId) {
          return;
        }
        recognitionTimer?.cancel();
        setState(() {
          recognizing = false;
          recognitionFailure = error;
        });
        if (error is _DraftSaveFailure) {
          _showDraftSaveFailure();
          return;
        }
        try {
          await _requireDraftSave(legacy: false);
        } catch (_) {
          _showDraftSaveFailure();
        }
      }
    } catch (error) {
      final pending = unregisteredDirectory;
      if (pending != null &&
          photoDrafts.any(
            (photo) => (photo['path'] as String).startsWith('${pending.path}/'),
          )) {
        try {
          final persisted = await draftQueue.list();
          if (persisted.any(
            (draft) => (draft['photos'] as List? ?? []).any(
              (photo) =>
                  photo is Map &&
                  (photo['path'] as String? ?? '').startsWith(
                    '${pending.path}/',
                  ),
            ),
          )) {
            unregisteredDirectory = null;
          } else {
            photoDrafts.removeWhere(
              (photo) =>
                  (photo['path'] as String).startsWith('${pending.path}/'),
            );
            restorePreviousPhotos();
          }
        } catch (_) {
          // An unknown storage ACK must never cause deletion of a referenced original.
          unregisteredDirectory = null;
        }
      }
      if (!mounted ||
          !_isDraftIdentityCurrent ||
          draftId != entryDraftId ||
          request != recognitionRequest) {
        return;
      }
      if (error is _DraftSaveFailure) {
        if (_isDraftIdentityCurrent) {
          recognitionTimer?.cancel();
          setState(() {
            recognizing = false;
            recognitionFailure = error;
          });
          _showDraftSaveFailure();
        }
        return;
      }
      final source = action == _ImageAction.camera ? '相机' : '相册';
      final denied =
          error is PlatformException &&
          const {
            'camera_access_denied',
            'photo_access_denied',
            'camera_access_restricted',
            'photo_access_restricted',
            'camera_access_denied_without_prompt',
            'photo_access_denied_without_prompt',
          }.contains(error.code.toLowerCase());
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            error is FileSystemException
                ? '无法读取或保存所选照片，请重新选择或拍照。'
                : denied
                ? '$source权限未开启，请在系统设置中允许访问。'
                : '无法打开$source，请重试或${action == _ImageAction.camera ? '从相册选择' : '拍照录入'}。',
          ),
        ),
      );
    } finally {
      final abandoned = unregisteredDirectory;
      if (abandoned != null) {
        // createTemp returned this new, exclusive directory in this attempt.
        // Its only possible contents are our unfinished copy, never old photos.
        try {
          await abandoned.delete();
        } on FileSystemException {
          // Retain an unremovable original rather than broaden cleanup scope.
        }
      }
    }
  }

  Future<void> _scanCode() async {
    if (_isCleanupDraft) {
      _showCleanupHint();
      return;
    }
    if (!_isDraftIdentityCurrent) return;
    final request = recognitionRequest;
    final entryDraftId = draftId;
    final code = await Navigator.of(
      context,
    ).push<String>(MaterialPageRoute(builder: (_) => const _BarcodeScanPage()));
    if (!mounted ||
        code == null ||
        _isCleanupDraft ||
        draftId != entryDraftId ||
        !_isDraftIdentityCurrent ||
        request != recognitionRequest) {
      return;
    }
    if (!_isProductBarcode(code) && !_isTraceabilityCode(code)) return;
    setState(() => scannedCode = code);
    _markDirty();
    await _searchCatalog(barcode: code);
  }

  Future<void> _searchCatalog({String? barcode}) async {
    if (!_isDraftIdentityCurrent || saving || attemptedPayload != null) return;
    final request = ++_catalogRequest;
    final originalDraft = draftId;
    final ingredientRevision = _ingredientRevision;
    final workflow = widget.workflow;
    final workflowEpoch = workflow.api.identityEpoch;
    final workflowGeneration = workflow.api.identityState?.generation;
    final route = ModalRoute.of(context);
    bool isCurrentSearch() =>
        mounted &&
        request == _catalogRequest &&
        originalDraft == draftId &&
        ingredientRevision == _ingredientRevision &&
        _isDraftIdentityCurrent &&
        identical(workflow, widget.workflow) &&
        workflowEpoch == workflow.api.identityEpoch &&
        workflowGeneration == workflow.api.identityState?.generation &&
        route?.isCurrent == true &&
        !handlingBack &&
        !saving &&
        attemptedPayload == null;
    final query = nameController.text.trim();
    if (barcode == null && query.isEmpty) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('请先识别或填写药品名称，或扫描药盒编码。')));
      return;
    }
    if (barcode != null && _isTraceabilityCode(barcode)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('已读取 20 位码，可能是药品追溯码；不能据此确认药名，可改扫商品条码或拍照识别。'),
        ),
      );
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
    if (consent != true || !mounted || !isCurrentSearch()) return;
    setState(() => searchingCatalog = true);
    try {
      final result = await workflow.searchMedicineCandidates(
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
      if (!mounted || !isCurrentSearch()) return;
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
      if (selected == null || !mounted || !isCurrentSearch()) return;
      _applyCandidate(selected);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('已补入候选资料。请核对后保存；来源状态仍为未核验。')),
      );
    } catch (error) {
      if (!mounted || !isCurrentSearch()) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('${friendlyApiError(error)} 仍可继续手动录入。')),
      );
    } finally {
      if (mounted && request == _catalogRequest) {
        setState(() => searchingCatalog = false);
      }
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
    fill(brandController, candidate['brand']);
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
    final candidatePurposeTags = candidate['purposeTags'];
    if (purposeTags.isEmpty &&
        !purposeTagsTouched &&
        candidatePurposeTags is List) {
      purposeTags.addAll(
        candidatePurposeTags
            .whereType<String>()
            .where(medicinePurposeLabels.containsKey)
            .toSet()
            .take(3),
      );
      if (purposeTags.isNotEmpty) categoryExpanded = true;
    }
    // 用户采纳待核验候选后主动展开隐藏字段，必须核对但不会自行保存。
    if (mounted) setState(() => moreExpanded = true);
    _markDirty();
  }

  Future<void> _pickOpenedDate() async {
    final initial = DateTime.tryParse(openedAt ?? '') ?? DateTime.now();
    final date = await showExpiryDateWheelPicker(context, initialDate: initial);
    if (date == null || !mounted) return;
    setState(() => openedAt = _date(date));
    _markDirty();
  }

  Future<void> _save() async {
    if (saving || handlingBack || !_isDraftIdentityCurrent) return;
    if (_isCleanupDraft) {
      _showCleanupHint();
      return;
    }
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

    final ingredients = _ingredientValues;
    final verifiedIngredients = ingredientsVerified;
    final candidatePayload = <String, Object?>{
      'idempotencyKey': 'draft-$id',
      'name': name,
      'barcodeValue': _nullableText(scannedCode ?? ''),
      'brand': _nullableText(brandController.text),
      'specification': _nullableText(specificationController.text),
      'manufacturer': _nullableText(manufacturerController.text),
      'approvalNumber': _nullableText(approvalController.text),
      'activeIngredients': ingredients,
      'purposeCategory': _nullableText(purposeController.text),
      'populationTags': populationTags.toList(),
      'purposeTags': purposeTags.toList(),
      'tagSource': 'user',
      'leaflet': {
        for (final entry in leafletControllers.entries)
          entry.key: _nullableText(entry.value.text),
        'reviewStatus':
            leafletControllers.values.any(
              (controller) => controller.text.trim().isNotEmpty,
            )
            ? 'unverified'
            : verifiedIngredients
            ? 'user_confirmed'
            : 'unverified',
      },
      'batches': [batch],
    };
    final photos = List<Map<String, dynamic>>.of(photoDrafts);
    _syncPhotoDrafts(photos);
    final setCover = usePhotoAsCover;
    inventorySaveIntent = intent;
    autoSave?.cancel();
    FocusScope.of(context).unfocus();
    setState(() => saving = true);
    try {
      bool uploadPhotos = false;
      if (photos.isNotEmpty) {
        final consent = await showDialog<bool>(
          context: context,
          builder: (dialogContext) => AlertDialog(
            title: const Text('保存药盒照片？'),
            content: Text(
              '已保留 ${photos.length} 张照片。确认后完整照片上传到此家庭的私有药品资料中；未完成照片保留在本机，可补拍。',
            ),
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
      for (final photo in photos) {
        if (!photoDrafts.any((existing) => existing['path'] == photo['path'])) {
          photoDrafts.add(photo);
        }
      }
      if (!await _saveDraft(legacy: false)) throw StateError('本机保存回执未确认，请重试。');
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
      if (!await _saveDraft(legacy: false)) throw StateError('本机保存回执未确认，请重试。');
      requireCurrentIntent();
      if (uploadPhotos) {
        for (final photo in photos) {
          if (photo['state'] != null && photo['state'] != 'ready') continue;
          if (photo['uploadedId'] != null) continue;
          final path = photo['path'] as String;
          final purpose = photo['purpose'] as String;
          final file = image?.path == path
              ? image!
              : expiryImage?.path == path
              ? expiryImage!
              : XFile(path);
          photo['uploadIntentKey'] ??=
              'photo-${DateTime.now().microsecondsSinceEpoch}-${photos.indexOf(photo)}';
          if (!await _saveDraft(legacy: false)) {
            throw StateError('本机保存回执未确认，请重试。');
          }
          requireCurrentIntent();
          final bytes = await file.readAsBytes();
          requireCurrentIntent();
          final uploaded = await workflow.uploadLeafletPhoto(
            medicine.id,
            bytes,
            mimeType: path.toLowerCase().endsWith('.png')
                ? 'image/png'
                : 'image/jpeg',
            source: 'user_capture',
            purpose: purpose,
            batchId: purpose == 'expiry' ? savedBatchId : null,
            uploadIntentKey: photo['uploadIntentKey'] as String,
            isCurrent: isCurrentIntent,
          );
          requireCurrentIntent();
          photo['uploadedId'] = uploaded.id;
          if (image?.path == path) frontPhotoId = uploaded.id;
          if (expiryImage?.path == path) expiryPhotoId = uploaded.id;
          if (!await _saveDraft(legacy: false)) {
            throw StateError('本机保存回执未确认，请重试。');
          }
          requireCurrentIntent();
        }
        final fronts = photos.where(
          (photo) =>
              photo['purpose'] == 'box_front' &&
              photo['uploadedId'] != null &&
              (photo['state'] == null || photo['state'] == 'ready'),
        );
        if (setCover && fronts.isNotEmpty) {
          await workflow.setCoverPhoto(
            medicine.id,
            fronts.last['uploadedId'] as String,
            isCurrent: isCurrentIntent,
          );
          requireCurrentIntent();
        }
      }
      final incomplete = photos.any(
        (photo) => photo['state'] != null && photo['state'] != 'ready',
      );
      if (photos.isNotEmpty && (!uploadPhotos || incomplete)) {
        if (!await _saveDraft(legacy: false)) {
          throw StateError('本机保存回执未确认，请重试。');
        }
        requireCurrentIntent();
        setState(() {
          dirty = false;
          restoredDraft = false;
        });
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(
                incomplete
                    ? '库存已保存；未完成照片未上传，已保留本机草稿，可导入后补拍。'
                    : '库存已保存；照片保留在本机，可通过导入草稿继续上传。',
              ),
            ),
          );
        }
        navigator.pop(medicine.id);
        return;
      }
      if (!await _cleanupDraftPhotos(id, _draftFields())) {
        if (mounted && isCurrentIntent()) {
          ScaffoldMessenger.of(context)
              .showSnackBar(SnackBar(content: Text(cleanupMessage)));
        }
        return;
      }
      await _persistDraft(() async {
        requireCurrentIntent();
        await _deleteOwnLegacyDraft(id);
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
        await _saveDraft(legacy: false).catchError((Object _) => false);
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
            tooltip: '导入草稿',
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
      body: Stack(
        children: [
          AbsorbPointer(
            absorbing:
                attemptedPayload != null ||
                saving ||
                recognizing ||
                _isCleanupDraft,
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
                      child: Text('已恢复这份未完成录入，核对后保存再添加下一种。'),
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
                        const Text('可选择 AI 或本机中文识别；照片发送前会询问，识别结果和用途标签须核对后保存。'),
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
                              : () =>
                                    _chooseImage(action: _ImageAction.gallery),
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
                                : () => _searchCatalog(
                                    barcode: nameController.text.trim().isEmpty
                                        ? scannedCode
                                        : null,
                                  ),
                          ),
                        ],
                        if (image != null) ...[
                          const SizedBox(height: 12),
                          const Text('识别资料仅供录入参考，请逐项人工核对后保存。'),
                          ClipRRect(
                            borderRadius: BorderRadius.circular(14),
                            child: Image.file(
                              File(image!.path),
                              height: 150,
                              width: double.infinity,
                              fit: BoxFit.cover,
                              errorBuilder: (context, error, stackTrace) =>
                                  const Text('照片预览不可用，可重新选择或拍照。'),
                            ),
                          ),
                        ],
                        if (photoDrafts.isNotEmpty) ...[
                          if (cleanupPending)
                            const Text(
                              '本机照片清理未完成；原图归属回执已保留，请从“导入草稿”的删除入口重试清理，不会再次入库或上传。',
                            ),
                          Text(
                            '已保留 ${photoDrafts.length} 张照片；补拍会追加，确认后完整照片入库。',
                          ),
                          if (photoDrafts.any(
                            (photo) => photo['state'] == 'reserved',
                          ))
                            const Text('有未完成照片未上传，原图回执已保留，可继续补拍。'),
                          SwitchListTile(
                            title: const Text('用最近上传的药盒正面作封面'),
                            subtitle: const Text('关闭不会修改现有封面。'),
                            value: usePhotoAsCover,
                            onChanged: attemptedPayload != null || saving
                                ? null
                                : (value) {
                                    setState(() => usePhotoAsCover = value);
                                    _markDirty();
                                  },
                          ),
                        ],
                        if (scannedCode != null) ...[
                          const SizedBox(height: 10),
                          SelectableText('药盒编码：$scannedCode'),
                          const Text(
                            '8–14 位商品条码用于查询候选资料；20 位码可能是药品追溯码，不能据此确认药名。资料须人工核对。',
                          ),
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
                              '识别失败，可继续手动保存：${_recognitionErrorMessage(recognitionFailure!)}',
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
                                touchedName &&
                                    nameController.text.trim().isEmpty
                                ? '请填写药品名称'
                                : null,
                          ),
                        ),
                        const SizedBox(height: 14),
                        TextField(
                          controller: brandController,
                          onChanged: (_) => _markDirty(),
                          decoration: const InputDecoration(
                            labelText: '品牌（按包装核对）',
                          ),
                        ),
                        const SizedBox(height: 12),
                        TextField(
                          controller: specificationController,
                          onChanged: (_) => _markDirty(),
                          decoration: const InputDecoration(
                            labelText: '包装规格',
                            helperText: '如每盒20粒；服药间隔不属于包装数量',
                            helperMaxLines: 3,
                          ),
                        ),
                        const SizedBox(height: 12),
                        TextField(
                          controller: manufacturerController,
                          onChanged: (_) => _markDirty(),
                          decoration: const InputDecoration(labelText: '厂家'),
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
                        MedicineDateField(
                          key: const ValueKey('api-expiry-date-field'),
                          controller: expiryController,
                          label: '包装有效期',
                          precision: expiryPrecision == 'day' ? 'day' : 'month',
                          onChanged: () {
                            setState(() {
                              touchedExpiry = true;
                              if (expiryPrecision == 'unknown') {
                                expiryPrecision = 'month';
                              }
                            });
                            _markDirty();
                          },
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
                                PopupMenuItem(
                                  value: 'day',
                                  child: Text('精确到日'),
                                ),
                                PopupMenuItem(
                                  value: 'month',
                                  child: Text('精确到月'),
                                ),
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
                              label: openedAt == null
                                  ? '选择开封日期'
                                  : '开封日期：$openedAt',
                              icon: Icons.event_outlined,
                              onPressed: _pickOpenedDate,
                            ),
                            const SizedBox(height: 10),
                            const Text('按说明书填写开封后的期限，不确定时留空。系统不会自动推定期限。'),
                            const SizedBox(height: 8),
                            _openingSegments(
                              labels: const {
                                'duration': '经过时长',
                                'date': '截止日期',
                              },
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
                              MedicineDateField(
                                controller: afterOpenDateController,
                                label: '开封后截止日期',
                                onChanged: () {
                                  setState(() {});
                                  _markDirty();
                                },
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
                          title: '用途与人群（请核对）',
                          expanded: categoryExpanded,
                          onTap: () => setState(
                            () => categoryExpanded = !categoryExpanded,
                          ),
                        ),
                        if (categoryExpanded) ...[
                          MedicineTagFields(
                            populations: populationTags,
                            purposes: purposeTags,
                            onPurposeChanged: () => purposeTagsTouched = true,
                            onChanged: () {
                              setState(() {});
                              _markDirty();
                            },
                          ),
                          TextField(
                            controller: purposeController,
                            onChanged: (_) => _markDirty(),
                            decoration: const InputDecoration(
                              labelText: '用途分类 / 标签',
                              hintText: '保留你填写的分类文案',
                            ),
                          ),
                        ],
                        const SizedBox(height: 12),
                        _optionalSection(
                          title: '存放位置（选填）',
                          expanded: locationExpanded,
                          onTap: () => setState(
                            () => locationExpanded = !locationExpanded,
                          ),
                        ),
                        if (locationExpanded) ...[
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
                            controller: approvalController,
                            onChanged: (_) => _markDirty(),
                            decoration: const InputDecoration(
                              labelText: '批准文号',
                            ),
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
                              setState(
                                () => ingredientsVerified = value == true,
                              );
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
                  AppCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '说明书（选填，识别后请核对）',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        TextButton.icon(
                          onPressed: recognizing
                              ? null
                              : () => _chooseImage(
                                  action: _ImageAction.camera,
                                  leafletPhoto: true,
                                ),
                          icon: const Icon(Icons.document_scanner_outlined),
                          label: const Text('拍说明书识别文字'),
                        ),
                        for (final entry in leafletControllers.entries)
                          TextField(
                            controller: entry.value,
                            maxLines: null,
                            onChanged: (_) => _markDirty(),
                            decoration: InputDecoration(
                              labelText: const {
                                'purposeSummary': '功能与用途',
                                'packageUsageSummary': '用法用量',
                                'precautionsSummary': '注意事项',
                                'contraindicationsSummary': '禁忌',
                              }[entry.key],
                            ),
                          ),
                        const Text('识别内容仅作草稿，保存后仍标记未核对。'),
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
          if (recognizing)
            Positioned.fill(
              child: ColoredBox(
                color: Colors.black38,
                child: Center(
                  child: Card(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const CircularProgressIndicator(),
                          const SizedBox(height: 16),
                          Text(
                            '正在识别药品… 已等待 $recognitionSeconds 秒',
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          const Text('完成后请核对包装信息'),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
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
  String? scanHint;

  void _onDetect(BarcodeCapture capture) {
    if (!mounted || handled || capture.barcodes.isEmpty) return;
    for (final barcode in capture.barcodes) {
      final code = barcode.rawValue?.trim() ?? '';
      if (!_isProductBarcode(code) && !_isTraceabilityCode(code)) continue;
      handled = true;
      Navigator.of(context).pop(code);
      return;
    }
    setState(() => scanHint = '请扫描 8–14 位商品条码或 20 位码（可能是药品追溯码）；未保存其他内容。');
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
        Align(
          alignment: Alignment.bottomCenter,
          child: Padding(
            padding: EdgeInsets.all(24),
            child: Card(
              child: Padding(
                padding: EdgeInsets.all(14),
                child: Text(
                  scanHint ??
                      '对准 8–14 位商品条码或 20 位码（可能是药品追溯码）。读取编码不代表药品资料已核实，请人工确认。',
                ),
              ),
            ),
          ),
        ),
      ],
    ),
  );
}
