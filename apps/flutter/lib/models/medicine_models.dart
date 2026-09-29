import 'dart:convert';

String _stringOr(Object? value, [String fallback = '']) =>
    value is String ? value : fallback;

int? _nullableInt(Object? value) => value is int ? value : null;

class ExpiryInfo {
  const ExpiryInfo({required this.state, this.label = ''});
  final String state;
  final String label;

  factory ExpiryInfo.fromJson(Object? value) {
    final json = value is Map<String, dynamic> ? value : const <String, dynamic>{};
    return ExpiryInfo(
      state: _stringOr(json['state'], 'unknown'),
      label: _stringOr(json['label']),
    );
  }
}

class AfterOpeningLimit {
  const AfterOpeningLimit.duration({
    required this.value,
    required this.unit,
    this.source,
  }) : date = null;

  const AfterOpeningLimit.date({required this.date, this.source})
    : value = null,
      unit = null;

  final int? value;
  final String? unit;
  final String? date;
  final String? source;

  bool get isDate => date != null;

  Map<String, Object?> toJson() => isDate
      ? {'date': date, if (source?.isNotEmpty == true) 'source': source}
      : {
          'value': value,
          'unit': unit,
          if (source?.isNotEmpty == true) 'source': source,
        };

  factory AfterOpeningLimit.fromJson(Object? value) {
    if (value is! Map<String, dynamic>) {
      return const AfterOpeningLimit.duration(value: 0, unit: 'day');
    }
    final source = _stringOr(value['source']);
    if (value['date'] is String) {
      return AfterOpeningLimit.date(
        date: value['date']! as String,
        source: source,
      );
    }
    return AfterOpeningLimit.duration(
      value: value['value'] is int ? value['value']! as int : 0,
      unit: _stringOr(value['unit'], 'day'),
      source: source,
    );
  }
}

class BatchRecord {
  const BatchRecord({
    required this.id,
    this.lotNumber,
    this.expiryValue,
    this.expiryPrecision = 'unknown',
    this.expiryState = const ExpiryInfo(state: 'unknown'),
    this.quantity,
    this.unit = 'other',
    this.confirmedUnitsPerPackage,
    this.storageLocation,
    this.openedState = 'unknown',
    this.openedAt,
    this.afterOpeningLimit,
    this.openedExpiryDate,
    this.managementExpiryDate,
    this.managementExpirySource,
    this.managementExpiryState = const ExpiryInfo(state: 'unknown'),
    this.dispositionStatus = 'active',
    this.version = 1,
    this.status,
  });

  final String id;
  final String? lotNumber;
  final String? expiryValue;
  final String expiryPrecision;
  final ExpiryInfo expiryState;
  final int? quantity;
  final String unit;
  final int? confirmedUnitsPerPackage;
  final String? storageLocation;
  final String openedState;
  final String? openedAt;
  final AfterOpeningLimit? afterOpeningLimit;
  final String? openedExpiryDate;
  final String? managementExpiryDate;
  final String? managementExpirySource;
  final ExpiryInfo managementExpiryState;
  final String dispositionStatus;
  final int version;
  final String? status;

  String get expiryDisplay => expiryValue ?? '待补充';
  String get quantityDisplay => quantity == null ? '数量未知' : '$quantity${unitLabel(unit)}';
  bool get isExpired =>
      managementExpiryState.state == 'expired' || expiryState.state == 'expired';

  factory BatchRecord.fromJson(Map<String, dynamic> json) {
    final expiry = json['expiry'] is Map<String, dynamic>
        ? json['expiry']! as Map<String, dynamic>
        : const <String, dynamic>{};
    final rawLimit = json['afterOpeningLimit'];
    return BatchRecord(
      id: _stringOr(json['id']),
      lotNumber: json['lotNumber'] is String ? json['lotNumber']! as String : null,
      expiryValue: expiry['value'] is String ? expiry['value']! as String : null,
      expiryPrecision: _stringOr(expiry['precision'], 'unknown'),
      expiryState: ExpiryInfo.fromJson(json['expiryState']),
      quantity: _nullableInt(json['quantity']),
      unit: _stringOr(json['unit'], 'other'),
      confirmedUnitsPerPackage: _nullableInt(json['confirmedUnitsPerPackage']),
      storageLocation: json['storageLocation'] is String
          ? json['storageLocation']! as String
          : null,
      openedState: _stringOr(json['openedState'], 'unknown'),
      openedAt: json['openedAt'] is String ? json['openedAt']! as String : null,
      afterOpeningLimit: rawLimit is Map<String, dynamic>
          ? AfterOpeningLimit.fromJson(rawLimit)
          : null,
      openedExpiryDate: json['openedExpiryDate'] is String
          ? json['openedExpiryDate']! as String
          : null,
      managementExpiryDate: json['managementExpiryDate'] is String
          ? json['managementExpiryDate']! as String
          : null,
      managementExpirySource: json['managementExpirySource'] is String
          ? json['managementExpirySource']! as String
          : null,
      managementExpiryState: ExpiryInfo.fromJson(json['managementExpiryState']),
      dispositionStatus: _stringOr(json['dispositionStatus'], 'active'),
      version: json['version'] is int ? json['version']! as int : 1,
      status: json['status'] is String ? json['status']! as String : null,
    );
  }

  factory BatchRecord.fromCacheJson(Map<String, dynamic> json) => BatchRecord(
    id: _stringOr(json['id']),
    lotNumber: json['lotNumber'] as String?,
    expiryValue: json['expiryValue'] as String?,
    expiryPrecision: _stringOr(json['expiryPrecision'], 'unknown'),
    expiryState: ExpiryInfo.fromJson(json['expiryState']),
    quantity: _nullableInt(json['quantity']),
    unit: _stringOr(json['unit'], 'other'),
    confirmedUnitsPerPackage: _nullableInt(json['confirmedUnitsPerPackage']),
    storageLocation: json['storageLocation'] as String?,
    openedState: _stringOr(json['openedState'], 'unknown'),
    openedAt: json['openedAt'] as String?,
    afterOpeningLimit: json['afterOpeningLimit'] is Map<String, dynamic>
        ? AfterOpeningLimit.fromJson(json['afterOpeningLimit'])
        : null,
    openedExpiryDate: json['openedExpiryDate'] as String?,
    managementExpiryDate: json['managementExpiryDate'] as String?,
    managementExpirySource: json['managementExpirySource'] as String?,
    managementExpiryState: ExpiryInfo.fromJson(json['managementExpiryState']),
    dispositionStatus: _stringOr(json['dispositionStatus'], 'active'),
    version: json['version'] is int ? json['version']! as int : 1,
    status: json['status'] as String?,
  );

  Map<String, Object?> toCacheJson() => {
    'id': id,
    'lotNumber': lotNumber,
    'expiryValue': expiryValue,
    'expiryPrecision': expiryPrecision,
    'expiryState': {'state': expiryState.state, 'label': expiryState.label},
    'quantity': quantity,
    'unit': unit,
    'confirmedUnitsPerPackage': confirmedUnitsPerPackage,
    'storageLocation': storageLocation,
    'openedState': openedState,
    'openedAt': openedAt,
    'afterOpeningLimit': afterOpeningLimit?.toJson(),
    'openedExpiryDate': openedExpiryDate,
    'managementExpiryDate': managementExpiryDate,
    'managementExpirySource': managementExpirySource,
    'managementExpiryState': {
      'state': managementExpiryState.state,
      'label': managementExpiryState.label,
    },
    'dispositionStatus': dispositionStatus,
    'version': version,
    'status': status,
  };

  BatchRecord copyWith({
    int? quantity,
    String? unit,
    String? openedState,
    String? openedAt,
    AfterOpeningLimit? afterOpeningLimit,
    String? storageLocation,
    int? version,
    String? status,
  }) => BatchRecord(
    id: id,
    lotNumber: lotNumber,
    expiryValue: expiryValue,
    expiryPrecision: expiryPrecision,
    expiryState: expiryState,
    quantity: quantity ?? this.quantity,
    unit: unit ?? this.unit,
    confirmedUnitsPerPackage: confirmedUnitsPerPackage,
    storageLocation: storageLocation ?? this.storageLocation,
    openedState: openedState ?? this.openedState,
    openedAt: openedAt ?? this.openedAt,
    afterOpeningLimit: afterOpeningLimit ?? this.afterOpeningLimit,
    openedExpiryDate: openedExpiryDate,
    managementExpiryDate: managementExpiryDate,
    managementExpirySource: managementExpirySource,
    managementExpiryState: managementExpiryState,
    dispositionStatus: dispositionStatus,
    version: version ?? this.version,
    status: status ?? this.status,
  );
}

class StockThreshold {
  const StockThreshold({required this.quantity, required this.unit});
  final int quantity;
  final String unit;

  factory StockThreshold.fromJson(Object? value) {
    final json = value is Map<String, dynamic> ? value : const <String, dynamic>{};
    return StockThreshold(
      quantity: json['quantity'] is int ? json['quantity']! as int : 0,
      unit: _stringOr(json['unit'], 'other'),
    );
  }

  Map<String, Object?> toJson() => {'quantity': quantity, 'unit': unit};
}

class LeafletRecord {
  const LeafletRecord({
    this.purposeSummary,
    this.packageUsageSummary,
    this.contraindicationsSummary,
    this.precautionsSummary,
    this.source,
    this.reviewStatus = 'unverified',
  });
  final String? purposeSummary;
  final String? packageUsageSummary;
  final String? contraindicationsSummary;
  final String? precautionsSummary;
  final String? source;
  final String reviewStatus;

  factory LeafletRecord.fromJson(Object? value) {
    final json = value is Map<String, dynamic> ? value : const <String, dynamic>{};
    return LeafletRecord(
      purposeSummary: json['purposeSummary'] as String?,
      packageUsageSummary: json['packageUsageSummary'] as String?,
      contraindicationsSummary: json['contraindicationsSummary'] as String?,
      precautionsSummary: json['precautionsSummary'] as String?,
      source: json['source'] as String?,
      reviewStatus: _stringOr(json['reviewStatus'], 'unverified'),
    );
  }

  Map<String, Object?> toJson() => {
    'purposeSummary': purposeSummary,
    'packageUsageSummary': packageUsageSummary,
    'contraindicationsSummary': contraindicationsSummary,
    'precautionsSummary': precautionsSummary,
    'source': source,
    'reviewStatus': reviewStatus,
  };
}

class DosageNoteRecord {
  const DosageNoteRecord({
    required this.id,
    required this.content,
    required this.visibility,
    required this.version,
    required this.isMine,
  });
  final String id;
  final String content;
  final String visibility;
  final int version;
  final bool isMine;

  factory DosageNoteRecord.fromJson(Map<String, dynamic> json) =>
      DosageNoteRecord(
        id: _stringOr(json['id']),
        content: _stringOr(json['content']),
        visibility: _stringOr(json['visibility'], 'private'),
        version: json['version'] is int ? json['version']! as int : 1,
        isMine: json['isMine'] == true,
      );
}

class MedicineRecord {
  const MedicineRecord({
    required this.id,
    required this.name,
    this.specification,
    this.manufacturer,
    this.approvalNumber,
    this.activeIngredients = const [],
    this.purposeCategory,
    this.leaflet = const LeafletRecord(),
    this.batches = const [],
    this.lowStockThreshold,
    this.stockStatus = 'unknown',
    this.stockQuantity,
    this.stockUnit,
    this.expiryState = const ExpiryInfo(state: 'unknown'),
    this.isArchived = false,
    this.version = 1,
    this.dosageNotes = const [],
  });

  final String id;
  final String name;
  final String? specification;
  final String? manufacturer;
  final String? approvalNumber;
  final List<String> activeIngredients;
  final String? purposeCategory;
  final LeafletRecord leaflet;
  final List<BatchRecord> batches;
  final StockThreshold? lowStockThreshold;
  final String stockStatus;
  final int? stockQuantity;
  final String? stockUnit;
  final ExpiryInfo expiryState;
  final bool isArchived;
  final int version;
  final List<DosageNoteRecord> dosageNotes;

  String get purpose =>
      leaflet.purposeSummary?.trim().isNotEmpty == true
          ? leaflet.purposeSummary!.trim()
          : purposeCategory ?? '用途待补充';

  String get specificationDisplay => specification ?? '规格待补充';

  String get openingOrExpirySummary {
    final dates = batches
        .map((batch) => batch.managementExpiryDate ?? batch.expiryValue)
        .whereType<String>()
        .toList()
      ..sort();
    return dates.isEmpty ? '有效期待补充' : dates.first;
  }

  factory MedicineRecord.fromJson(Map<String, dynamic> json) {
    final stock = json['stockStatus'] is Map<String, dynamic>
        ? json['stockStatus']! as Map<String, dynamic>
        : const <String, dynamic>{};
    return MedicineRecord(
      id: _stringOr(json['id']),
      name: _stringOr(json['name']),
      specification: json['specification'] as String?,
      manufacturer: json['manufacturer'] as String?,
      approvalNumber: json['approvalNumber'] as String?,
      activeIngredients: (json['activeIngredients'] as List<dynamic>? ?? [])
          .whereType<String>()
          .toList(growable: false),
      purposeCategory: json['purposeCategory'] as String?,
      leaflet: LeafletRecord.fromJson(json['leaflet']),
      batches: (json['batches'] as List<dynamic>? ?? [])
          .whereType<Map<String, dynamic>>()
          .map(BatchRecord.fromJson)
          .toList(growable: false),
      lowStockThreshold: json['lowStockThreshold'] is Map<String, dynamic>
          ? StockThreshold.fromJson(json['lowStockThreshold'])
          : null,
      stockStatus: _stringOr(stock['state'], 'unknown'),
      stockQuantity: _nullableInt(stock['quantity']),
      stockUnit: stock['unit'] as String?,
      expiryState: ExpiryInfo.fromJson(json['expiryState']),
      isArchived: json['isArchived'] == true,
      version: json['version'] is int ? json['version']! as int : 1,
      dosageNotes: (json['dosageNotes'] as List<dynamic>? ?? [])
          .whereType<Map<String, dynamic>>()
          .map(DosageNoteRecord.fromJson)
          .toList(growable: false),
    );
  }

  factory MedicineRecord.fromCacheJson(Map<String, dynamic> json) => MedicineRecord(
    id: _stringOr(json['id']),
    name: _stringOr(json['name']),
    specification: json['specification'] as String?,
    manufacturer: json['manufacturer'] as String?,
    approvalNumber: json['approvalNumber'] as String?,
    activeIngredients: (json['activeIngredients'] as List<dynamic>? ?? [])
        .whereType<String>()
        .toList(growable: false),
    purposeCategory: json['purposeCategory'] as String?,
    leaflet: LeafletRecord.fromJson(json['leaflet']),
    batches: (json['batches'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .map(BatchRecord.fromCacheJson)
        .toList(growable: false),
    lowStockThreshold: json['lowStockThreshold'] is Map<String, dynamic>
        ? StockThreshold.fromJson(json['lowStockThreshold'])
        : null,
    stockStatus: _stringOr(json['stockStatus'], 'unknown'),
    stockQuantity: _nullableInt(json['stockQuantity']),
    stockUnit: json['stockUnit'] as String?,
    expiryState: ExpiryInfo.fromJson(json['expiryState']),
    isArchived: json['isArchived'] == true,
    version: json['version'] is int ? json['version']! as int : 1,
    dosageNotes: const [],
  );

  Map<String, Object?> toCacheJson() => {
    'id': id,
    'name': name,
    'specification': specification,
    'manufacturer': manufacturer,
    'approvalNumber': approvalNumber,
    'activeIngredients': activeIngredients,
    'purposeCategory': purposeCategory,
    'leaflet': leaflet.toJson(),
    'batches': batches.map((batch) => batch.toCacheJson()).toList(),
    'lowStockThreshold': lowStockThreshold?.toJson(),
    'stockStatus': stockStatus,
    'stockQuantity': stockQuantity,
    'stockUnit': stockUnit,
    'expiryState': {'state': expiryState.state, 'label': expiryState.label},
    'isArchived': isArchived,
    'version': version,
  };

  MedicineRecord copyWith({
    String? name,
    String? specification,
    String? manufacturer,
    String? approvalNumber,
    List<String>? activeIngredients,
    String? purposeCategory,
    LeafletRecord? leaflet,
    List<BatchRecord>? batches,
    StockThreshold? lowStockThreshold,
    bool clearLowStockThreshold = false,
    String? stockStatus,
    int? stockQuantity,
    String? stockUnit,
    bool? isArchived,
    int? version,
    List<DosageNoteRecord>? dosageNotes,
  }) => MedicineRecord(
    id: id,
    name: name ?? this.name,
    specification: specification ?? this.specification,
    manufacturer: manufacturer ?? this.manufacturer,
    approvalNumber: approvalNumber ?? this.approvalNumber,
    activeIngredients: activeIngredients ?? this.activeIngredients,
    purposeCategory: purposeCategory ?? this.purposeCategory,
    leaflet: leaflet ?? this.leaflet,
    batches: batches ?? this.batches,
    lowStockThreshold: clearLowStockThreshold
        ? null
        : lowStockThreshold ?? this.lowStockThreshold,
    stockStatus: stockStatus ?? this.stockStatus,
    stockQuantity: stockQuantity ?? this.stockQuantity,
    stockUnit: stockUnit ?? this.stockUnit,
    expiryState: expiryState,
    isArchived: isArchived ?? this.isArchived,
    version: version ?? this.version,
    dosageNotes: dosageNotes ?? this.dosageNotes,
  );
}

class FamilyRecord {
  const FamilyRecord({
    required this.id,
    required this.name,
    required this.role,
    this.members = const [],
  });
  final String id;
  final String name;
  final String role;
  final List<FamilyMemberRecord> members;

  factory FamilyRecord.fromJson(Map<String, dynamic> json) => FamilyRecord(
    id: _stringOr(json['id']),
    name: _stringOr(json['name']),
    role: _stringOr(json['role'], 'member'),
    members: (json['members'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .map(FamilyMemberRecord.fromJson)
        .toList(growable: false),
  );

  Map<String, Object?> toCacheJson() => {
    'id': id,
    'name': name,
    'role': role,
    'members': members.map((member) => member.toCacheJson()).toList(),
  };
}

class FamilyMemberRecord {
  const FamilyMemberRecord({
    required this.id,
    required this.displayName,
    required this.role,
    required this.isSelf,
    required this.joinedAt,
  });
  final String id;
  final String displayName;
  final String role;
  final bool isSelf;
  final String joinedAt;

  factory FamilyMemberRecord.fromJson(Map<String, dynamic> json) =>
      FamilyMemberRecord(
        id: _stringOr(json['id']),
        displayName: _stringOr(json['displayName'], '家庭成员'),
        role: _stringOr(json['role'], 'member'),
        isSelf: json['isSelf'] == true,
        joinedAt: _stringOr(json['joinedAt']),
      );

  Map<String, Object?> toCacheJson() => {
    'id': id,
    'displayName': displayName,
    'role': role,
    'isSelf': isSelf,
    'joinedAt': joinedAt,
  };
}

String unitLabel(String unit) => switch (unit) {
  'tablet' => '片',
  'capsule' => '粒',
  'sachet' => '袋',
  'bottle' => '瓶',
  'box' => '盒',
  _ => '份',
};

String unitApiValue(String unit) => switch (unit) {
  '片' => 'tablet',
  '粒' => 'capsule',
  '袋' => 'sachet',
  '瓶' => 'bottle',
  '盒' => 'box',
  _ => 'other',
};

String? encodeMedicinePayload(MedicineRecord medicine) => jsonEncode({
  'name': medicine.name,
  'specification': medicine.specification,
  'manufacturer': medicine.manufacturer,
  'approvalNumber': medicine.approvalNumber,
  'activeIngredients': medicine.activeIngredients,
  'purposeCategory': medicine.purposeCategory,
  'leaflet': medicine.leaflet.toJson(),
  'lowStockThreshold': medicine.lowStockThreshold?.toJson(),
  'version': medicine.version,
});
