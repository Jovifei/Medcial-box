import 'api_client.dart';
import 'api_plan_repository.dart';

/// Notification identifiers are untrusted hints, never authority to view a plan.
/// Bound to the app router, not a tab's lifetime, so cold/background taps agree.
class NotificationTapHandler {
  NotificationTapHandler({required this.repository, required this.navigate});
  final ApiPlanRepository repository;
  final void Function(String location) navigate;
  int _request = 0;
  bool _disposed = false;

  void dispose() {
    _disposed = true;
    _request++;
  }

  Future<void> handle(String? payload) async {
    final request = ++_request;
    final epoch = repository.api.identityEpoch;
    bool current() =>
        !_disposed &&
        request == _request &&
        epoch == repository.api.identityEpoch;
    final dose = payload?.startsWith('dose') == true;
    var location = dose ? '/home?tab=plans' : '/home?tab=pending';
    try {
      // Also remove revoked/changed alarms via the generic receiver projection.
      // A receive-only user has no visible schedule; that alone isn't revocation.
      await repository.onChanged?.call();
      if (!current()) return;
      final match = RegExp(
        r'^dose-occurrence:v1:(\d{4}-\d{2}-\d{2}):([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$',
      ).firstMatch(payload ?? '');
      final date = match?.group(1);
      final parsed = date == null ? null : DateTime.tryParse(date);
      final valid =
          parsed != null && parsed.toIso8601String().startsWith(date!);
      // Legacy planId payloads and malformed hints only open a generic screen.
      // Even that navigation authenticates through a current protected read.
      final schedule = await repository.schedule(date: valid ? date : null);
      if (!current()) return;
      if (valid) {
        final entries = schedule.entries.where(
          (entry) => entry.occurrenceId == match!.group(2),
        );
        if (entries.isNotEmpty) {
          final detail = await repository.getPlan(entries.first.planId);
          if (!current()) return;
          location = '/plan/${Uri.encodeComponent(detail.plan.id)}';
        }
      }
    } on ApiException catch (error) {
      if (error.statusCode == 401) location = '/connect';
      if (error.code == 'FAMILY_NOT_FOUND') location = '/family-choice';
      // Missing/revoked care access falls back to the authenticated generic tab.
    } catch (_) {
      // Offline/errors cannot open private details from a notification payload.
    }
    if (current()) navigate(location);
  }
}
