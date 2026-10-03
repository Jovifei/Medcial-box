import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_surfaces.dart';
import '../../data/api_client.dart';
import '../../data/api_plan_repository.dart';
import '../../data/dose_confirmation_operations.dart';
import '../../models/plan_models.dart';

/// History uses server snapshots. Corrections append an explicit user event;
/// they never edit a snapshot, infer a dose, or deduct stock.
class PlanHistoryPage extends StatefulWidget {
  const PlanHistoryPage({
    super.key,
    required this.repository,
    required this.planId,
  });
  final ApiPlanRepository repository;
  final String planId;

  @override
  State<PlanHistoryPage> createState() => _PlanHistoryPageState();
}

class _PlanHistoryPageState extends State<PlanHistoryPage> {
  late DoseConfirmationOperations _operations;
  PlanHistory? _history;
  Object? _failure;
  bool _permissionFailed = false;
  bool _canManage = false;
  bool _loading = true;
  bool _dialogOpen = false;
  bool _submitting = false;
  bool _observedBusy = false;
  int _loadGeneration = 0;
  int _operationsRevision = 0;
  int? _loadedEpoch;
  final Set<String> _blockedOccurrences = {};

  @override
  void initState() {
    super.initState();
    _bindOperations();
    unawaited(_reload());
  }

  void _bindOperations() {
    _operations = DoseConfirmationOperations.forClient(widget.repository.api);
    _operations.addListener(_onOperationsChanged);
  }

  @override
  void didUpdateWidget(covariant PlanHistoryPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.repository == widget.repository &&
        oldWidget.planId == widget.planId) {
      return;
    }
    _operations.removeListener(_onOperationsChanged);
    _bindOperations();
    _history = null;
    _failure = null;
    _loadedEpoch = null;
    _canManage = false;
    _observedBusy = false;
    _blockedOccurrences.clear();
    unawaited(_reload());
  }

  @override
  void dispose() {
    _loadGeneration++;
    _operations.removeListener(_onOperationsChanged);
    super.dispose();
  }

  bool _hasBusyRecord() =>
      _history?.records.any(
        (record) => _operations.isBusy(record.occurrenceId, record.date),
      ) ??
      false;

  void _onOperationsChanged() {
    if (!mounted) return;
    _operationsRevision++;
    final busy = _hasBusyRecord();
    final settledElsewhere = _observedBusy && !busy && !_submitting;
    setState(() => _observedBusy = busy);
    // A page reopened while another page's request is pending must unlock and
    // read the result when that request settles. This never replays a write.
    if (settledElsewhere && !_loading) unawaited(_reload());
  }

  Future<void> _reload() async {
    final repository = widget.repository;
    final planId = widget.planId;
    final epoch = repository.api.identityEpoch;
    final generation = ++_loadGeneration;
    final operationsRevision = _operationsRevision;
    setState(() {
      _loading = true;
      _canManage = false;
    });
    // Read permission independently: its failure must not hide readable history.
    final permission = repository
        .getPlan(planId)
        .then<PlanDetail?>((detail) => detail, onError: (Object _) => null);
    PlanHistory? history;
    Object? failure;
    try {
      history = await repository.planHistory(planId);
    } catch (error) {
      failure = error;
    }
    final detail = await permission;
    if (!mounted || generation != _loadGeneration) return;
    if (repository.api.identityEpoch != epoch) {
      setState(() {
        _history = null;
        _failure = const ApiException(
          statusCode: 401,
          code: 'STALE_SESSION',
          message: '会话已变更，请重新加载。',
        );
        _canManage = false;
        _loading = false;
      });
      return;
    }
    if (operationsRevision != _operationsRevision) {
      // A request on another page may settle while these reads are in flight.
      // Discard that potentially pre-correction snapshot and read again.
      await _reload();
      return;
    }
    setState(() {
      _history = history;
      _failure = failure;
      _loadedEpoch = epoch;
      _permissionFailed = detail == null;
      // Conservative UI permission: PlanDetail already describes canManage=false
      // as read-only. Do not widen that UI contract to the API's canView rule.
      _canManage = detail?.canManage ?? false;
      _loading = false;
      _observedBusy = _hasBusyRecord();
    });
  }

  bool get _currentIdentity =>
      _loadedEpoch == widget.repository.api.identityEpoch;

  bool _canCorrect(PlanHistoryRecord record) =>
      _currentIdentity &&
      _canManage &&
      !_loading &&
      _failure == null &&
      !_blockedOccurrences.contains(record.occurrenceId) &&
      !record.superseded &&
      (record.status == 'taken' || record.status == 'skipped');

  Future<void> _confirmCorrection(
    PlanHistoryRecord record,
    String action,
  ) async {
    if (_dialogOpen ||
        _submitting ||
        !_canCorrect(record) ||
        _operations.pendingFor(record.occurrenceId, record.date) != null) {
      return;
    }
    final epoch = widget.repository.api.identityEpoch;
    final generation = _loadGeneration;
    _dialogOpen = true;
    final target = action == 'taken' ? '已服用' : '已跳过';
    bool? confirmed;
    var decisionMade = false;
    try {
      confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('纠正这条服药记录？'),
          content: SingleChildScrollView(
            child: Text(
              '${record.date} ${record.time}\n${record.medicineName} · ${record.dosageText}\n'
              '将“${record.statusLabel}”改为“$target”。\n'
              '原记录和剂量快照会保留，并新增一条纠正记录。此操作不会扣减库存。',
            ),
          ),
          actions: [
            TextButton(
              onPressed: () {
                if (decisionMade) return;
                decisionMade = true;
                Navigator.pop(context, false);
              },
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () {
                if (decisionMade) return;
                decisionMade = true;
                Navigator.pop(context, true);
              },
              child: const Text('确认纠正'),
            ),
          ],
        ),
      );
    } finally {
      _dialogOpen = false;
    }
    if (!mounted) return;
    if (epoch != widget.repository.api.identityEpoch) {
      setState(() {
        _history = null;
        _canManage = false;
        _failure = const ApiException(
          statusCode: 401,
          code: 'STALE_SESSION',
          message: '会话已变更，请重新加载。',
        );
      });
      return;
    }
    if (confirmed != true ||
        generation != _loadGeneration ||
        !_canCorrect(record)) {
      return;
    }
    await _submit(record, action);
  }

  void _notice(String message) {
    if (mounted && (ModalRoute.of(context)?.isCurrent ?? false)) {
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(message)));
    }
  }

  Future<void> _submit(PlanHistoryRecord record, String action) async {
    if (_submitting || !_canCorrect(record)) return;
    final repository = widget.repository;
    final operations = _operations;
    final generation = _loadGeneration;
    final epoch = repository.api.identityEpoch;
    DoseConfirmationAttempt? attempt;
    String? acknowledgedStatus;
    setState(() => _submitting = true);
    try {
      attempt = operations.begin(
        occurrenceId: record.occurrenceId,
        date: record.date,
        action: action,
      );
      if (attempt == null) return;
      await repository.confirmDose(
        record.occurrenceId,
        action: attempt.action,
        idempotencyKey: attempt.key,
        onConfirmed: (status) {
          acknowledgedStatus = status;
          operations.complete(attempt!);
        },
      );
      if (!mounted ||
          generation != _loadGeneration ||
          epoch != repository.api.identityEpoch) {
        return;
      }
      await _reload();
      if (!mounted || epoch != repository.api.identityEpoch) return;
      final sameResult = acknowledgedStatus == attempt.action;
      _notice(
        _failure == null
            ? (sameResult ? '纠正已保存' : '原纠正结果已核对，当前状态以最新历史为准。')
            : (sameResult
                  ? '纠正已保存，但历史暂时无法刷新，请刷新历史核对。'
                  : '原纠正结果已核对，但历史暂时无法刷新。请刷新历史核对最新状态。'),
      );
    } catch (error) {
      if (!mounted ||
          generation != _loadGeneration ||
          epoch != repository.api.identityEpoch) {
        return;
      }
      if (acknowledgedStatus != null) {
        await _reload();
        if (mounted && epoch == repository.api.identityEpoch) {
          final label = acknowledgedStatus == attempt?.action
              ? '纠正已保存'
              : '原纠正结果已核对';
          _notice(
            _failure == null
                ? '$label，部分同步未完成；当前状态以最新历史为准。'
                : '$label，但后续同步未完成。请刷新历史核对。',
          );
        }
        return;
      }
      if (error is ApiException &&
          (error.statusCode == 403 ||
              error.statusCode == 404 ||
              error.code == 'OCCURRENCE_SUPERSEDED')) {
        // Keep uncertain keys in the shared helper, but do not invite a new write
        // against an explicitly denied or superseded occurrence on this page.
        _blockedOccurrences.add(record.occurrenceId);
        await _reload();
      }
      if (!mounted || epoch != repository.api.identityEpoch) return;
      _notice(
        error is UnresolvedDoseConfirmation
            ? error.message
            : error is ApiException && error.code == 'OCCURRENCE_SUPERSEDED'
            ? error.message
            : friendlyApiError(error),
      );
    } finally {
      if (attempt != null) operations.release(attempt);
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('服药历史'),
      actions: [
        IconButton(
          tooltip: '刷新历史',
          onPressed: _loading || _submitting ? null : _reload,
          icon: const Icon(Icons.refresh),
        ),
      ],
    ),
    body: _loading && _history == null
        ? const Center(child: CircularProgressIndicator())
        : AppPage(
            child: ListView(
              children: [
                if (_failure != null)
                  AppCard(
                    color: const Color(0xFFFFF2ED),
                    child: Text(friendlyApiError(_failure!)),
                  )
                else if (_history != null && _currentIdentity) ...[
                  AppCard(
                    color: AppColors.mist,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '共 ${_history!.records.length} 条记录 · ${_history!.medicineName}',
                        ),
                        if (_permissionFailed)
                          const Text('暂时无法核对管理权限，当前仅可查看历史。请刷新后重试。')
                        else if (!_canManage && !_loading)
                          const Text('你对此计划只有查看权限。'),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  if (_history!.records.isEmpty)
                    const AppCard(child: Text('还没有服药记录。')),
                  ..._history!.records.map(_recordCard),
                ],
              ],
            ),
          ),
  );

  Widget _recordCard(PlanHistoryRecord record) {
    final pending = _operations.pendingFor(record.occurrenceId, record.date);
    final busy = _operations.isBusy(record.occurrenceId, record.date);
    final canCorrect = _canCorrect(record);
    final nextAction = record.status == 'taken' ? 'skipped' : 'taken';
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: AppCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    '${record.date} ${record.time}',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                Text(
                  record.statusLabel,
                  style: const TextStyle(color: AppColors.leafDeep),
                ),
              ],
            ),
            Text('${record.medicineName} · ${record.dosageText}'),
            if (!record.snapshotComplete) const Text('旧记录资料不完整，请结合原记录核对。'),
            if (record.corrected)
              const Padding(
                padding: EdgeInsets.only(top: 4),
                child: Text(
                  '该记录曾被纠正',
                  style: TextStyle(color: AppColors.muted),
                ),
              ),
            if (record.events.isNotEmpty) ...[
              const SizedBox(height: 8),
              ...record.events.map(
                (event) => Padding(
                  padding: const EdgeInsets.only(bottom: 2),
                  child: Text(
                    '${event.actionLabel} · ${event.actor ?? '家庭成员'} · ${_shortDateTime(event.at)}',
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                ),
              ),
            ],
            if (canCorrect) ...[
              const SizedBox(height: 8),
              if (pending != null && !busy) ...[
                Text(
                  '上次纠正为“${pending.action == 'taken' ? '已服用' : '已跳过'}”的结果尚未核实。请重试原纠正后，再进行其他修改。',
                ),
                OutlinedButton(
                  onPressed: _submitting
                      ? null
                      : () => _submit(record, pending.action),
                  child: const Text('重试原纠正'),
                ),
              ] else
                OutlinedButton(
                  onPressed: busy || _submitting
                      ? null
                      : () => _confirmCorrection(record, nextAction),
                  child: Text(nextAction == 'taken' ? '纠正为已服用' : '纠正为已跳过'),
                ),
            ],
          ],
        ),
      ),
    );
  }

  String _shortDateTime(String iso) {
    final parsed = DateTime.tryParse(iso)?.toLocal();
    if (parsed == null) return iso;
    String two(int v) => v.toString().padLeft(2, '0');
    return '${parsed.year}-${two(parsed.month)}-${two(parsed.day)} ${two(parsed.hour)}:${two(parsed.minute)}';
  }
}
