import 'dart:convert';
import 'dart:typed_data';

import '../models/medicine_models.dart';
import 'api_client.dart';
import 'export_temporary_store.dart';

class FamilySettingsRecord {
  const FamilySettingsRecord({
    this.stocktakeInterval = 'monthly',
    this.lastStocktakeAt,
    this.nextStocktakeAt,
  });
  final String stocktakeInterval;
  final String? lastStocktakeAt;
  final String? nextStocktakeAt;

  factory FamilySettingsRecord.fromJson(Map<String, dynamic> json) =>
      FamilySettingsRecord(
        stocktakeInterval: json['stocktakeInterval'] as String? ?? 'monthly',
        lastStocktakeAt: json['lastStocktakeAt'] as String?,
        nextStocktakeAt: json['nextStocktakeAt'] as String?,
      );

  Map<String, Object?> toJson() => {
    'stocktakeInterval': stocktakeInterval,
    'lastStocktakeAt': lastStocktakeAt,
  };
}

class LeafletPhotoRecord {
  const LeafletPhotoRecord({
    required this.id,
    required this.medicineId,
    required this.contentType,
    required this.sizeBytes,
    required this.source,
    required this.createdAt,
    required this.url,
  });

  final String id;
  final String medicineId;
  final String contentType;
  final int sizeBytes;
  final String source;
  final String createdAt;
  final String url;

  factory LeafletPhotoRecord.fromJson(Map<String, dynamic> json) =>
      LeafletPhotoRecord(
        id: json['id'] as String,
        medicineId: json['medicineId'] as String,
        contentType: json['contentType'] as String,
        sizeBytes: json['sizeBytes'] as int,
        source: json['source'] as String? ?? 'package_leaflet',
        createdAt: json['createdAt'] as String,
        url: json['url'] as String,
      );
}

class ApiWorkflowRepository {
  ApiWorkflowRepository({required this.api, ExportTemporaryStore? exportFiles})
    : exportFiles = exportFiles ?? ExportTemporaryStore();
  final ApiClient api;
  final ExportTemporaryStore exportFiles;

  Future<LeafletPhotoRecord> uploadLeafletPhoto(
    String medicineId,
    Uint8List bytes, {
    required String mimeType,
    String source = 'package_leaflet',
    String purpose = 'leaflet',
    String? batchId,
  }) async {
    if (bytes.isEmpty || bytes.length > 8 * 1024 * 1024) {
      throw const FormatException('图片大小必须在 1 字节到 8 MB 之间。');
    }
    if (!const {'image/jpeg', 'image/png'}.contains(mimeType)) {
      throw const FormatException('仅支持 JPEG 或 PNG 图片。');
    }
    final result = await api.post(
      '/api/v1/medicines/$medicineId/leaflet-photos',
      body: {
        'imageBase64': base64Encode(bytes),
        'mimeType': mimeType,
        'source': source,
        'purpose': purpose,
        'batchId': ?batchId,
      },
    ) as Map<String, dynamic>;
    return LeafletPhotoRecord.fromJson(result['photo'] as Map<String, dynamic>);
  }

  Future<void> setCoverPhoto(String medicineId, String? photoId) async {
    await api.post(
      '/api/v1/medicines/$medicineId/cover-photo',
      body: {'photoId': photoId},
    );
  }

  Future<List<LeafletPhotoRecord>> listLeafletPhotos(String medicineId) async {
    final result = await api.get(
      '/api/v1/medicines/$medicineId/leaflet-photos',
    ) as Map<String, dynamic>;
    return (result['photos'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .map(LeafletPhotoRecord.fromJson)
        .toList(growable: false);
  }

  Future<ApiBinaryResponse> readLeafletPhoto(
    String medicineId,
    String photoId,
  ) => api.getBinary('/api/v1/medicines/$medicineId/leaflet-photos/$photoId');

  Future<void> deleteLeafletPhoto(String medicineId, String photoId) async {
    await api.delete('/api/v1/medicines/$medicineId/leaflet-photos/$photoId');
  }

  Future<FamilySettingsRecord> getSettings() async {
    final result =
        await api.get('/api/v1/families/settings') as Map<String, dynamic>;
    return FamilySettingsRecord.fromJson(
      result['settings'] as Map<String, dynamic>,
    );
  }

  Future<FamilySettingsRecord> updateSettings(
    FamilySettingsRecord settings,
  ) async {
    final result = await api.put(
      '/api/v1/families/settings',
      settings.toJson(),
    ) as Map<String, dynamic>;
    return FamilySettingsRecord.fromJson(
      result['settings'] as Map<String, dynamic>,
    );
  }

  Future<Map<String, dynamic>?> currentStocktake() async {
    final result = await api.get(
      '/api/v1/families/stocktakes/current',
    ) as Map<String, dynamic>;
    return result['stocktake'] as Map<String, dynamic>?;
  }

  Future<Map<String, dynamic>> startStocktake() async {
    final result =
        await api.post('/api/v1/families/stocktakes') as Map<String, dynamic>;
    return result['stocktake'] as Map<String, dynamic>;
  }

  Future<List<Map<String, dynamic>>> submitStocktakeItems(
    String sessionId,
    List<Map<String, Object?>> items,
  ) async {
    final result = await api.post(
      '/api/v1/families/stocktakes/$sessionId/items',
      body: {'items': items},
    ) as Map<String, dynamic>;
    return (result['results'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .toList(growable: false);
  }

  Future<DateTime?> completeStocktake(String sessionId) async {
    final result = await api.post(
      '/api/v1/families/stocktakes/$sessionId/complete',
    ) as Map<String, dynamic>;
    return result['completedAt'] is String
        ? DateTime.tryParse(result['completedAt']! as String)
        : null;
  }

  Future<List<Map<String, dynamic>>> listRestockItems() async {
    final result =
        await api.get('/api/v1/families/restock') as Map<String, dynamic>;
    return (result['items'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .toList(growable: false);
  }

  Future<Map<String, dynamic>> addRestockItem({
    required String medicineId,
    double? desiredQuantity,
    required String unit,
  }) async {
    final result = await api.post(
      '/api/v1/families/restock',
      body: {
        'medicineId': medicineId,
        'desiredQuantity': desiredQuantity,
        'unit': unit,
      },
    ) as Map<String, dynamic>;
    return (result['item'] ?? result) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> updateRestockItem(
    String itemId, {
    required String status,
    required int version,
    double? desiredQuantity,
  }) async {
    final result = await api.put('/api/v1/families/restock/$itemId', {
      'status': status,
      'version': version,
      'desiredQuantity': ?desiredQuantity,
    }) as Map<String, dynamic>;
    return (result['item'] ?? result) as Map<String, dynamic>;
  }

  Future<void> deleteRestockItem(String itemId) async {
    await api.delete('/api/v1/families/restock/$itemId');
  }

  Future<List<Map<String, dynamic>>> listTrash() async {
    final result = await api.get('/api/v1/trash') as Map<String, dynamic>;
    return (result['items'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .toList(growable: false);
  }

  Future<void> restoreTrashItem(String type, String id) async {
    await api.post('/api/v1/trash/$type/$id/restore');
  }

  Future<List<Map<String, dynamic>>> listAuditEvents() async {
    final result =
        await api.get('/api/v1/families/audit') as Map<String, dynamic>;
    return (result['events'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .toList(growable: false);
  }

  Future<String> exportMarkdown({
    bool includePersonalDosage = false,
    bool includeArchived = false,
    bool includeStorageLocation = true,
  }) async {
    final result = await api.post(
      '/api/v1/exports/markdown',
      body: {
        'includePersonalDosage': includePersonalDosage,
        'includeArchived': includeArchived,
        'includeStorageLocation': includeStorageLocation,
      },
    ) as Map<String, dynamic>;
    return result['markdown'] as String;
  }

  /// 只读拉取药品清单（可选含归档）用于导出（R15）：
  /// 本仓库无共享内存快照，因此不会像 ApiMedicineRepository.listMedicines 那样
  /// 把归档记录写回活动库存、污染首页或触发归档药品的到期提醒。
  Future<List<MedicineRecord>> fetchMedicinesForExport({
    bool includeArchived = false,
  }) async {
    final result = await api.get(
      '/api/v1/medicines${includeArchived ? '?includeArchived=true' : ''}',
    ) as Map<String, dynamic>;
    return (result['medicines'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .map(MedicineRecord.fromJson)
        .toList(growable: false);
  }

  /// 只读拉取某药品的剂量备注用于导出（R15）：不写入共享快照。
  Future<List<DosageNoteRecord>> fetchDosageNotesForExport(
    String medicineId,
  ) async {
    final result = await api.get(
      '/api/v1/medicines/$medicineId/dosage-notes',
    ) as Map<String, dynamic>;
    return (result['notes'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .map(DosageNoteRecord.fromJson)
        .toList(growable: false);
  }

  Future<Map<String, dynamic>> createJsonBackup() async =>
      await api.post('/api/v1/backups/json') as Map<String, dynamic>;

  Future<Map<String, dynamic>> previewJsonRestore(
    Map<String, dynamic> backup,
  ) async =>
      await api.post('/api/v1/backups/preview', body: {'backup': backup})
          as Map<String, dynamic>;

  Future<Map<String, dynamic>> restoreJsonBackup(
    Map<String, dynamic> backup,
    String confirmationToken,
  ) async => await api.post(
    '/api/v1/backups/restore',
    body: {
      'backup': backup,
      'confirmationToken': confirmationToken,
      'confirmed': true,
    },
  ) as Map<String, dynamic>;

  Future<Map<String, dynamic>> exportSnapshotFormat({
    required String format,
    required bool includePersonalDosage,
    required bool includeArchived,
    required bool includeStorageLocation,
    String? snapshotId,
  }) async {
    final options = <String, dynamic>{
      'includePersonalDosage': includePersonalDosage,
      'includeArchived': includeArchived,
      'includeStorageLocation': includeStorageLocation,
    };
    if (snapshotId == null) {
      final snapshot = await api.post(
        '/api/v1/exports/snapshot',
        body: options,
      ) as Map<String, dynamic>;
      snapshotId = snapshot['snapshotId'] as String;
    }
    options['snapshotId'] = snapshotId;
    final markdown = await api.post(
      '/api/v1/exports/markdown',
      body: options,
    ) as Map<String, dynamic>;
    if (format == 'markdown') return markdown;
    final result = await api.post(
      '/api/v1/exports/$format',
      body: options,
    ) as Map<String, dynamic>;
    return {...result, 'markdown': markdown['markdown']};
  }

  Future<Map<String, dynamic>> notificationPreferences() async {
    final result = await api.get(
      '/api/v1/notification-preferences',
    ) as Map<String, dynamic>;
    return result['preferences'] as Map<String, dynamic>;
  }

  Future<void> updateNotificationPreferences({
    required String stockReminderTime,
    required List<String> channels,
  }) async {
    await api.put('/api/v1/notification-preferences', {
      'stockReminderTime': stockReminderTime,
      'channels': channels,
    });
  }

  Future<List<Map<String, dynamic>>> notificationTemplates() async {
    final result = await api.get(
      '/api/v1/notifications/templates',
    ) as Map<String, dynamic>;
    return (result['templates'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .toList(growable: false);
  }

  Future<Map<String, dynamic>> searchMedicineCandidates({
    String? name,
    String? manufacturer,
    String? approvalNumber,
    String? barcode,
    String? specification,
    required bool consentToShare,
  }) async => await api.post(
    '/api/v1/medicine-catalog/candidates',
    body: {
      if (name?.trim().isNotEmpty == true) 'name': name!.trim(),
      if (manufacturer?.trim().isNotEmpty == true)
        'manufacturer': manufacturer!.trim(),
      if (approvalNumber?.trim().isNotEmpty == true)
        'approvalNumber': approvalNumber!.trim(),
      if (barcode?.trim().isNotEmpty == true) 'barcode': barcode!.trim(),
      if (specification?.trim().isNotEmpty == true)
        'specification': specification!.trim(),
      'consentToShare': consentToShare,
    },
  ) as Map<String, dynamic>;

  Future<Map<String, dynamic>> notificationTemplateStatus() async =>
      await api.get('/api/v1/notifications/templates') as Map<String, dynamic>;

  Future<Map<String, dynamic>> subscribeWechatNotifications(
    List<String> acceptedTemplateIds,
  ) async => await api.post(
    '/api/v1/notifications/subscribe',
    body: {'acceptedTemplateIds': acceptedTemplateIds},
  ) as Map<String, dynamic>;

  Future<List<Map<String, dynamic>>> pendingNotifications() async {
    final result =
        await api.get('/api/v1/notifications/pending') as Map<String, dynamic>;
    return (result['items'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .toList(growable: false);
  }

  Map<String, dynamic> parseBackupFile(String contents) {
    final result = jsonDecode(contents);
    if (result is! Map<String, dynamic> || result['schemaVersion'] is! int) {
      throw const FormatException('这不是有效的家庭药箱 JSON 备份文件。');
    }
    return result;
  }
}
