import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/widgets/app_surfaces.dart';
import '../../data/api_client.dart';
import '../../data/api_plan_repository.dart';
import '../../data/plan_creation_operations.dart';
import '../../models/plan_models.dart';

String _two(int value) => value.toString().padLeft(2, '0');

String _formatDate(DateTime date) =>
    '${date.year.toString().padLeft(4, '0')}-${_two(date.month)}-${_two(date.day)}';

/// 新建 / 编辑用药计划。
/// 说明：星期（weekdays）沿用后端返回值，编辑时原样保留；创建时留空由后端按每天处理。
/// （星期 token 格式未在本机验证，为避免猜错格式暂不在表单内编辑，见提交说明。）
class PlanFormPage extends StatefulWidget {
  const PlanFormPage({super.key, required this.repository, this.planId});
  final ApiPlanRepository repository;
  final String? planId;

  bool get isEdit => planId != null && planId!.isNotEmpty;

  @override
  State<PlanFormPage> createState() => _PlanFormPageState();
}

class _PlanFormPageState extends State<PlanFormPage> {
  final _name = TextEditingController();
  final _dosage = TextEditingController();
  Future<void>? _load;

  List<CareProfileSummary> _profiles = const [];
  List<String> _timeSlots = <String>[];
  List<String> _weekdays = const [];
  String _careProfileId = '';
  String _startDate = '';
  String? _endDate;
  int _version = 1;
  Object? _failure;
  bool _saving = false;
  bool _ready = false;
  int _pageGeneration = 0;
  late int _identityEpoch;
  PlanCreationSession? _creationSession;
  PendingPlanCreation? _pending;
  bool _created = false;
  bool _needsRecovery = false;

  bool get _identityCurrent =>
      mounted && _identityEpoch == widget.repository.api.identityEpoch;
  bool get _locked =>
      !_ready ||
      _saving ||
      _pending != null ||
      _created ||
      _needsRecovery ||
      !_identityCurrent;
  bool _current(int generation) =>
      _identityCurrent && generation == _pageGeneration;
  bool _canDispatch(int generation) =>
      _current(generation) && (ModalRoute.of(context)?.isCurrent ?? true);

  @override
  void dispose() {
    _name.dispose();
    _dosage.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    _identityEpoch = widget.repository.api.identityEpoch;
    _startDate = _formatDate(DateTime.now());
    _load = _bootstrap();
  }

  @override
  void didUpdateWidget(covariant PlanFormPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.repository == widget.repository &&
        oldWidget.planId == widget.planId) {
      return;
    }
    _pageGeneration++;
    _identityEpoch = widget.repository.api.identityEpoch;
    _ready = false;
    _saving = false;
    _failure = null;
    _creationSession = null;
    _pending = null;
    _created = false;
    _needsRecovery = false;
    _profiles = const [];
    _name.clear();
    _dosage.clear();
    _careProfileId = '';
    _timeSlots = [];
    _weekdays = const [];
    _startDate = _formatDate(DateTime.now());
    _endDate = null;
    _load = _bootstrap();
  }

  void _restorePending(PendingPlanCreation? pending) {
    _pending = pending;
    if (pending == null) return;
    final draft = pending.draft;
    _name.text = draft.medicineName;
    _dosage.text = draft.dosageText;
    _timeSlots = List.of(draft.timeSlots);
    _weekdays = List.of(draft.weekdays);
    _careProfileId = draft.careProfileId;
    _startDate = draft.startDate;
    _endDate = draft.endDate;
  }

  Future<void> _bootstrap() async {
    final generation = _pageGeneration;
    final repository = widget.repository;
    try {
      if (!widget.isEdit) {
        final session = await repository.creations.open(
          isCurrent: () => _current(generation),
        );
        if (!_current(generation)) return;
        _creationSession = session;
        _needsRecovery = repository.creations.needsRecovery(session);
        _restorePending(repository.creations.pending(session));
      }
      final profiles = await repository.listCareProfiles();
      if (!_current(generation)) return;
      _profiles = profiles;
      if (_careProfileId.isEmpty && profiles.isNotEmpty) {
        _careProfileId = profiles.first.id;
      }
      if (widget.isEdit) {
        final detail = await repository.getPlan(widget.planId!);
        if (!_current(generation)) return;
        final plan = detail.plan;
        _name.text = plan.medicineName;
        _dosage.text = plan.dosageText;
        _timeSlots = List<String>.from(plan.timeSlots);
        _weekdays = plan.weekdays;
        _careProfileId = plan.careProfileId;
        _startDate = plan.startDate;
        _endDate = plan.endDate;
        _version = plan.version;
      }
      if (_current(generation)) {
        setState(() {
          _ready = true;
          _failure = null;
        });
      }
    } catch (error) {
      if (_current(generation)) setState(() => _failure = error);
    }
  }

  String? _validate() {
    if (_careProfileId.isEmpty) return '请先选择照护对象';
    if (_name.text.trim().isEmpty) return '请填写药品名称';
    if (_dosage.text.trim().isEmpty) return '请填写剂量说明';
    if (_timeSlots.isEmpty) return '请至少添加一个服药时间';
    if (_startDate.isEmpty) return '请选择开始日期';
    if (_endDate != null &&
        _endDate!.isNotEmpty &&
        _endDate!.compareTo(_startDate) < 0) {
      return '结束日期不能早于开始日期';
    }
    return null;
  }

  Future<void> _addTimeSlot() async {
    if (_locked) return;
    final generation = _pageGeneration;
    final picked = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.now(),
    );
    if (picked == null || !_current(generation) || _locked) return;
    setState(() {
      _timeSlots = [
        ..._timeSlots,
        '${_two(picked.hour)}:${_two(picked.minute)}',
      ]..sort();
    });
  }

  Future<void> _pickDate({required bool isStart}) async {
    if (_locked) return;
    final generation = _pageGeneration;
    final initial = DateTime.tryParse(
      isStart ? _startDate : (_endDate ?? _startDate),
    );
    final picked = await showDatePicker(
      context: context,
      initialDate: initial ?? DateTime.now(),
      firstDate: DateTime(2020),
      lastDate: DateTime(2100),
    );
    if (picked == null || !_current(generation) || _locked) return;
    setState(() {
      if (isStart) {
        _startDate = _formatDate(picked);
      } else {
        _endDate = _formatDate(picked);
      }
    });
  }

  Future<void> _recoverOriginal() async {
    final generation = _pageGeneration;
    if (!_canDispatch(generation) || _saving || _creationSession == null) {
      return;
    }
    setState(() => _saving = true);
    try {
      final inspection = await widget.repository.creations.inspectRecovery(
        _creationSession!,
        isCurrent: () => _canDispatch(generation),
      );
      if (!mounted || !_canDispatch(generation)) return;
      final inspected = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('核对已有计划'),
          content: SizedBox(
            width: 360,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('这是当前可查看的计划。列表不能证明上次请求未保存或不会稍后完成。'),
                  if (inspection.plans.isEmpty) const Text('当前列表没有计划'),
                  ...inspection.plans.map(
                    (plan) =>
                        Text('${plan.medicineName} · ${plan.statusLabel}'),
                  ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('已核对，继续'),
            ),
          ],
        ),
      );
      if (inspected != true || !mounted || !_canDispatch(generation)) return;
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('开始一份新计划？'),
          content: const Text(
            '上次请求可能已经保存，也可能稍后完成。继续将放弃原请求的重试关联，开始一份新计划，可能造成重复。如不确定，请取消。',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('确认开始新计划'),
            ),
          ],
        ),
      );
      if (confirmed != true || !mounted || !_canDispatch(generation)) return;
      await widget.repository.creations.abandonAfterInspection(
        inspection,
        isCurrent: () => _canDispatch(generation),
      );
      if (_current(generation)) setState(() => _needsRecovery = false);
    } catch (error) {
      if (mounted && _canDispatch(generation)) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              error is PlanCreationException
                  ? error.message
                  : friendlyApiError(error),
            ),
          ),
        );
      }
    } finally {
      if (_current(generation)) setState(() => _saving = false);
    }
  }

  Future<void> _submit() async {
    final generation = _pageGeneration;
    if (!_ready || _saving || !_canDispatch(generation)) return;
    if (_created) {
      context.pop();
      return;
    }
    if (_needsRecovery) return;
    final invalid = _pending == null ? _validate() : null;
    if (invalid != null) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(invalid)));
      return;
    }
    setState(() => _saving = true);
    final draft = MedicationPlanDraft(
      careProfileId: _careProfileId,
      medicineName: _name.text,
      dosageText: _dosage.text,
      timeSlots: _timeSlots,
      weekdays: _weekdays,
      startDate: _startDate,
      endDate: (_endDate == null || _endDate!.isEmpty) ? null : _endDate,
    );
    try {
      if (widget.isEdit) {
        await widget.repository.updatePlan(
          widget.planId!,
          draft: draft,
          version: _version,
        );
      } else {
        final session = _creationSession!;
        if (_pending != null) {
          await widget.repository.retryPlanCreation(
            session,
            isCurrent: () => _canDispatch(generation),
          );
        } else {
          await widget.repository.createPlan(
            draft,
            session: session,
            isCurrent: () => _canDispatch(generation),
          );
        }
      }
      if (!mounted || !_current(generation)) return;
      setState(() {
        _saving = false;
        _created = !widget.isEdit;
      });
      if (!_canDispatch(generation)) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(widget.isEdit ? '计划已更新' : '计划已创建')),
      );
      context.pop();
    } catch (error) {
      if (mounted && _current(generation)) {
        setState(() {
          _saving = false;
          if (_creationSession != null) {
            _restorePending(
              widget.repository.creations.pending(_creationSession!),
            );
          }
        });
        if (!_canDispatch(generation)) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              error is PlanCreationException
                  ? error.message
                  : friendlyApiError(error),
            ),
          ),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(widget.isEdit ? '编辑计划' : '新建计划')),
    body: FutureBuilder<void>(
      future: _load,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done &&
            _profiles.isEmpty) {
          return const Center(child: CircularProgressIndicator());
        }
        return AppPage(
          child: ListView(
            children: [
              if (_failure != null)
                AppCard(
                  color: const Color(0xFFFFF2ED),
                  child: Column(
                    children: [
                      Text(
                        _failure is PlanCreationException
                            ? (_failure! as PlanCreationException).message
                            : friendlyApiError(_failure!),
                      ),
                      TextButton(
                        onPressed: _saving || !_identityCurrent
                            ? null
                            : () {
                                setState(() {
                                  _load = _bootstrap();
                                });
                              },
                        child: const Text('重新读取'),
                      ),
                    ],
                  ),
                ),
              if (_needsRecovery)
                AppCard(
                  child: Column(
                    children: [
                      const Text(
                        '上次创建结果尚未确定，原计划内容已在退出或家庭清理时移除。请先查看已有计划；不能直接重试或创建新计划。',
                      ),
                      TextButton(
                        onPressed: _saving ? null : _recoverOriginal,
                        child: const Text('查看已有计划'),
                      ),
                    ],
                  ),
                ),
              if (_pending != null)
                const AppCard(
                  child: Text('上次创建结果尚未确定。已保留原计划，请明确重试核对结果；核对前不能创建另一份计划。'),
                ),
              _profilesBlock(context),
              const SizedBox(height: 14),
              AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    TextField(
                      controller: _name,
                      enabled: !_locked,
                      decoration: const InputDecoration(
                        labelText: '药品名称',
                        hintText: '例如：儿童退烧药',
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _dosage,
                      enabled: !_locked,
                      decoration: const InputDecoration(
                        labelText: '剂量说明',
                        hintText: '例如：一次 5 毫升',
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 14),
              _timeSlotsBlock(context),
              const SizedBox(height: 14),
              _datesBlock(context),
              const SizedBox(height: 18),
              PrimaryButton(
                label: _saving
                    ? '保存中…'
                    : (_created
                          ? '计划已创建，返回列表'
                          : (_pending != null
                                ? '重试原计划'
                                : (widget.isEdit ? '保存修改' : '创建计划'))),
                onPressed:
                    !_ready || _saving || _needsRecovery || !_identityCurrent
                    ? null
                    : _submit,
              ),
              const SizedBox(height: 8),
              const Text(
                '剂量与时间仅供家庭记录，不构成用药建议。',
                style: TextStyle(fontSize: 13),
              ),
            ],
          ),
        );
      },
    ),
  );

  Widget _profilesBlock(BuildContext context) {
    if (_profiles.isEmpty) {
      return AppCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('还没有照护对象，先创建一位再安排用药计划。'),
            const SizedBox(height: 10),
            SoftButton(
              label: '前往照护对象',
              icon: Icons.people_outline_rounded,
              onPressed: () => context.push('/care-profiles'),
            ),
          ],
        ),
      );
    }
    CareProfileSummary selected = _profiles.first;
    for (final profile in _profiles) {
      if (profile.id == _careProfileId) {
        selected = profile;
        break;
      }
    }
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('照护对象', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: _locked ? null : _pickProfile,
            icon: const Icon(Icons.person_outline_rounded),
            label: Text(
              _pending != null && !_profiles.any((p) => p.id == _careProfileId)
                  ? '原照护对象（未在当前列表中）'
                  : selected.displayName,
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _pickProfile() async {
    if (_locked) return;
    final generation = _pageGeneration;
    final chosen = await showAppSheet<String>(
      context,
      title: '选择照护对象',
      builder: (context) => Column(
        children: _profiles
            .map(
              (profile) => Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: choiceTile(
                  context,
                  icon: Icons.medical_information_outlined,
                  title: profile.displayName,
                  subtitle: profile.isSelf
                      ? '本人档案'
                      : (profile.isPrivate ? '仅你可见' : '家庭共享'),
                  onTap: () => Navigator.pop(context, profile.id),
                ),
              ),
            )
            .toList(growable: false),
      ),
    );
    if (chosen != null && _current(generation) && !_locked) {
      setState(() => _careProfileId = chosen);
    }
  }

  Widget _timeSlotsBlock(BuildContext context) => AppCard(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                '服药时间',
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            TextButton.icon(
              onPressed: _locked ? null : _addTimeSlot,
              icon: const Icon(Icons.add_rounded),
              label: const Text('添加'),
            ),
          ],
        ),
        const SizedBox(height: 8),
        if (_timeSlots.isEmpty)
          const Text('还没有添加时间。')
        else
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: _timeSlots
                .map(
                  (slot) => InputChip(
                    label: Text(slot),
                    onDeleted: _locked
                        ? null
                        : () => setState(
                            () => _timeSlots = _timeSlots
                                .where((item) => item != slot)
                                .toList(),
                          ),
                  ),
                )
                .toList(growable: false),
          ),
      ],
    ),
  );

  Widget _datesBlock(BuildContext context) => AppCard(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_endDate != null)
          TextButton(
            onPressed: _locked ? null : () => setState(() => _endDate = null),
            child: const Text('清除结束日期，改为长期'),
          ),
        Text('有效期', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: OutlinedButton.icon(
                onPressed: _locked ? null : () => _pickDate(isStart: true),
                icon: const Icon(Icons.event_rounded),
                label: Text('开始：${_startDate.isEmpty ? '未选' : _startDate}'),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: OutlinedButton.icon(
                onPressed: _locked ? null : () => _pickDate(isStart: false),
                icon: const Icon(Icons.event_available_rounded),
                label: Text('结束：${_endDate ?? '长期'}'),
              ),
            ),
          ],
        ),
      ],
    ),
  );
}
