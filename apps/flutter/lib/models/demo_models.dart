enum ExpiryState { expired, dueThisMonth, expiringSoon, ok, unknown }

enum LeafletReviewStatus { unverified, matched, userConfirmed }

class DemoSession {
  const DemoSession({required this.signedIn});
  final bool signedIn;
}

class DemoBatch {
  const DemoBatch({
    required this.id,
    required this.quantity,
    required this.unit,
    required this.expiry,
    required this.state,
    this.lotNumber,
  });
  final String id;
  final int? quantity;
  final String unit;
  final String expiry;
  final ExpiryState state;
  final String? lotNumber;
}

class DemoMedicine {
  const DemoMedicine({
    required this.id,
    required this.name,
    required this.specification,
    required this.purpose,
    required this.batches,
    required this.leafletStatus,
    this.personalNote = '',
  });
  final String id;
  final String name;
  final String specification;
  final String purpose;
  final List<DemoBatch> batches;
  final LeafletReviewStatus leafletStatus;
  final String personalNote;

  DemoMedicine copyWith({String? personalNote}) => DemoMedicine(
    id: id,
    name: name,
    specification: specification,
    purpose: purpose,
    batches: batches,
    leafletStatus: leafletStatus,
    personalNote: personalNote ?? this.personalNote,
  );
}
