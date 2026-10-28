import 'dart:async';

import 'package:flutter/material.dart';

import '../../data/api_client.dart';
import '../../data/api_workflow_repository.dart';
import '../../models/medicine_models.dart';

/// 只读归档列表，不更新共享库存或本地缓存。
class ArchivedMedicinesPage extends StatefulWidget {
  const ArchivedMedicinesPage({super.key, required this.workflow});
  final ApiWorkflowRepository workflow;

  @override
  State<ArchivedMedicinesPage> createState() => _ArchivedMedicinesPageState();
}

class _ArchivedMedicinesPageState extends State<ArchivedMedicinesPage> {
  List<MedicineRecord> _items = const [];
  Object? _failure;
  bool _loading = true;
  bool _scopeChanged = false;
  int _sequence = 0;
  late final Object _identity = _identitySnapshot();
  late final Listenable _signals = Listenable.merge([
    widget.workflow.api.identityEpochSignal,
    if (widget.workflow.api.identityState != null)
      widget.workflow.api.identityState!.scopeSignal,
  ]);

  Object _identitySnapshot() => (
    widget.workflow.api.identityEpoch,
    widget.workflow.api.identityState?.generation,
    widget.workflow.api.identityState?.owner?.userId,
    widget.workflow.api.identityState?.owner?.familyId,
  );

  @override
  void initState() {
    super.initState();
    _signals.addListener(_onIdentityChanged);
    unawaited(_load());
  }

  void _onIdentityChanged() {
    if (_identity == _identitySnapshot() || !mounted) return;
    ++_sequence;
    setState(() {
      _items = const [];
      _loading = false;
      _failure = null;
      _scopeChanged = true;
    });
  }

  Future<void> _load() async {
    final sequence = ++_sequence;
    if (widget.workflow.api.identityState != null &&
        widget.workflow.api.identityState?.owner?.familyId == null) {
      setState(() {
        _loading = false;
        _scopeChanged = true;
      });
      return;
    }
    bool current() =>
        mounted &&
        !_scopeChanged &&
        sequence == _sequence &&
        _identity == _identitySnapshot();
    if (!current()) return;
    setState(() {
      _loading = true;
      _failure = null;
    });
    try {
      final items = await widget.workflow.fetchMedicinesForExport(
        includeArchived: true,
        isCurrent: current,
      );
      if (current()) {
        setState(() {
          _items = items
              .where((item) => item.isArchived)
              .toList(growable: false);
          _loading = false;
        });
      }
    } catch (error) {
      if (current()) {
        setState(() {
          _failure = error;
          _loading = false;
        });
      }
    }
  }

  @override
  void dispose() {
    ++_sequence;
    _signals.removeListener(_onIdentityChanged);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('已归档药品')),
    body: _scopeChanged
        ? const Center(child: Text('家庭已变更，请返回药箱重新打开。'))
        : _loading
        ? const Center(child: CircularProgressIndicator())
        : _failure != null
        ? Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(friendlyApiError(_failure!)),
                TextButton(onPressed: _load, child: const Text('重新加载')),
              ],
            ),
          )
        : _items.isEmpty
        ? const Center(child: Text('暂无已归档药品'))
        : ListView(
            padding: const EdgeInsets.all(16),
            children: [
              const Text('此处展示归档摘要，暂不支持恢复到当前药箱。'),
              ..._items.map(
                (item) => Card(
                  child: ExpansionTile(
                    key: ValueKey(item.id),
                    title: Text(item.name),
                    subtitle: Text(item.specificationDisplay),
                    childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                    expandedCrossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (item.manufacturer?.isNotEmpty == true)
                        Text('厂家：${item.manufacturer}'),
                      if (item.approvalNumber?.isNotEmpty == true)
                        Text('批准文号：${item.approvalNumber}'),
                      if (item.leaflet.purposeSummary?.isNotEmpty == true)
                        Text('用途：${item.leaflet.purposeSummary}'),
                      if (item.leaflet.packageUsageSummary?.isNotEmpty == true)
                        Text('用法用量原文：${item.leaflet.packageUsageSummary}'),
                      if (item.batches.isEmpty)
                        const Text('暂无库存批次')
                      else
                        ...item.batches.map(
                          (batch) => Text(
                            '批次：${batch.quantityDisplay} · 有效期 ${batch.expiryDisplay}',
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ],
          ),
  );
}
