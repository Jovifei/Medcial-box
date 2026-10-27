import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

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
import '../../domain/recognition_review.dart';
import '../../models/medicine_models.dart';

enum _ImageAction { camera, gallery }

bool _isProductBarcode(String code) => RegExp(r'^\d{8,14}$').hasMatch(code);
bool _isTraceabilityCode(String code) => RegExp(r'^\d{20}$').hasMatch(code);

const _fieldLabels = <String, String>{
  'name': '药名',
  'brand': '品牌',
  'specification': '规格',
  'manufacturer': '厂家',
  'approvalNumber': '批准文号',
  'barcodeValue': '条码',
  'activeIngredients': '成分',
  'purposeCategory': '用途分类',
  'lotNumber': '批号',
  'expiryValue': '有效期',
  'expiryPrecision': '有效期精度',
  'populationTags': '人群',
  'purposeTags': '用途',
  'leafletText': '说明书原文',
  'rawOcrText': '本机识别原文',
  'purposeSummary': '功能与用途',
  'packageUsageSummary': '用法用量原文',
  'contraindicationsSummary': '禁忌',
  'precautionsSummary': '注意事项',
};

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

class _BatchIdentityUnconfirmed implements Exception {
  const _BatchIdentityUnconfirmed();
}

Object? _recoveryComparable(Object? value, String field) {
  if (value == null) return null;
  if (value is String) {
    final trimmed = value.trim();
    return trimmed.isEmpty ? null : trimmed;
  }
  if (value is List && value.every((item) => item is String)) {
    final strings = value.cast<String>().map((item) => item.trim()).toList();
    if (field == 'populationTags' || field == 'purposeTags') {
      return strings.toSet().toList()..sort();
    }
    return strings;
  }
  throw const FormatException('资料格式无法核对。');
}

Object? _canonicalRecoverySnapshot(Object? value) {
  if (value is List) return value.map(_canonicalRecoverySnapshot).toList();
  if (value is Map) {
    final keys = value.keys.cast<String>().toList()..sort();
    return {
      for (final key in keys) key: _canonicalRecoverySnapshot(value[key]),
    };
  }
  return value;
}

Map<String, dynamic> _recoverySourceSnapshot(RecognitionEvidenceState state) {
  final evidence = state.evidence;
  return {
    'coverPhotoVersionGuard': state.coverPhotoVersionGuard,
    'evidence': evidence == null
        ? null
        : {
            'revision': evidence.revision,
            'medicineVersion': evidence.medicineVersion,
            'currentMedicineVersion': evidence.currentMedicineVersion,
            'stale': evidence.stale,
            'photos': [
              for (final photo in evidence.photos)
                {...photo.toRequestJson(), 'available': photo.available},
            ],
            'fieldSources': {
              for (final entry in evidence.fieldSources.entries)
                entry.key: entry.value.toRequestJson(),
            },
            'batchSources': [
              for (final source in evidence.batchSources)
                {
                  ...source.toRequestJson(),
                  'batchAvailable': source.batchAvailable,
                },
            ],
          },
  };
}

class MedicineEntryApiPage extends StatefulWidget {
  const MedicineEntryApiPage({
    super.key,
    required this.repository,
    required this.workflow,
    required this.localStore,
    this.localRecognition,
  });
  final ApiMedicineRepository repository;
  final ApiWorkflowRepository workflow;
  final LocalAppStore localStore;
  final MedicineRecognitionRepository? localRecognition;

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
  final lotController = TextEditingController();
  final locationController = TextEditingController();
  final manufacturerController = TextEditingController();
  final approvalController = TextEditingController();
  final ingredientController = TextEditingController();
  final purposeController = TextEditingController();
  final afterOpenValueController = TextEditingController();
  final afterOpenDateController = TextEditingController();
  final imagePicker = ImagePicker();
  late final MedicineRecognitionRepository recognition =
      widget.localRecognition ?? MlKitMedicineRecognitionRepository();

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
  bool identityExpanded = false;
  bool leafletExpanded = false;
  bool categoryExpanded = false;
  bool locationExpanded = false;
  Timer? recognitionTimer;
  int recognitionSeconds = 0;
  final populationTags = <String>{};
  final purposeTags = <String>{};
  String _populationSnapshot = '[]';
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
  late final Listenable _identitySignals = Listenable.merge([
    widget.repository.api.identityEpochSignal,
    if (widget.repository.api.identityState != null)
      widget.repository.api.identityState!.scopeSignal,
  ]);
  Future<void> draftPersistence = Future.value();
  String draftId = DateTime.now().microsecondsSinceEpoch.toString();
  String? savedMedicineId;
  int? savedMedicineVersion;
  Map<String, dynamic>? coverIntent;
  bool coverApplied = false;
  Map<String, dynamic>? evidenceRequest;
  bool evidenceSynced = false;
  Map<String, dynamic>? evidenceAcknowledged;
  final evidenceHistory = <Map<String, dynamic>>[];
  RecognitionReview review = RecognitionReview();
  int nextPhotoSequence = 1;
  String? savedBatchId;
  bool savedBatchIdConfirmed = false;
  int? savedBatchVersion;
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

  String _newLocalId() => base64Url
      .encode(List<int>.generate(18, (_) => Random.secure().nextInt(256)))
      .replaceAll('=', '');

  void _ensurePhotoIdentities(List<Map<String, dynamic>> photos) {
    for (final photo in photos) {
      photo['clientPhotoId'] ??= _newLocalId();
      final sequence = photo['sequence'];
      if (sequence is int && sequence >= nextPhotoSequence) {
        nextPhotoSequence = sequence + 1;
      }
    }
    for (final photo in photos) {
      photo['sequence'] ??= nextPhotoSequence++;
    }
  }

  Map<String, TextEditingController> get _reviewControllers => {
    'name': nameController,
    'brand': brandController,
    'specification': specificationController,
    'manufacturer': manufacturerController,
    'approvalNumber': approvalController,
    'expiryValue': expiryController,
    'lotNumber': lotController,
    'purposeCategory': purposeController,
    ...leafletControllers,
  };

  void _manualField(String field) {
    review.markManual(field);
    _markDirty();
  }

  Map<String, dynamic> _recognitionFields(MedicineRecognitionDraft result) => {
    if (result.name.trim().isNotEmpty) 'name': result.name.trim(),
    if (result.brand?.trim().isNotEmpty == true) 'brand': result.brand!.trim(),
    if (result.specification.trim().isNotEmpty)
      'specification': result.specification.trim(),
    if (result.manufacturer?.trim().isNotEmpty == true)
      'manufacturer': result.manufacturer!.trim(),
    if (result.approvalNumber?.trim().isNotEmpty == true)
      'approvalNumber': result.approvalNumber!.trim(),
    if (result.lotNumber?.trim().isNotEmpty == true)
      'lotNumber': result.lotNumber!.trim(),
    if (result.expiry != '待补充' && result.expiry.trim().isNotEmpty)
      'expiryValue': result.expiry.trim(),
    if (result.expiry != '待补充' && result.expiry.trim().isNotEmpty)
      'expiryPrecision':
          result.expiryPrecision ??
          (result.expiry.trim().length == 7 ? 'month' : 'day'),
    if (result.purposeCategory?.trim().isNotEmpty == true)
      'purposeCategory': result.purposeCategory!.trim(),
    if (result.populationTags.isNotEmpty)
      'populationTags': result.populationTags,
    if (result.purposeTags.isNotEmpty) 'purposeTags': result.purposeTags,
    if (result.leaflet['text']?.trim().isNotEmpty == true)
      'leafletText': result.leaflet['text']!.trim(),
    if (result.rawText.isNotEmpty) 'rawOcrText': result.rawText,
    for (final entry in result.leaflet.entries)
      if (leafletControllers.containsKey(entry.key) &&
          entry.value.trim().isNotEmpty)
        entry.key: entry.value.trim(),
  };

  void _setReviewValue(String field, Object value) {
    final controller = _reviewControllers[field];
    if (controller != null && value is String) {
      controller.text = value;
      if (field == 'expiryValue') {
        expiryPrecision = value.length == 7 ? 'month' : 'day';
      }
    } else if (field == 'populationTags' && value is List) {
      populationTags
        ..clear()
        ..addAll(
          value.whereType<String>().where(medicinePopulationLabels.containsKey),
        );
    } else if (field == 'purposeTags' && value is List) {
      purposeTags
        ..clear()
        ..addAll(
          value.whereType<String>().where(medicinePurposeLabels.containsKey),
        );
    }
  }

  void _refreshRecognizedSuggestions() {
    for (final field in [
      ..._reviewControllers.keys,
      'populationTags',
      'purposeTags',
    ]) {
      final options = review.candidates(field, photoDrafts);
      if (!review.canAutoApply(field) || options.length != 1) continue;
      _setReviewValue(field, options.single.value);
      review.accept(field, options.single, photoDrafts, reviewed: false);
    }
    if ([
      'brand',
      'specification',
      'manufacturer',
      'lotNumber',
    ].any((field) => review.requiresChoice(field, photoDrafts))) {
      identityExpanded = true;
    }
    if (_hasMoreReviewConflicts) {
      moreExpanded = true;
    }
    if (leafletControllers.keys.any(
      (field) => review.requiresChoice(field, photoDrafts),
    )) {
      leafletExpanded = true;
    }
    if ([
      'purposeCategory',
      'populationTags',
      'purposeTags',
    ].any((field) => review.requiresChoice(field, photoDrafts))) {
      categoryExpanded = true;
    }
    _populationSnapshot = jsonEncode(populationTags.toList()..sort());
  }

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

  bool get _isDraftIdentityCurrent =>
      mounted && entryIdentity == _identitySnapshot();

  Widget _protectPrivateSheet(Widget child) => AnimatedBuilder(
    animation: _identitySignals,
    builder: (_, _) =>
        _isDraftIdentityCurrent ? child : const Text('家庭身份已变化，原资料已隐藏。'),
  );

  Widget _protectPrivateDialog(BuildContext dialogContext, Widget child) =>
      AnimatedBuilder(
        animation: _identitySignals,
        builder: (_, _) => _isDraftIdentityCurrent
            ? child
            : AlertDialog(
                title: const Text('家庭身份已变化'),
                content: const Text('原资料已隐藏，请重新打开药品录入。'),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.pop(dialogContext),
                    child: const Text('关闭'),
                  ),
                ],
              ),
      );

  bool get _hasBlockingConflicts => [
    ..._reviewControllers.keys,
    'populationTags',
    'purposeTags',
  ].any((field) => review.requiresChoice(field, photoDrafts));

  bool get _hasMoreReviewConflicts =>
      review.requiresChoice('approvalNumber', photoDrafts) ||
      review.requiresChoice('activeIngredients', photoDrafts);

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
    lotController.text = json['lotNumber'] as String? ?? '';
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
    identityExpanded = json['identityExpanded'] == true;
    leafletExpanded = json['leafletExpanded'] == true;
    moreExpanded = json['moreExpanded'] == true;
    draftId = json['id'] as String? ?? draftId;
    savedMedicineId = json['savedMedicineId'] as String?;
    savedMedicineVersion = json['savedMedicineVersion'] as int?;
    coverIntent = json['coverIntent'] is Map
        ? Map<String, dynamic>.from(json['coverIntent'] as Map)
        : null;
    coverApplied = json['coverApplied'] == true;
    evidenceRequest = json['evidenceRequest'] is Map
        ? Map<String, dynamic>.from(json['evidenceRequest'] as Map)
        : null;
    evidenceSynced = json['evidenceSynced'] == true;
    evidenceAcknowledged = json['evidenceAcknowledged'] is Map
        ? Map<String, dynamic>.from(json['evidenceAcknowledged'] as Map)
        : null;
    evidenceHistory
      ..clear()
      ..addAll(
        (json['evidenceHistory'] as List? ?? []).whereType<Map>().map(
          (item) => Map<String, dynamic>.from(item),
        ),
      );
    review = RecognitionReview.fromJson(json['recognitionSources']);
    nextPhotoSequence = json['nextPhotoSequence'] as int? ?? 1;
    attemptedPayload = json['attemptedPayload'] as Map<String, dynamic>?;
    touchedExpiry = json['touchedExpiry'] == true;
    savedBatchId = json['savedBatchId'] as String?;
    savedBatchIdConfirmed =
        json['savedBatchIdConfirmed'] == true && savedBatchId != null;
    savedBatchVersion = json['savedBatchVersion'] as int?;
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
    _ensurePhotoIdentities(photoDrafts);
    if (json['recognitionSources'] == null) {
      // Old drafts have no provenance; keep existing values instead of letting
      // a later photo replace them. Do not invent recognized sources.
      for (final entry in _reviewControllers.entries) {
        if (entry.value.text.trim().isNotEmpty) review.markManual(entry.key);
      }
      if (populationTags.isNotEmpty) review.markManual('populationTags');
      if (purposeTags.isNotEmpty || purposeTagsTouched) {
        review.markManual('purposeTags');
      }
      if (json['touchedExpiry'] == true) review.markManual('expiryValue');
    }
    _populationSnapshot = jsonEncode(populationTags.toList()..sort());
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
    _syncPhotoDrafts();
    _ensurePhotoIdentities(photoDrafts);
    final photos = List<Map<String, dynamic>>.of(photoDrafts);
    return {
      'recognitionSchemaVersion': 1,
      'recognitionSources': review.toJson(),
      'nextPhotoSequence': nextPhotoSequence,
      'name': nameController.text,
      'brand': brandController.text,
      'leaflet': {
        for (final entry in leafletControllers.entries)
          entry.key: entry.value.text,
      },
      'specification': specificationController.text,
      'quantity': quantityController.text,
      'expiry': expiryController.text,
      'lotNumber': lotController.text,
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
      'identityExpanded': identityExpanded,
      'leafletExpanded': leafletExpanded,
      'moreExpanded': moreExpanded,
      'savedMedicineId': savedMedicineId,
      'savedMedicineVersion': savedMedicineVersion,
      'coverIntent': coverIntent,
      'coverApplied': coverApplied,
      'evidenceRequest': evidenceRequest,
      'evidenceSynced': evidenceSynced,
      'evidenceAcknowledged': evidenceAcknowledged,
      'evidenceHistory': evidenceHistory,
      'attemptedPayload': attemptedPayload,
      'touchedExpiry': touchedExpiry,
      'savedBatchId': savedBatchId,
      'savedBatchIdConfirmed': savedBatchIdConfirmed,
      'savedBatchVersion': savedBatchVersion,
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
      builder: (context) => _protectPrivateSheet(
        Material(
          type: MaterialType.transparency,
          child: ListView(
            shrinkWrap: true,
            children: [
              ...drafts.map(
                (draft) => ListTile(
                  title: Text(draft['name'] as String? ?? '未命名药品'),
                  subtitle: Text(
                    draft['savedMedicineId'] != null
                        ? '药已保存 · 照片或来源待同步'
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
                          ScaffoldMessenger.of(this.context).showSnackBar(
                            SnackBar(content: Text(cleanupMessage)),
                          );
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
    lotController.dispose();
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
    if (photoDrafts.length >= 100) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('每种药最多保留 100 张照片。')));
      return;
    }
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
        'clientPhotoId': _newLocalId(),
        'sequence': nextPhotoSequence++,
        'recognitionStatus': 'pending',
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
        pendingPhoto['recognitionStatus'] = 'recognized';
        pendingPhoto['recognitionFields'] = _recognitionFields(draft);
        pendingPhoto['recognitionWarnings'] = draft.warnings;
        if (draft.rawText.isNotEmpty) pendingPhoto['rawText'] = draft.rawText;
        _refreshRecognizedSuggestions();
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
          pendingPhoto['recognitionStatus'] = 'failed';
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
    setState(() {
      scannedCode = code;
      review.markManual('barcodeValue');
    });
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
        builder: (sheetContext) => _protectPrivateSheet(
          ListView(
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
    void fill(String field, TextEditingController controller, Object? value) {
      if (review.canAutoApply(field) &&
          controller.text.trim().isEmpty &&
          value is String &&
          value.trim().isNotEmpty) {
        controller.text = value.trim();
        review.markCatalog(field);
      }
    }

    fill('name', nameController, candidate['name']);
    fill('brand', brandController, candidate['brand']);
    fill('specification', specificationController, candidate['specification']);
    fill('manufacturer', manufacturerController, candidate['manufacturer']);
    fill('approvalNumber', approvalController, candidate['approvalNumber']);
    final ingredients = candidate['activeIngredients'];
    if (review.canAutoApply('activeIngredients') &&
        ingredientController.text.trim().isEmpty &&
        ingredients is List) {
      ingredientController.text = ingredients.whereType<String>().join('，');
      if (ingredientController.text.isNotEmpty) {
        review.markCatalog('activeIngredients');
      }
    }
    final leaflet = candidate['leaflet'];
    if (leaflet is Map<String, dynamic>) {
      fill('purposeCategory', purposeController, leaflet['purposeSummary']);
    }
    final candidatePurposeTags = candidate['purposeTags'];
    if (review.canAutoApply('purposeTags') &&
        purposeTags.isEmpty &&
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
      if (purposeTags.isNotEmpty) review.markCatalog('purposeTags');
    }
    _markDirty();
  }

  Future<void> _pickOpenedDate() async {
    final initial = DateTime.tryParse(openedAt ?? '') ?? DateTime.now();
    final date = await showExpiryDateWheelPicker(
      context,
      initialDate: initial,
      privacySignal: _identitySignals,
      isCurrent: () => _isDraftIdentityCurrent,
    );
    if (date == null || !mounted || !_isDraftIdentityCurrent) return;
    setState(() => openedAt = _date(date));
    _markDirty();
  }

  Future<void> _captureOptions({bool scanAndAlbumOnly = false}) async {
    if (_isCleanupDraft || !_isDraftIdentityCurrent) return;
    final choice = await showAppSheet<String>(
      context,
      title: scanAndAlbumOnly ? '扫码或相册' : '继续补拍',
      builder: (sheetContext) => Column(
        children: [
          if (!scanAndAlbumOnly)
            choiceTile(
              sheetContext,
              icon: Icons.camera_alt_outlined,
              title: '拍药盒',
              subtitle: '继续添加包装照片',
              onTap: () => Navigator.pop(sheetContext, 'box'),
            ),
          if (!scanAndAlbumOnly)
            choiceTile(
              sheetContext,
              icon: Icons.document_scanner_outlined,
              title: '拍说明书',
              subtitle: '添加说明书照片',
              onTap: () => Navigator.pop(sheetContext, 'leaflet'),
            ),
          if (!scanAndAlbumOnly)
            choiceTile(
              sheetContext,
              icon: Icons.event_outlined,
              title: '拍有效期',
              subtitle: '添加有效期照片',
              onTap: () => Navigator.pop(sheetContext, 'expiry'),
            ),
          choiceTile(
            sheetContext,
            icon: Icons.qr_code_scanner,
            title: '扫码',
            subtitle: '读取药盒编码',
            onTap: () => Navigator.pop(sheetContext, 'scan'),
          ),
          choiceTile(
            sheetContext,
            icon: Icons.photo_library_outlined,
            title: '从相册选择',
            subtitle: '添加已有照片',
            onTap: () => Navigator.pop(sheetContext, 'gallery'),
          ),
        ],
      ),
    );
    if (!mounted || choice == null) return;
    switch (choice) {
      case 'box':
        await _chooseImage(action: _ImageAction.camera);
      case 'leaflet':
        await _chooseImage(action: _ImageAction.camera, leafletPhoto: true);
      case 'expiry':
        await _chooseImage(action: _ImageAction.camera, expiryPhoto: true);
      case 'scan':
        await _scanCode();
      case 'gallery':
        await _chooseImage(action: _ImageAction.gallery);
    }
  }

  Future<void> _removeDraftPhoto(Map<String, dynamic> photo) async {
    if (recognizing ||
        saving ||
        photo['uploadedId'] != null ||
        !_isDraftIdentityCurrent) {
      return;
    }
    if (photo['ownedLocal'] == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('旧照片的本机归属未确认，已保留原图，请勿直接删除。')),
      );
      return;
    }
    final originalDraft = draftId;
    bool current() =>
        mounted &&
        _isDraftIdentityCurrent &&
        draftId == originalDraft &&
        photoDrafts.contains(photo);
    try {
      photo['removePending'] = true;
      await _requireDraftSave(legacy: false);
      final support = await getApplicationSupportDirectory();
      if (!current() ||
          !await cleanupMedicinePhoto(
            supportPath: support.path,
            draftId: originalDraft,
            photo: photo,
            isCurrent: current,
          )) {
        throw StateError('照片清理未完成');
      }
      if (!current()) return;
      review.removePhoto(photo['clientPhotoId'] as String);
      if (image?.path == photo['path']) {
        image = null;
        frontPhotoId = null;
      }
      if (expiryImage?.path == photo['path']) {
        expiryImage = null;
        expiryPhotoId = null;
      }
      photoDrafts.remove(photo);
      _refreshRecognizedSuggestions();
      await _requireDraftSave(legacy: false);
      if (mounted) setState(() {});
      _markDirty();
    } catch (_) {
      if (mounted && _isDraftIdentityCurrent) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('照片删除或草稿保存未完成；已保留清理记录，请重试。')),
        );
      }
    }
  }

  Future<void> _retryPhotoRecognition(Map<String, dynamic> photo) async {
    if (recognizing ||
        saving ||
        !_isDraftIdentityCurrent ||
        photo['state'] != 'ready') {
      return;
    }
    final entryDraftId = draftId;
    final request = ++recognitionRequest;
    bool current() =>
        mounted &&
        _isDraftIdentityCurrent &&
        draftId == entryDraftId &&
        request == recognitionRequest &&
        photoDrafts.contains(photo) &&
        !_isCleanupDraft;
    final useServer = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('重新识别这张照片？'),
        content: const Text('AI 识别会将这张照片发送到当前家庭药箱服务。识别建议需要核对。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('AI 识别'),
          ),
        ],
      ),
    );
    if (useServer != true || !current()) return;
    final oldStatus = photo['recognitionStatus'];
    final oldFields = photo['recognitionFields'] is Map
        ? Map<String, dynamic>.from(photo['recognitionFields'] as Map)
        : null;
    setState(() {
      recognizing = true;
      recognitionFailure = null;
      if (oldStatus != 'recognized') photo['recognitionStatus'] = 'pending';
      photo['retryStatus'] = 'pending';
    });
    try {
      await _requireDraftSave(legacy: false);
      final result = await ApiMedicineRecognitionRepository(
        widget.repository.api,
        purpose: photo['purpose'] == 'leaflet' ? 'leaflet' : 'box_front',
        isCurrent: current,
      ).recognize(XFile(photo['path'] as String));
      if (!current()) return;
      final newFields = _recognitionFields(result);
      final id = photo['clientPhotoId'] as String;
      final changesChosenResult =
          oldFields != null &&
          review.toJson().entries.any((entry) {
            final source = entry.value as Map;
            return source['source'] == 'recognized' &&
                (source['photoIds'] as List).contains(id) &&
                jsonEncode(oldFields[entry.key]) !=
                    jsonEncode(newFields[entry.key]);
          });
      photo['recognitionStatus'] = 'recognized';
      if (changesChosenResult) {
        photo['retryFields'] = newFields;
        photo['retryWarnings'] = result.warnings;
        photo['retryStatus'] = 'review';
      } else {
        photo['recognitionFields'] = newFields;
        photo['recognitionWarnings'] = result.warnings;
        if (result.rawText.isNotEmpty) photo['rawText'] = result.rawText;
        photo.remove('retryFields');
        photo.remove('retryStatus');
        _refreshRecognizedSuggestions();
      }
      await _requireDraftSave(legacy: false);
    } catch (error) {
      if (!current()) return;
      photo['recognitionStatus'] = oldStatus == 'recognized'
          ? oldStatus
          : 'failed';
      photo['retryStatus'] = 'failed';
      recognitionFailure = error;
      try {
        await _requireDraftSave(legacy: false);
      } catch (_) {
        _showDraftSaveFailure();
      }
    } finally {
      if (current()) setState(() => recognizing = false);
    }
  }

  String _photoNumbers(Iterable<String> ids) => ids
      .map((id) {
        final matches = photoDrafts.where(
          (photo) => photo['clientPhotoId'] == id,
        );
        return matches.isEmpty ? '原图已移除' : '图${matches.first['sequence']}';
      })
      .join('、');

  Widget _photoReview() => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      for (final photo in photoDrafts)
        Card(
          child: ExpansionTile(
            title: Text(
              '图${photo['sequence']} · ${photo['purpose'] == 'leaflet'
                  ? '说明书'
                  : photo['purpose'] == 'expiry'
                  ? '有效期'
                  : '药盒'}',
            ),
            subtitle: Text(
              photo['removePending'] == true
                  ? '删除待完成'
                  : photo['recognitionStatus'] == 'recognized'
                  ? '待核对'
                  : photo['recognitionStatus'] == 'failed'
                  ? '识别失败，可重试'
                  : '待读取',
            ),
            children: [
              ListTile(
                title: const Text('查看原图'),
                leading: const Icon(Icons.image_outlined),
                onTap: () {
                  showDialog<void>(
                    context: context,
                    builder: (dialogContext) => AnimatedBuilder(
                      animation: _identitySignals,
                      builder: (_, _) => AlertDialog(
                        title: Text(
                          _isDraftIdentityCurrent
                              ? '图${photo['sequence']} 原图'
                              : '家庭身份已变化',
                        ),
                        content: _isDraftIdentityCurrent
                            ? Image.file(
                                File(photo['path'] as String),
                                errorBuilder: (_, _, _) =>
                                    const Text('原图不可查看。'),
                              )
                            : const Text('原图已隐藏，请重新打开照片资料。'),
                        actions: [
                          TextButton(
                            onPressed: () => Navigator.pop(dialogContext),
                            child: const Text('关闭'),
                          ),
                        ],
                      ),
                    ),
                  );
                },
              ),
              if (photo['recognitionFields'] is Map)
                for (final entry in (photo['recognitionFields'] as Map).entries)
                  ListTile(
                    dense: true,
                    title: Text(
                      '${_fieldLabels[entry.key] ?? entry.key}：${entry.value is List ? (entry.value as List).join('、') : entry.value}',
                    ),
                  ),
              if (photo['recognitionWarnings'] is List)
                for (final warning
                    in (photo['recognitionWarnings'] as List)
                        .whereType<String>())
                  ListTile(dense: true, title: Text(warning)),
              if (photo['rawText'] is String &&
                  (photo['rawText'] as String).isNotEmpty &&
                  (photo['recognitionFields'] is! Map ||
                      !(photo['recognitionFields'] as Map).containsKey(
                        'rawOcrText',
                      )))
                ListTile(
                  dense: true,
                  title: Text('原始识别文字：${photo['rawText']}'),
                ),
              if (photo['retryFields'] is Map) ...[
                const Text('重新识别得到不同结果：请选择要使用的字段，再完成核对。原结果和已填写值会保留。'),
                if (photo['retryWarnings'] is List)
                  for (final warning
                      in (photo['retryWarnings'] as List).whereType<String>())
                    Text('本次识别提醒：$warning'),
                for (final entry in (photo['retryFields'] as Map).entries)
                  TextButton(
                    onPressed: () {
                      setState(() {
                        final fields = Map<String, dynamic>.from(
                          photo['recognitionFields'] as Map? ?? {},
                        );
                        fields[entry.key as String] = entry.value;
                        photo['retryAccepted'] = true;
                        photo['recognitionFields'] = fields;
                        if (entry.key == 'expiryValue' &&
                            (photo['retryFields'] as Map)['expiryPrecision'] !=
                                null) {
                          fields['expiryPrecision'] =
                              (photo['retryFields'] as Map)['expiryPrecision'];
                        }
                        final candidates = review.candidates(
                          entry.key as String,
                          photoDrafts,
                        );
                        final matched = candidates.where(
                          (candidate) => candidate.photoIds.contains(
                            photo['clientPhotoId'],
                          ),
                        );
                        if (matched.isNotEmpty &&
                            (_reviewControllers.containsKey(entry.key) ||
                                entry.key == 'populationTags' ||
                                entry.key == 'purposeTags')) {
                          _setReviewValue(
                            entry.key as String,
                            matched.first.value,
                          );
                          review.accept(
                            entry.key as String,
                            matched.first,
                            photoDrafts,
                            reviewed: true,
                          );
                          _populationSnapshot = jsonEncode(
                            populationTags.toList()..sort(),
                          );
                        }
                      });
                      _markDirty();
                    },
                    child: Text(
                      '使用本次${_fieldLabels[entry.key] ?? entry.key}：${entry.value is List ? (entry.value as List).join('、') : entry.value}',
                    ),
                  ),
                TextButton(
                  onPressed: () {
                    setState(() {
                      if (photo['retryAccepted'] == true &&
                          photo['retryWarnings'] is List) {
                        final warnings = List<dynamic>.of(
                          photo['recognitionWarnings'] as List? ?? [],
                        );
                        for (final warning in photo['retryWarnings'] as List) {
                          if (!warnings.contains(warning)) {
                            warnings.add(warning);
                          }
                        }
                        photo['recognitionWarnings'] = warnings;
                      }
                      photo.remove('retryFields');
                      photo.remove('retryWarnings');
                      photo.remove('retryStatus');
                      photo.remove('retryAccepted');
                    });
                    _markDirty();
                  },
                  child: const Text('完成重识别核对'),
                ),
              ],
              Wrap(
                children: [
                  TextButton(
                    onPressed: recognizing
                        ? null
                        : () => _retryPhotoRecognition(photo),
                    child: const Text('重试此图'),
                  ),
                  TextButton(
                    onPressed: recognizing || photo['uploadedId'] != null
                        ? null
                        : () => _removeDraftPhoto(photo),
                    child: const Text('移除此图'),
                  ),
                ],
              ),
            ],
          ),
        ),
      for (final field in [
        ..._reviewControllers.keys,
        'populationTags',
        'purposeTags',
      ])
        if (review.candidates(field, photoDrafts).isNotEmpty) ...[
          Text(
            '${_fieldLabels[field] ?? field}${review.requiresChoice(field, photoDrafts) ? ' · 存在冲突，请选择' : ''}',
          ),
          for (final candidate in review.candidates(field, photoDrafts))
            TextButton(
              onPressed: () {
                setState(() {
                  _setReviewValue(field, candidate.value);
                  review.accept(field, candidate, photoDrafts, reviewed: true);
                  _populationSnapshot = jsonEncode(
                    populationTags.toList()..sort(),
                  );
                });
                _markDirty();
              },
              child: Text(
                '${candidate.value is List ? (candidate.value as List).join('、') : candidate.value} · ${_photoNumbers(candidate.photoIds)} · 使用此建议',
              ),
            ),
        ],
      for (final entry in review.toJson().entries)
        if ((entry.value as Map)['source'] != 'recognized')
          Text(
            '${_fieldLabels[entry.key] ?? entry.key}：${(entry.value as Map)['source'] == 'manual'
                ? '人工填写或清空'
                : (entry.value as Map)['source'] == 'catalog'
                ? '目录候选，待核对'
                : '原图已移除'}',
          ),
    ],
  );

  Map<String, dynamic> _buildEvidenceRequest(
    List<Map<String, dynamic>> photos,
    int medicineVersion,
    int revision,
  ) {
    final uploaded = photos
        .where((photo) => photo['uploadedId'] is String)
        .toList();
    final byClientId = {
      for (final photo in uploaded) photo['clientPhotoId'] as String: photo,
    };
    final fieldSources = <String, dynamic>{};
    for (final entry in review.toJson().entries) {
      if (!_fieldLabels.containsKey(entry.key) ||
          const {
            'lotNumber',
            'expiryValue',
            'expiryPrecision',
            'leafletText',
            'rawOcrText',
          }.contains(entry.key)) {
        continue;
      }
      final source = entry.value as Map;
      var kind = source['source'] as String;
      final ids = (source['photoIds'] as List)
          .whereType<String>()
          .map((id) => byClientId[id])
          .whereType<Map<String, dynamic>>()
          .where(
            (photo) =>
                photo['recognitionStatus'] == 'recognized' &&
                photo['recognitionFields'] is Map &&
                (photo['recognitionFields'] as Map)[entry.key] != null,
          )
          .map((photo) => photo['uploadedId'] as String)
          .toList();
      if (kind == 'recognized' &&
          ids.length != (source['photoIds'] as List).length) {
        throw StateError('已选来源与照片识别结果不一致');
      }
      fieldSources[entry.key] = {
        'source': kind,
        'photoIds': kind == 'recognized' ? ids : <String>[],
        'reviewed':
            source['reviewed'] == true &&
            (kind != 'recognized' || !review.requiresChoice(entry.key, photos)),
      };
    }
    final batchSources = <Map<String, dynamic>>[];
    for (final batchField in [
      ('expiryValue', 'expiry'),
      ('lotNumber', 'lotNumber'),
    ]) {
      final field = batchField.$1;
      final selected = review.source(field);
      if (selected == null) continue;
      if (savedBatchId == null || !savedBatchIdConfirmed) {
        throw const _BatchIdentityUnconfirmed();
      }
      final source = selected.source;
      final ids = selected.photoIds
          .map((id) => byClientId[id])
          .whereType<Map<String, dynamic>>()
          .where(
            (photo) =>
                photo['recognitionStatus'] == 'recognized' &&
                photo['recognitionFields'] is Map &&
                (photo['recognitionFields'] as Map)[field] != null &&
                (field != 'expiryValue' ||
                    (photo['recognitionFields'] as Map)['expiryPrecision'] !=
                        null),
          )
          .map((photo) => photo['uploadedId'] as String)
          .toList();
      if (source == 'recognized' && ids.length != selected.photoIds.length) {
        throw StateError('批次来源与照片识别结果不一致');
      }
      batchSources.add({
        'batchId': savedBatchId,
        'field': batchField.$2,
        'source': source,
        'photoIds': source == 'recognized' ? ids : <String>[],
        'reviewed':
            selected.reviewed &&
            (source != 'recognized' || !review.requiresChoice(field, photos)),
      });
    }
    return {
      'schemaVersion': 1,
      'revision': revision,
      'medicineVersion': medicineVersion,
      'idempotencyKey': 'evidence_${_newLocalId()}',
      'photos': [
        for (final photo in uploaded)
          {
            'photoId': photo['uploadedId'],
            'sequence': photo['sequence'],
            'status':
                const {
                  'recognized',
                  'failed',
                }.contains(photo['recognitionStatus'])
                ? photo['recognitionStatus']
                : 'pending',
            'fields': {
              if (photo['recognitionFields'] is Map)
                ...Map<String, dynamic>.from(photo['recognitionFields'] as Map),
              if (photo['rawText'] is String &&
                  (photo['rawText'] as String).isNotEmpty &&
                  (photo['recognitionFields'] is! Map ||
                      !(photo['recognitionFields'] as Map).containsKey(
                        'rawOcrText',
                      )))
                'rawOcrText': photo['rawText'],
            },
            if (photo['recognitionWarnings'] is List)
              'warnings': photo['recognitionWarnings'],
          },
      ],
      'fieldSources': fieldSources,
      if (batchSources.isNotEmpty) 'batchSources': batchSources,
    };
  }

  ({bool matches, List<String> rows}) _compareRecoveryMedicine(
    Map<String, dynamic> latest,
  ) {
    final original = attemptedPayload;
    final rows = <String>[];
    var matches =
        original != null &&
        latest['id'] == savedMedicineId &&
        latest['version'] is int;
    if (original == null) return (matches: false, rows: ['原始提交不可用，无法安全核对。']);
    final fields = <String>{
      'name',
      'brand',
      'specification',
      'manufacturer',
      'approvalNumber',
      ...review.toJson().keys,
    };
    const simple = {
      'name',
      'brand',
      'specification',
      'manufacturer',
      'approvalNumber',
      'barcodeValue',
      'activeIngredients',
      'purposeCategory',
      'populationTags',
      'purposeTags',
    };
    String display(Object? value) =>
        value is List ? value.join('、') : value?.toString() ?? '未填写';
    void compare(String field, Map previous, Map current) {
      if (!previous.containsKey(field) || !current.containsKey(field)) {
        matches = false;
        rows.add('${_fieldLabels[field] ?? field}：资料缺失，无法核对。');
        return;
      }
      final oldValue = previous[field];
      final newValue = current[field];
      rows.add(
        '${_fieldLabels[field] ?? field}：原录入 ${display(oldValue)}；当前药箱 ${display(newValue)}',
      );
      try {
        if (jsonEncode(_recoveryComparable(oldValue, field)) !=
            jsonEncode(_recoveryComparable(newValue, field))) {
          matches = false;
        }
      } catch (_) {
        matches = false;
      }
    }

    for (final field in fields) {
      if (simple.contains(field)) {
        compare(field, original, latest);
      } else if (leafletControllers.containsKey(field)) {
        if (original['leaflet'] is! Map || latest['leaflet'] is! Map) {
          matches = false;
          rows.add('${_fieldLabels[field]}：资料缺失，无法核对。');
        } else {
          compare(field, original['leaflet'] as Map, latest['leaflet'] as Map);
        }
      } else if (field != 'expiryValue' && field != 'lotNumber') {
        matches = false;
        rows.add('${_fieldLabels[field] ?? field}：暂不能验证来源。');
      }
    }

    final requiresBatch =
        fields.contains('expiryValue') ||
        fields.contains('lotNumber') ||
        photoDrafts.any((photo) => photo['purpose'] == 'expiry');
    if (requiresBatch) {
      final oldBatches = original['batches'];
      final currentBatches = latest['batches'];
      final possible = currentBatches is List
          ? currentBatches
                .whereType<Map>()
                .where((batch) => batch['id'] == savedBatchId)
                .toList()
          : <Map>[];
      if (!savedBatchIdConfirmed ||
          savedBatchId == null ||
          savedBatchVersion == null ||
          oldBatches is! List ||
          oldBatches.length != 1 ||
          oldBatches.single is! Map ||
          possible.length != 1 ||
          possible.single['version'] is! int ||
          (possible.single['version'] as int) < savedBatchVersion! ||
          !possible.single.containsKey('quantity') ||
          (possible.single['quantity'] != null &&
              possible.single['quantity'] is! num) ||
          possible.single['unit'] is! String) {
        matches = false;
        rows.add('原批次或其版本无法确认；请在药品详情核对，原草稿会保留。');
      } else {
        final oldBatch = oldBatches.single as Map;
        final currentBatch = possible.single;
        rows.add(
          '批次版本：原记录 $savedBatchVersion；当前 ${currentBatch['version']}。'
          '当前余量：${display(currentBatch['quantity'])} ${unitLabel(currentBatch['unit'] as String)}',
        );
        compare('lotNumber', oldBatch, currentBatch);
        if (oldBatch['expiry'] is! Map || currentBatch['expiry'] is! Map) {
          matches = false;
          rows.add('有效期资料缺失，无法核对。');
        } else {
          final oldExpiry = oldBatch['expiry'] as Map;
          final newExpiry = currentBatch['expiry'] as Map;
          if (!oldExpiry.containsKey('value') ||
              !newExpiry.containsKey('value') ||
              !oldExpiry.containsKey('precision') ||
              !newExpiry.containsKey('precision')) {
            matches = false;
            rows.add('有效期精度缺失，无法核对。');
          } else {
            rows.add(
              '有效期：原录入 ${display(oldExpiry['value'])}（${display(oldExpiry['precision'])}）；'
              '当前药箱 ${display(newExpiry['value'])}（${display(newExpiry['precision'])}）',
            );
            if (oldExpiry['value'] != newExpiry['value'] ||
                oldExpiry['precision'] != newExpiry['precision']) {
              matches = false;
            }
          }
        }
      }
    }
    return (matches: matches, rows: rows);
  }

  Future<void> _reviewEvidenceRecovery() async {
    if (saving ||
        !_isDraftIdentityCurrent ||
        savedMedicineId == null ||
        attemptedPayload == null) {
      return;
    }
    final route = ModalRoute.of(context);
    if (route == null || !route.isCurrent) return;
    final id = draftId;
    final medicineId = savedMedicineId!;
    bool current() =>
        mounted &&
        _isDraftIdentityCurrent &&
        draftId == id &&
        savedMedicineId == medicineId &&
        route.isCurrent;
    setState(() => saving = true);
    try {
      // Persist the old request and any genuine POST receipt before review.
      await _requireDraftSave(legacy: false);
      if (!current()) return;
      final latest = await widget.workflow.api.get(
        '/api/v1/medicines/$medicineId',
        isCurrent: current,
        responseIsCurrent: current,
      ) as Map<String, dynamic>;
      if (!current()) return;
      final sourceState = await widget.workflow.getRecognitionEvidenceState(
        medicineId,
        isCurrent: current,
      );
      if (!current()) return;
      final comparison = _compareRecoveryMedicine(latest);
      final previousRequest = evidenceRequest;
      final previousReceipt = evidenceAcknowledged;
      final currentEvidence = sourceState.evidence;
      bool hasReceipt(Map? request, Map? receipt) =>
          request != null &&
          receipt != null &&
          request['revision'] is int &&
          receipt['idempotencyKey'] == request['idempotencyKey'] &&
          receipt['revision'] == (request['revision'] as int) + 1 &&
          receipt['medicineVersion'] == request['medicineVersion'];
      final acknowledged = hasReceipt(previousRequest, previousReceipt);
      final historicalAck = evidenceHistory.any(
        (entry) =>
            entry['request'] is Map &&
            entry['acknowledged'] is Map &&
            hasReceipt(entry['request'] as Map, entry['acknowledged'] as Map),
      );
      var sourceSafe =
          currentEvidence == null &&
          !acknowledged &&
          !historicalAck &&
          (previousRequest == null || previousRequest['revision'] == 0);
      if (currentEvidence != null) {
        final matchesAcknowledged =
            acknowledged && currentEvidence.matchesReceipt(previousRequest!);
        final matchesHistory = evidenceHistory.any((entry) {
          if (entry['request'] is! Map ||
              entry['acknowledged'] is! Map ||
              !hasReceipt(
                entry['request'] as Map,
                entry['acknowledged'] as Map,
              )) {
            return false;
          }
          return currentEvidence.matchesReceipt(
            Map<String, dynamic>.from(entry['request'] as Map),
          );
        });
        sourceSafe =
            (matchesAcknowledged || matchesHistory) &&
            currentEvidence.currentMedicineVersion == latest['version'] &&
            currentEvidence.photos.every((photo) => photo.available) &&
            currentEvidence.batchSources.every(
              (source) => source.batchAvailable,
            );
      }
      final allUploaded = photoDrafts.every(
        (photo) => photo['uploadedId'] is String,
      );
      final historyRoom = evidenceHistory.length < 20;
      final ready =
          comparison.matches && sourceSafe && allUploaded && historyRoom;
      final sourceMessage = sourceSafe
          ? currentEvidence == null
                ? '当前未发现来源资料，原请求及照片会保留；尚无回执的请求不能确认是否曾保存。'
                : '当前来源与已收到的原回执一致，原请求及照片会保留。'
          : '当前来源已变化或原请求尚无可核验回执；请先核对现有来源，不会覆盖。';
      final rows = [
        ...comparison.rows,
        for (final photo in photoDrafts)
          '图${photo['sequence']}：${jsonEncode(photo['recognitionFields'] ?? {})}'
              '${photo['rawText'] is String && (photo['rawText'] as String).isNotEmpty ? '\n本机识别原文：${photo['rawText']}' : ''}'
              '${photo['recognitionWarnings'] is List ? '\n识别提醒：${(photo['recognitionWarnings'] as List).join('、')}' : ''}',
      ];
      if (!mounted || !current()) return;
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => _protectPrivateDialog(
          dialogContext,
          AlertDialog(
            title: const Text('核对当前药品和来源'),
            content: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '原药品版本：${savedMedicineVersion ?? '未记录'}；当前版本：${latest['version'] ?? '未记录'}。',
                  ),
                  Text(sourceMessage),
                  if (!comparison.matches)
                    const Text('药品字段或批次无法确认一致，请先在药品详情核对；不会覆盖当前来源。'),
                  if (!allUploaded) const Text('仍有照片未上传，请先重试原提交。'),
                  if (!historyRoom) const Text('历史请求已达本机保留上限，请先核对现有记录。'),
                  if (usePhotoAsCover && !coverApplied)
                    const Text('本次将保留当前封面，不重复修改封面。'),
                  for (final row in rows)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(row),
                    ),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext, false),
                child: const Text('关闭'),
              ),
              if (ready)
                FilledButton(
                  onPressed: () => Navigator.pop(dialogContext, true),
                  child: const Text('确认并准备重试'),
                ),
            ],
          ),
        ),
      );
      if (confirmed != true || !current() || !ready) return;
      final confirmedMedicine = await widget.workflow.api.get(
        '/api/v1/medicines/$medicineId',
        isCurrent: current,
        responseIsCurrent: current,
      ) as Map<String, dynamic>;
      if (!current()) return;
      final confirmedSource = await widget.workflow.getRecognitionEvidenceState(
        medicineId,
        isCurrent: current,
      );
      if (!mounted || !current()) return;
      if (jsonEncode(_canonicalRecoverySnapshot(latest)) !=
              jsonEncode(_canonicalRecoverySnapshot(confirmedMedicine)) ||
          jsonEncode(
                _canonicalRecoverySnapshot(
                  _recoverySourceSnapshot(sourceState),
                ),
              ) !=
              jsonEncode(
                _canonicalRecoverySnapshot(
                  _recoverySourceSnapshot(confirmedSource),
                ),
              )) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('核对期间药品或来源发生变化，请重新核对；原请求和照片仍保留。')),
        );
        return;
      }
      final nextRevision = confirmedSource.evidence?.revision ?? 0;
      final newVersion = confirmedMedicine['version'] as int;
      final requiresBatch =
          review.source('expiryValue') != null ||
          review.source('lotNumber') != null ||
          photoDrafts.any((photo) => photo['purpose'] == 'expiry');
      int? confirmedBatchVersion;
      if (requiresBatch) {
        final batches = (confirmedMedicine['batches'] as List)
            .whereType<Map>()
            .where((batch) => batch['id'] == savedBatchId)
            .toList();
        if (batches.length != 1 || batches.single['version'] is! int) {
          throw const _BatchIdentityUnconfirmed();
        }
        confirmedBatchVersion = batches.single['version'] as int;
      }
      final Map<String, dynamic> next;
      if (previousRequest == null) {
        next = _buildEvidenceRequest(photoDrafts, newVersion, nextRevision);
      } else {
        next = Map<String, dynamic>.from(
          jsonDecode(jsonEncode(previousRequest)) as Map,
        );
        next['revision'] = nextRevision;
        next['medicineVersion'] = newVersion;
        next['idempotencyKey'] = 'evidence_${_newLocalId()}';
      }
      evidenceHistory.add({
        'request': previousRequest == null
            ? null
            : jsonDecode(jsonEncode(previousRequest)),
        'acknowledged': previousReceipt == null
            ? null
            : Map<String, dynamic>.from(previousReceipt),
        'coverIntent': coverIntent == null
            ? null
            : Map<String, dynamic>.from(coverIntent!),
        'medicineVersion': savedMedicineVersion,
        'batchVersion': savedBatchVersion,
      });
      evidenceRequest = next;
      evidenceAcknowledged = null;
      evidenceSynced = false;
      savedMedicineVersion = newVersion;
      if (confirmedBatchVersion != null) {
        savedBatchVersion = confirmedBatchVersion;
      }
      if (usePhotoAsCover && !coverApplied) {
        usePhotoAsCover = false;
        coverIntent = null;
      }
      await _requireDraftSave(legacy: false);
      if (!mounted || !current()) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('核对结果已保留，请重试资料同步。')));
    } catch (_) {
      if (mounted && current()) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('当前药品或来源暂时无法核对；原请求、照片和资料仍保留在本机草稿。')),
        );
      }
    } finally {
      if (mounted && draftId == id && _isDraftIdentityCurrent) {
        setState(() => saving = false);
      }
    }
  }

  Future<void> _save() async {
    if (saving || recognizing || handlingBack || !_isDraftIdentityCurrent) {
      return;
    }
    if (_isCleanupDraft) {
      _showCleanupHint();
      return;
    }
    if (attemptedPayload == null &&
        photoDrafts.any((photo) => photo['retryFields'] is Map)) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('请先完成照片的重识别核对，原结果已保留。')));
      return;
    }
    if (attemptedPayload == null && _hasBlockingConflicts) {
      setState(() {
        if (_reviewControllers.keys.any(
          (field) => review.requiresChoice(field, photoDrafts),
        )) {
          identityExpanded = true;
          leafletExpanded = true;
        }
        if (_hasMoreReviewConflicts) moreExpanded = true;
        if (['purposeCategory', 'populationTags', 'purposeTags'].any(
          (field) => review.requiresChoice(field, photoDrafts),
        )) {
          categoryExpanded = true;
        }
      });
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('药品信息存在不同识别结果，请先在逐图核对中明确选择。')),
      );
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

    Future<MedicineRecord> freshMedicine(String medicineId) async {
      final response = await workflow.api.get(
        '/api/v1/medicines/$medicineId',
        isCurrent: isCurrentIntent,
        responseIsCurrent: isCurrentIntent,
      );
      requireCurrentIntent();
      return MedicineRecord.fromJson(response as Map<String, dynamic>);
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
      'lotNumber': _nullableText(lotController.text),
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
      bool uploadPhotos =
          photos.isEmpty &&
          review.toJson().values.any(
            (source) => (source as Map)['source'] == 'removed',
          );
      if (photos.isNotEmpty) {
        final consent = await showDialog<bool>(
          context: context,
          builder: (dialogContext) => _protectPrivateDialog(
            dialogContext,
            AlertDialog(
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
            builder: (dialogContext) => _protectPrivateDialog(
              dialogContext,
              AlertDialog(
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
      final creating = savedMedicineId == null;
      var medicine = creating
          ? await repository.createMedicine(
              attemptedPayload!,
              isCurrent: isCurrentIntent,
            )
          : await freshMedicine(savedMedicineId!);
      requireCurrentIntent();
      savedMedicineId = medicine.id;
      if (creating) savedMedicineVersion = medicine.version;
      if (creating && savedBatchId == null && medicine.batches.length == 1) {
        savedBatchId = medicine.batches.single.id;
        savedBatchIdConfirmed = true;
      }
      if (!await _saveDraft(legacy: false)) throw StateError('本机保存回执未确认，请重试。');
      requireCurrentIntent();
      if (creating &&
          savedBatchIdConfirmed &&
          (review.source('expiryValue') != null ||
              review.source('lotNumber') != null ||
              photos.any((photo) => photo['purpose'] == 'expiry'))) {
        final latest = await workflow.api.get(
          '/api/v1/medicines/${medicine.id}',
          isCurrent: isCurrentIntent,
          responseIsCurrent: isCurrentIntent,
        ) as Map<String, dynamic>;
        requireCurrentIntent();
        final batches = (latest['batches'] as List? ?? [])
            .whereType<Map<String, dynamic>>()
            .where((batch) => batch['id'] == savedBatchId)
            .toList();
        if (latest['version'] == savedMedicineVersion &&
            batches.length == 1 &&
            batches.single['version'] is int) {
          savedBatchVersion = batches.single['version'] as int;
          if (!await _saveDraft(legacy: false)) throw const _DraftSaveFailure();
          requireCurrentIntent();
        }
      }
      if (uploadPhotos) {
        for (final photo in photos) {
          if (photo['state'] != null && photo['state'] != 'ready') continue;
          if (photo['uploadedId'] != null) continue;
          final path = photo['path'] as String;
          final purpose = photo['purpose'] as String;
          if (purpose == 'expiry' &&
              (savedBatchId == null || !savedBatchIdConfirmed) &&
              photo['ownedLocal'] != null) {
            throw const _BatchIdentityUnconfirmed();
          }
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
            batchId: purpose == 'expiry' && savedBatchIdConfirmed
                ? savedBatchId
                : null,
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
        final allPhotosUploaded = photos.every(
          (photo) => photo['uploadedId'] is String,
        );
        final needsEvidence =
            allPhotosUploaded &&
            (photos.any((photo) => photo['recognitionStatus'] != null) ||
                review.toJson().values.any(
                  (source) => (source as Map)['source'] == 'removed',
                ));
        final needsCover =
            allPhotosUploaded && setCover && fronts.isNotEmpty && !coverApplied;
        RecognitionEvidenceState? evidenceState;
        if (needsCover ||
            (needsEvidence && !evidenceSynced && evidenceRequest == null)) {
          evidenceState = await workflow.getRecognitionEvidenceState(
            medicine.id,
            isCurrent: isCurrentIntent,
          );
          requireCurrentIntent();
        }
        if (needsCover) {
          if (evidenceState?.coverPhotoVersionGuard != true ||
              savedMedicineVersion == null) {
            throw StateError('服务未确认支持封面版本保护');
          }
          final target = fronts.last['uploadedId'] as String;
          medicine = await freshMedicine(medicine.id);
          requireCurrentIntent();
          if (coverIntent == null) {
            if (medicine.version != savedMedicineVersion) {
              throw StateError('药品已被其他成员修改');
            }
            if (medicine.coverPhotoId == target) {
              coverApplied = true;
            } else {
              coverIntent = {
                'photoId': target,
                'version': savedMedicineVersion,
              };
            }
            if (!await _saveDraft(legacy: false)) {
              throw const _DraftSaveFailure();
            }
            requireCurrentIntent();
          }
          if (!coverApplied) {
            final baseVersion = coverIntent!['version'] as int;
            final desired = coverIntent!['photoId'] as String;
            if (medicine.version == baseVersion + 1 &&
                medicine.coverPhotoId == desired) {
              // The desired current state is confirmed, without assuming which
              // client performed an earlier write whose response was lost.
              coverApplied = true;
              savedMedicineVersion = medicine.version;
            } else if (medicine.version == baseVersion &&
                medicine.coverPhotoId != desired) {
              await workflow.setCoverPhoto(
                medicine.id,
                desired,
                version: baseVersion,
                isCurrent: isCurrentIntent,
              );
              requireCurrentIntent();
              medicine = await freshMedicine(medicine.id);
              requireCurrentIntent();
              if (medicine.version != baseVersion + 1 ||
                  medicine.coverPhotoId != desired) {
                throw StateError('封面或药品已发生并发修改');
              }
              coverApplied = true;
              savedMedicineVersion = medicine.version;
            } else {
              throw StateError('封面或药品已发生并发修改');
            }
            if (!await _saveDraft(legacy: false)) {
              throw const _DraftSaveFailure();
            }
            requireCurrentIntent();
          }
        }
        if (needsEvidence && !evidenceSynced) {
          if (evidenceRequest == null) {
            if (savedMedicineVersion == null ||
                evidenceState?.evidence != null) {
              throw StateError('已有来源或药品版本未知，请先核对');
            }
            medicine = await freshMedicine(medicine.id);
            requireCurrentIntent();
            if (medicine.version != savedMedicineVersion) {
              throw StateError('药品已被其他成员修改');
            }
            evidenceRequest = _buildEvidenceRequest(
              photos,
              savedMedicineVersion!,
              0,
            );
            if (!await _saveDraft(legacy: false)) {
              throw const _DraftSaveFailure();
            }
            requireCurrentIntent();
          }
          final pendingBatchSources =
              evidenceRequest!['batchSources'] as List? ?? [];
          if (pendingBatchSources.any(
            (source) =>
                source is! Map ||
                !savedBatchIdConfirmed ||
                source['batchId'] != savedBatchId,
          )) {
            throw const _BatchIdentityUnconfirmed();
          }
          final evidencePhotos = evidenceRequest!['photos'] as List;
          if (evidencePhotos.length > 100 ||
              evidencePhotos.any(
                (photo) =>
                    utf8.encode(jsonEncode(photo)).length > 32 * 1024 ||
                    (photo['warnings'] is List &&
                        ((photo['warnings'] as List).length > 20 ||
                            (photo['warnings'] as List).any(
                              (warning) =>
                                  warning is! String ||
                                  warning.runes.length > 500,
                            ))),
              ) ||
              utf8
                      .encode(
                        jsonEncode({
                          'schemaVersion': evidenceRequest!['schemaVersion'],
                          'photos': evidencePhotos,
                          'fieldSources': evidenceRequest!['fieldSources'],
                          if (evidenceRequest!['batchSources'] != null)
                            'batchSources': evidenceRequest!['batchSources'],
                        }),
                      )
                      .length >
                  256 * 1024) {
            throw const FormatException('逐图资料超过大小上限，原文已保留在本机草稿。');
          }
          final savedEvidence = await workflow.saveRecognitionEvidence(
            medicine.id,
            evidenceRequest!,
            isCurrent: isCurrentIntent,
          );
          requireCurrentIntent();
          if (savedEvidence == null ||
              !savedEvidence.matchesReceipt(evidenceRequest!)) {
            throw StateError('资料来源需要重新核对');
          }
          evidenceAcknowledged = {
            'idempotencyKey': evidenceRequest!['idempotencyKey'],
            'revision': savedEvidence.revision,
            'medicineVersion': savedEvidence.medicineVersion,
          };
          if (!savedEvidence.matchesSaveRequest(evidenceRequest!)) {
            if (!await _saveDraft(legacy: false)) {
              throw const _DraftSaveFailure();
            }
            requireCurrentIntent();
            if (!mounted || !isCurrentIntent()) return;
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(content: Text('原版本资料已收到保存回执，但当前资料已变化；请核对后继续同步。')),
            );
            return;
          }
          evidenceSynced = true;
          if (!await _saveDraft(legacy: false)) throw const _DraftSaveFailure();
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
                : error is _BatchIdentityUnconfirmed
                ? '库存已保存，批次身份尚未确认；资料已保留本机草稿，请核对原批次后重试。'
                : error is FormatException &&
                      error.message == '逐图资料超过大小上限，原文已保留在本机草稿。'
                ? '库存已保存；逐图资料超过大小上限，原文已保留在本机草稿。'
                : '库存已保存，照片、封面或资料来源待同步。草稿已保留，重试不会重复创建药品。',
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
    if (!_isDraftIdentityCurrent) return;
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
    _manualField('expiryValue');
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
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _identitySignals,
    builder: (context, _) => _isDraftIdentityCurrent
        ? _buildEntry(context)
        : const Scaffold(body: Center(child: Text('家庭身份已变化，请重新打开药品录入。'))),
  );

  Widget _buildEntry(BuildContext context) => PopScope<Object?>(
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
          if (savedMedicineId != null && !evidenceSynced && !_isCleanupDraft)
            IconButton(
              tooltip: '核对来源同步',
              onPressed: saving || handlingBack
                  ? null
                  : _reviewEvidenceRecovery,
              icon: const Icon(Icons.fact_check_outlined),
            ),
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
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (savedMedicineId != null &&
                  !evidenceSynced &&
                  !_isCleanupDraft)
                TextButton(
                  onPressed: saving || handlingBack
                      ? null
                      : _reviewEvidenceRecovery,
                  child: const Text('核对当前药品与来源'),
                ),
              PrimaryButton(
                label: saving
                    ? '正在保存…'
                    : attemptedPayload != null
                    ? '重试原提交'
                    : '核对后保存',
                icon: Icons.check_rounded,
                onPressed: saving || recognizing || handlingBack ? null : _save,
              ),
            ],
          ),
        ),
      ),
      body: Stack(
        children: [
          AbsorbPointer(
            absorbing: attemptedPayload != null || saving || _isCleanupDraft,
            child: AppPage(
              padding: const EdgeInsets.fromLTRB(18, 8, 18, 20),
              child: ListView(
                children: [
                  if (attemptedPayload != null)
                    AppCard(
                      child: Text(
                        savedMedicineId == null
                            ? '原提交待确认，已锁定内容避免重复入库。请重试原提交；成功后在详情页修改。'
                            : evidenceAcknowledged != null
                            ? '原版本资料已收到保存回执，但当前资料已变化。请核对来源后继续同步。'
                            : '药品已保存，照片、封面或资料来源待同步。请重试原提交；不会重复创建药品。',
                      ),
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
                          photoDrafts.isEmpty ? '拍照识别，或直接填写药名' : '照片与识别资料',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 6),
                        if (photoDrafts.isEmpty) ...[
                          const Text('识别结果需要核对，照片发送前会询问。'),
                          const SizedBox(height: 14),
                          PrimaryButton(
                            label: recognizing ? '正在识别…' : '拍药盒',
                            icon: Icons.camera_alt_rounded,
                            onPressed: recognizing
                                ? null
                                : () =>
                                      _chooseImage(action: _ImageAction.camera),
                          ),
                          const SizedBox(height: 8),
                          SoftButton(
                            label: '拍说明书',
                            icon: Icons.document_scanner_outlined,
                            onPressed: recognizing
                                ? null
                                : () => _chooseImage(
                                    action: _ImageAction.camera,
                                    leafletPhoto: true,
                                  ),
                          ),
                          TextButton.icon(
                            onPressed: recognizing
                                ? null
                                : () => _captureOptions(scanAndAlbumOnly: true),
                            icon: const Icon(Icons.qr_code_scanner_rounded),
                            label: const Text('扫码 / 相册'),
                          ),
                        ] else ...[
                          SingleChildScrollView(
                            scrollDirection: Axis.horizontal,
                            child: Row(
                              children: [
                                for (final photo in photoDrafts)
                                  Padding(
                                    padding: const EdgeInsets.only(right: 8),
                                    child: Column(
                                      children: [
                                        ClipRRect(
                                          borderRadius: BorderRadius.circular(
                                            8,
                                          ),
                                          child: Image.file(
                                            File(photo['path'] as String),
                                            width: 64,
                                            height: 64,
                                            fit: BoxFit.cover,
                                            errorBuilder: (_, _, _) =>
                                                const SizedBox(
                                                  width: 64,
                                                  height: 64,
                                                  child: Icon(
                                                    Icons.broken_image_outlined,
                                                  ),
                                                ),
                                          ),
                                        ),
                                        Text('图${photo['sequence']}'),
                                      ],
                                    ),
                                  ),
                              ],
                            ),
                          ),
                          TextButton.icon(
                            onPressed: recognizing ? null : _captureOptions,
                            icon: const Icon(Icons.add_a_photo_outlined),
                            label: const Text('继续补拍'),
                          ),
                          ExpansionTile(
                            key: ValueKey(_hasBlockingConflicts),
                            title: const Text('逐图核对与来源'),
                            initiallyExpanded: _hasBlockingConflicts,
                            children: [_photoReview()],
                          ),
                        ],
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
                            _manualField('name');
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
                          privacySignal: _identitySignals,
                          isCurrent: () => _isDraftIdentityCurrent,
                          label: '包装有效期',
                          precision: expiryPrecision == 'day' ? 'day' : 'month',
                          onChanged: () {
                            setState(() {
                              touchedExpiry = true;
                              if (expiryPrecision == 'unknown') {
                                expiryPrecision = 'month';
                              }
                            });
                            _manualField('expiryValue');
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
                        const SizedBox(height: 12),
                        _optionalSection(
                          title: '品牌、规格与厂家（选填）',
                          expanded: identityExpanded,
                          onTap: () {
                            setState(
                              () => identityExpanded = !identityExpanded,
                            );
                            _markDirty();
                          },
                        ),
                        if (identityExpanded) ...[
                          TextField(
                            controller: brandController,
                            onChanged: (_) => _manualField('brand'),
                            decoration: const InputDecoration(
                              labelText: '品牌（按包装核对）',
                            ),
                          ),
                          const SizedBox(height: 12),
                          TextField(
                            controller: specificationController,
                            onChanged: (_) => _manualField('specification'),
                            decoration: const InputDecoration(
                              labelText: '包装规格',
                              helperText: '如每盒20粒；服药间隔不属于包装数量',
                              helperMaxLines: 3,
                            ),
                          ),
                          const SizedBox(height: 12),
                          TextField(
                            controller: manufacturerController,
                            onChanged: (_) => _manualField('manufacturer'),
                            decoration: const InputDecoration(labelText: '厂家'),
                          ),
                          const SizedBox(height: 12),
                          TextField(
                            controller: lotController,
                            onChanged: (_) => _manualField('lotNumber'),
                            decoration: const InputDecoration(
                              labelText: '批号（选填）',
                            ),
                          ),
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
                                privacySignal: _identitySignals,
                                isCurrent: () => _isDraftIdentityCurrent,
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
                            onPurposeChanged: () {
                              purposeTagsTouched = true;
                              review.markManual('purposeTags');
                            },
                            onChanged: () {
                              final snapshot = jsonEncode(
                                populationTags.toList()..sort(),
                              );
                              if (_populationSnapshot != snapshot) {
                                review.markManual('populationTags');
                                _populationSnapshot = snapshot;
                              }
                              setState(() {});
                              _markDirty();
                            },
                          ),
                          TextField(
                            controller: purposeController,
                            onChanged: (_) => _manualField('purposeCategory'),
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
                            onChanged: (_) => _manualField('approvalNumber'),
                            decoration: const InputDecoration(
                              labelText: '批准文号',
                            ),
                          ),
                          const SizedBox(height: 12),
                          TextField(
                            controller: ingredientController,
                            onChanged: (_) => _manualField('activeIngredients'),
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
                        _optionalSection(
                          title: '说明书（选填，识别后请核对）',
                          expanded: leafletExpanded,
                          onTap: () {
                            setState(() => leafletExpanded = !leafletExpanded);
                            _markDirty();
                          },
                        ),
                        if (leafletExpanded) ...[
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
                              onChanged: (_) => _manualField(entry.key),
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
