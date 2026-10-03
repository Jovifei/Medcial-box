import 'package:flutter/foundation.dart';

import 'api_client.dart';

/// One explicitly requested write. It contains no medicine/dosage/profile data.
class DoseConfirmationAttempt {
  DoseConfirmationAttempt._({
    required this.occurrenceId,
    required this.date,
    required this.action,
    required this.key,
    required this.identityEpoch,
  });

  final String occurrenceId;
  final String date;
  final String action;
  final String key;
  final int identityEpoch;
  bool _busy = false;
}

/// A different action must wait until the original uncertain write is resolved.
/// A read alone cannot prove that a timed-out write will not commit later.
class UnresolvedDoseConfirmation implements Exception {
  const UnresolvedDoseConfirmation(this.action);
  final String action;
  String get message =>
      '上次“${action == 'taken' ? '已服用' : '跳过'}”的结果尚未确定，请先重试上次记录，再纠正。';
}

/// In-memory, per-API-session operation keys, shared by today's and history UI.
/// Keys survive page remounts, not process restarts. No automatic replay or
/// persistence of private medication records; reopen reads the server first.
class DoseConfirmationOperations extends ChangeNotifier {
  DoseConfirmationOperations._(this._api) : _epoch = _api.identityEpoch;

  static final _stores = Expando<DoseConfirmationOperations>();
  static int _serial = 0;
  static DoseConfirmationOperations forClient(ApiClient api) =>
      _stores[api] ??= DoseConfirmationOperations._(api);

  final ApiClient _api;
  int _epoch;
  final Map<String, DoseConfirmationAttempt> _pending = {};

  void _syncIdentity() {
    if (_epoch == _api.identityEpoch) return;
    _pending.clear();
    _epoch = _api.identityEpoch;
  }

  DoseConfirmationAttempt? pendingFor(String occurrenceId, String date) {
    _syncIdentity();
    final attempt = _pending[occurrenceId];
    return attempt?.date == date ? attempt : null;
  }

  bool isBusy(String occurrenceId, String date) =>
      pendingFor(occurrenceId, date)?._busy ?? false;

  /// Returns null when this occurrence already has a request in flight.
  /// Throws [UnresolvedDoseConfirmation] if a different action/date is still
  /// uncertain. The UI must offer an explicit retry of that original operation.
  DoseConfirmationAttempt? begin({
    required String occurrenceId,
    required String date,
    required String action,
  }) {
    _syncIdentity();
    if (action != 'taken' && action != 'skipped') {
      throw ArgumentError.value(action, 'action');
    }
    var attempt = _pending[occurrenceId];
    if (attempt?._busy ?? false) return null;
    if (attempt != null && (attempt.action != action || attempt.date != date)) {
      throw UnresolvedDoseConfirmation(attempt.action);
    }
    attempt ??= DoseConfirmationAttempt._(
      occurrenceId: occurrenceId,
      date: date,
      action: action,
      key: 'dose-${DateTime.now().microsecondsSinceEpoch}-${_serial++}',
      identityEpoch: _epoch,
    );
    _pending[occurrenceId] = attempt;
    attempt._busy = true;
    notifyListeners();
    return attempt;
  }

  bool isCurrent(DoseConfirmationAttempt attempt) {
    _syncIdentity();
    return attempt.identityEpoch == _epoch &&
        identical(_pending[attempt.occurrenceId], attempt);
  }

  /// Clear on the repository onConfirmed ACK, never on a read or write failure.
  void complete(DoseConfirmationAttempt attempt) {
    if (isCurrent(attempt)) {
      _pending.remove(attempt.occurrenceId);
      notifyListeners();
    }
  }

  /// Failure releases only the in-flight lock; explicit retry keeps the key.
  void release(DoseConfirmationAttempt attempt) {
    if (isCurrent(attempt)) {
      attempt._busy = false;
      notifyListeners();
    }
  }
}
