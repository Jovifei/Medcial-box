import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/widgets/app_surfaces.dart';
import '../../data/api_client.dart';
import '../../data/api_plan_repository.dart';
import '../../data/plan_creation_operations.dart';
import '../../data/plan_form_drafts.dart';
import '../../models/medicine_models.dart';
import '../../models/plan_models.dart';

String _two(int value) => value.toString().padLeft(2, '0');

String _formatDate(DateTime date) =>
    '${date.year.toString().padLeft(4, '0')}-${_two(date.month)}-${_two(date.day)}';

const _dayTokens = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const _dayLabels = ['一', '二', '三', '四', '五', '六', '日'];

/// Same calendar timezone as the server; never use the device's local day.
String planFormShanghaiDate(DateTime now) =>
    _formatDate(now.toUtc().add(const Duration(hours: 8)));

/// 新建 / 编辑用药计划。原提交与可编辑草稿分别管理。
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
  bool _bootstrapping = false;
  int _pageGeneration = 0;
  late int _identityEpoch;
  PlanCreationSession? _creationSession;
  PendingPlanCreation? _pending;
  bool _created = false;
  bool _needsRecovery = false;
  String? _medicineId;
  bool _medicineBindingChanged = false;
  bool _specificWeekdays = false;
  bool _editAllowed = true;
  bool _dirty = false;
  bool _allowPop = false;
  bool _leaving = false;
  bool _choosingMedicine = false;
  bool _conflict = false;
  bool _draftChoice = false;
  Object? _draftFailure;
  PlanFormDraftHandle? _formDraft;

  bool get _canManageSelected =>
      _profiles.any((p) => p.id == _careProfileId && p.canManage);
  bool get _draftOwnerCurrent =>
      _formDraft == null || widget.repository.formDrafts.isCurrent(_formDraft!);

  bool get _identityCurrent =>
      mounted && _identityEpoch == widget.repository.api.identityEpoch;
  bool get _locked => _baseLocked || !_canManageSelected;
  bool get _baseLocked =>
      !_ready ||
      _saving ||
      _pending != null ||
      _created ||
      _needsRecovery ||
      !_identityCurrent ||
      !_editAllowed ||
      _draftChoice ||
      !_draftOwnerCurrent;
  bool _current(int generation) =>
      _identityCurrent && generation == _pageGeneration;
  bool _canDispatch(int generation) =>
      _current(generation) && (ModalRoute.of(context)?.isCurrent ?? true);

  @override
  void dispose() {
    if (_formDraft != null) widget.repository.formDrafts.close(_formDraft!);
    _name.dispose();
    _dosage.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    _identityEpoch = widget.repository.api.identityEpoch;
    _startDate = planFormShanghaiDate(DateTime.now());
    _load = _bootstrap();
  }

  @override
  void didUpdateWidget(covariant PlanFormPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.repository == widget.repository &&
        oldWidget.planId == widget.planId) {
      return;
    }
    if (_formDraft != null) oldWidget.repository.formDrafts.close(_formDraft!);
    _formDraft = null;
    _choosingMedicine = false;
    _leaving = false;
    _version = 1;
    _medicineId = null;
    _medicineBindingChanged = false;
    _specificWeekdays = false;
    _editAllowed = true;
    _dirty = false;
    _allowPop = false;
    _conflict = false;
    _draftChoice = false;
    _draftFailure = null;
    _pageGeneration++;
    _identityEpoch = widget.repository.api.identityEpoch;
    _ready = false;
    _bootstrapping = false;
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
    _startDate = planFormShanghaiDate(DateTime.now());
    _endDate = null;
    _load = _bootstrap();
  }

  void _restorePending(PendingPlanCreation? pending) {
    _pending = pending;
    if (pending == null) return;
    final draft = pending.draft;
    _medicineId = draft.medicineId;
    _specificWeekdays = draft.weekdays.isNotEmpty && draft.weekdays.length < 7;
    _name.text = draft.medicineName;
    _dosage.text = draft.dosageText;
    _timeSlots = List.of(draft.timeSlots);
    _weekdays = draft.weekdays.isEmpty
        ? List.of(_dayTokens)
        : List.of(draft.weekdays);
    _careProfileId = draft.careProfileId;
    _startDate = draft.startDate;
    _endDate = draft.endDate;
  }

  Future<void> _bootstrap() async {
    if (_bootstrapping) return;
    _bootstrapping = true;
    final generation = _pageGeneration;
    final repository = widget.repository;
    try {
      if (_creationSession == null) {
        final session = await repository.creations.open(
          loadPending: !widget.isEdit,
          isCurrent: () => _current(generation),
        );
        if (!_current(generation)) return;
        _creationSession = session;
        if (!widget.isEdit) {
          _needsRecovery = repository.creations.needsRecovery(session);
          _restorePending(repository.creations.pending(session));
        }
      }
      final profiles = await repository.listCareProfiles();
      if (!_current(generation)) return;
      _profiles = profiles;
      if (_careProfileId.isEmpty) {
        final managers = profiles.where((p) => p.canManage);
        if (managers.isNotEmpty) _careProfileId = managers.first.id;
      }
      if (widget.isEdit && !_dirty) {
        final detail = await repository.getPlan(widget.planId!);
        if (!_current(generation) || _dirty) return;
        final plan = detail.plan;
        _editAllowed = detail.canManage && plan.status != 'ended';
        _medicineId = plan.medicineId;
        _medicineBindingChanged = false;
        _name.text = plan.medicineName;
        _dosage.text = plan.dosageText;
        _timeSlots = List<String>.from(plan.timeSlots);
        _weekdays = plan.weekdays.isEmpty
            ? List.of(_dayTokens)
            : List.of(plan.weekdays);
        _specificWeekdays = _weekdays.length < 7;
        _careProfileId = plan.careProfileId;
        _startDate = plan.startDate;
        _endDate = plan.endDate;
        _version = plan.version;
      }
      if (_formDraft == null) {
        final handle = await repository.formDrafts.open(
          _creationSession!,
          planId: widget.planId,
          isCurrent: () => _current(generation),
        );
        if (!_current(generation)) {
          repository.formDrafts.close(handle);
          return;
        }
        _formDraft = handle;
        _draftChoice = handle.saved != null || handle.error != null;
        _draftFailure = handle.error;
      }
      if (_weekdays.isEmpty && !_specificWeekdays) {
        _weekdays = List.of(_dayTokens);
      }
      if (_current(generation)) {
        setState(() {
          _ready = true;
          _failure = null;
        });
      }
    } catch (error) {
      if (_current(generation)) setState(() => _failure = error);
    } finally {
      if (_current(generation)) _bootstrapping = false;
    }
  }

  String? _validate() {
    if (_careProfileId.isEmpty) return '请先选择照护对象';
    if (!_canManageSelected || !_editAllowed) return '你目前没有管理此照护对象的权限';
    if (_name.text.trim().isEmpty) return '请填写药品名称';
    if (_dosage.text.trim().isEmpty) return '请填写剂量说明';
    if (_timeSlots.isEmpty) return '请至少添加一个服药时间';
    if (_timeSlots.length > 6) return '每日最多添加六个时间';
    if (_timeSlots.toSet().length != _timeSlots.length) return '时间点不能重复';
    if (_specificWeekdays && _weekdays.isEmpty) return '请至少选择一天';
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
    if (picked == null || !_canDispatch(generation) || _locked) return;
    final slot = '${_two(picked.hour)}:${_two(picked.minute)}';
    if (_timeSlots.contains(slot)) {
      _message('时间点不能重复');
      return;
    }
    if (_timeSlots.length >= 6) {
      _message('每日最多添加六个时间');
      return;
    }
    _change(() => _timeSlots = [..._timeSlots, slot]..sort());
  }

  Future<void> _pickDate({required bool isStart}) async {
    if (_locked) return;
    final generation = _pageGeneration;
    final initial = DateTime.tryParse(
      isStart ? _startDate : (_endDate ?? _startDate),
    );
    final firstDate = DateTime(2020);
    final lastDate = DateTime(2100);
    final candidate =
        initial ?? DateTime.parse(planFormShanghaiDate(DateTime.now()));
    final initialDate = candidate.isBefore(firstDate)
        ? firstDate
        : (candidate.isAfter(lastDate) ? lastDate : candidate);
    final picked = await showDatePicker(
      context: context,
      initialDate: initialDate,
      firstDate: firstDate,
      lastDate: lastDate,
    );
    if (picked == null || !_canDispatch(generation) || _locked) return;
    _change(() {
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
      if (_current(generation)) {
        if (_formDraft != null) widget.repository.formDrafts.close(_formDraft!);
        _formDraft = null;
        setState(() {
          _needsRecovery = false;
          _ready = false;
          _load = _bootstrap();
        });
      }
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
    if (!_ready ||
        _saving ||
        !_canDispatch(generation) ||
        _draftChoice ||
        !_draftOwnerCurrent ||
        !_editAllowed ||
        _conflict) {
      return;
    }
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
      medicineId: _medicineId,
      medicineBindingChanged: _medicineBindingChanged,
      medicineName: _name.text,
      dosageText: _dosage.text,
      timeSlots: _timeSlots,
      weekdays: _specificWeekdays ? _weekdays : _dayTokens,
      startDate: _startDate,
      endDate: (_endDate == null || _endDate!.isEmpty) ? null : _endDate,
    );
    try {
      // Recheck current grants before dispatch; a stale sheet is not authority.
      final profiles = await widget.repository.listCareProfiles();
      if (!_canDispatch(generation)) return;
      setState(() => _profiles = profiles);
      if (!_canManageSelected) {
        throw const PlanCreationException('你目前没有管理此照护对象的权限');
      }
      if (_pending == null &&
          _medicineId != null &&
          (!widget.isEdit || _medicineBindingChanged)) {
        final medicines = await _readMedicines();
        if (!_canDispatch(generation)) return;
        if (!medicines.any((m) => m.id == _medicineId)) {
          throw const PlanCreationException('关联药品已不在当前药箱，请重新选择或解除关联后再保存。');
        }
      }
      if (widget.isEdit) {
        await widget.repository.updatePlan(
          widget.planId!,
          draft: draft,
          version: _version,
          formDraft: _formDraft,
          isCurrent: () => _canDispatch(generation),
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
            formDraft: _formDraft,
            isCurrent: () => _canDispatch(generation),
          );
        }
      }
      if (!mounted || !_current(generation)) return;
      setState(() {
        _saving = false;
        _created = true;
        _dirty = false;
        _allowPop = true;
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
          if (widget.isEdit &&
              error is ApiException &&
              error.code == 'VERSION_CONFLICT') {
            _conflict = true;
          }
          if (!widget.isEdit && _creationSession != null) {
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
    } finally {
      if (_current(generation) && _saving) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop:
        _allowPop ||
        !_dirty ||
        _saving ||
        _pending != null ||
        !_identityCurrent,
    onPopInvokedWithResult: (didPop, result) {
      if (!didPop) unawaited(_leave());
    },
    child: Scaffold(
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
                          onPressed:
                              _saving || _bootstrapping || !_identityCurrent
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
                if (!_editAllowed ||
                    (!_canManageSelected && _profiles.isNotEmpty))
                  const AppCard(child: Text('你目前没有管理此照护对象的权限，不能保存计划。')),
                if (!_draftOwnerCurrent)
                  const AppCard(child: Text('此表单已在另一页面打开，请返回后重新打开。')),
                if (_draftChoice) _draftChoiceBlock(),
                if (_draftFailure != null && !_draftChoice)
                  AppCard(
                    child: Column(
                      children: [
                        const Text('本机草稿保存失败，输入仍保留在此页。'),
                        TextButton(
                          onPressed: _locked ? null : _persistDraft,
                          child: const Text('重试保存草稿'),
                        ),
                      ],
                    ),
                  ),
                if (_conflict)
                  AppCard(
                    child: Column(
                      children: [
                        const Text('计划已被修改，你的输入和草稿仍保留。请先核对最新版本。'),
                        TextButton(
                          onPressed: _saving ? null : _reviewConflict,
                          child: const Text('核对最新计划'),
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
                  key: const ValueKey('plan-fields'),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      TextField(
                        controller: _name,
                        enabled: !_locked,
                        onChanged: (_) => _change(() {
                          _medicineId = null;
                          _medicineBindingChanged = true;
                        }),
                        decoration: const InputDecoration(
                          labelText: '药品名称',
                          hintText: '例如：儿童退烧药',
                        ),
                      ),
                      Wrap(
                        spacing: 8,
                        children: [
                          TextButton.icon(
                            onPressed: _locked || _choosingMedicine
                                ? null
                                : _pickMedicine,
                            icon: const Icon(Icons.medication_outlined),
                            label: Text(_choosingMedicine ? '读取药箱中…' : '从药箱选择'),
                          ),
                          if (_medicineId != null)
                            TextButton(
                              onPressed: _locked
                                  ? null
                                  : () => _change(() {
                                      _medicineId = null;
                                      _medicineBindingChanged = true;
                                    }),
                              child: const Text('解除药箱关联'),
                            ),
                        ],
                      ),
                      if (_medicineId != null) const Text('已关联药箱记录'),
                      const SizedBox(height: 12),
                      TextField(
                        controller: _dosage,
                        enabled: !_locked,
                        onChanged: (_) => _change(() {}),
                        decoration: const InputDecoration(
                          labelText: '剂量说明',
                          hintText: '例如：一次 5 毫升',
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                _weekdaysBlock(context),
                const SizedBox(height: 14),
                _timeSlotsBlock(context),
                const SizedBox(height: 14),
                _datesBlock(context),
                const SizedBox(height: 18),
                PrimaryButton(
                  label: _saving
                      ? '保存中…'
                      : (_created
                            ? (widget.isEdit ? '计划已更新，返回列表' : '计划已创建，返回列表')
                            : (_pending != null
                                  ? '重试原计划'
                                  : (widget.isEdit ? '保存修改' : '创建计划'))),
                  onPressed:
                      !_ready ||
                          _saving ||
                          _needsRecovery ||
                          !_identityCurrent ||
                          !_canManageSelected ||
                          !_editAllowed ||
                          _draftChoice ||
                          !_draftOwnerCurrent ||
                          _conflict
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
    ),
  );

  void _message(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  void _change(VoidCallback change) {
    if (_locked) return;
    setState(() {
      change();
      _dirty = true;
    });
    unawaited(_persistDraft());
  }

  PlanFormDraftSnapshot get _snapshot => PlanFormDraftSnapshot(
    careProfileId: _careProfileId,
    medicineId: _medicineId,
    medicineBindingChanged: _medicineBindingChanged,
    medicineName: _name.text,
    dosageText: _dosage.text,
    timeSlots: List.of(_timeSlots),
    weekdays: List.of(_weekdays),
    specificWeekdays: _specificWeekdays,
    startDate: _startDate,
    endDate: _endDate,
    version: _version,
  );

  Future<void> _persistDraft() async {
    final handle = _formDraft;
    final generation = _pageGeneration;
    if (handle == null ||
        !_current(generation) ||
        _pending != null ||
        _needsRecovery ||
        _draftChoice ||
        !_draftOwnerCurrent ||
        _created) {
      return;
    }
    try {
      await widget.repository.formDrafts.save(handle, _snapshot);
      if (_current(generation)) setState(() => _draftFailure = null);
    } catch (error) {
      if (_current(generation)) setState(() => _draftFailure = error);
    }
  }

  void _applySnapshot(PlanFormDraftSnapshot saved) {
    _careProfileId = saved.careProfileId;
    _medicineId = saved.medicineId;
    _medicineBindingChanged = saved.medicineBindingChanged;
    _name.text = saved.medicineName;
    _dosage.text = saved.dosageText;
    _timeSlots = List.of(saved.timeSlots);
    _weekdays = List.of(saved.weekdays);
    _specificWeekdays = saved.specificWeekdays;
    _startDate = saved.startDate;
    _endDate = saved.endDate;
    _version = saved.version;
  }

  Widget _draftChoiceBlock() => AppCard(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          _formDraft?.saved == null
              ? '本机草稿无法读取，请重新读取或明确丢弃后继续。'
              : '发现此表单的本机草稿。恢复前请确认仍适用于当前计划。',
        ),
        Wrap(
          spacing: 8,
          children: [
            if (_formDraft?.saved != null)
              TextButton(
                onPressed: _saving ? null : _restoreDraft,
                child: const Text('恢复草稿'),
              ),
            TextButton(
              onPressed: _saving ? null : _discardDraft,
              child: const Text('丢弃草稿'),
            ),
            if (_formDraft?.saved == null)
              TextButton(
                onPressed: _saving ? null : _reloadDraft,
                child: const Text('重读草稿'),
              ),
          ],
        ),
      ],
    ),
  );

  Future<void> _restoreDraft() async {
    final generation = _pageGeneration;
    if (_formDraft == null || !_canDispatch(generation) || _saving) return;
    setState(() => _saving = true);
    try {
      final snapshot = await widget.repository.formDrafts.restore(_formDraft!);
      if (!_canDispatch(generation)) return;
      if (widget.isEdit && snapshot.careProfileId != _careProfileId) {
        throw const PlanFormDraftException('草稿照护对象与当前计划不符，请丢弃此草稿后重新核对。');
      }
      setState(() {
        final latestVersion = _version;
        _applySnapshot(snapshot);
        _conflict = widget.isEdit && snapshot.version != latestVersion;
        _dirty = true;
        _draftChoice = false;
        _draftFailure = null;
      });
    } catch (error) {
      if (_current(generation)) _message(friendlyApiError(error));
    } finally {
      if (_current(generation)) setState(() => _saving = false);
    }
  }

  Future<void> _discardDraft() async {
    final generation = _pageGeneration;
    if (_formDraft == null || !_canDispatch(generation) || _saving) return;
    setState(() => _saving = true);
    try {
      await widget.repository.formDrafts.discard(_formDraft!);
      if (_current(generation)) {
        setState(() {
          _draftChoice = false;
          _draftFailure = null;
        });
      }
    } catch (error) {
      if (_current(generation)) _message(friendlyApiError(error));
    } finally {
      if (_current(generation)) setState(() => _saving = false);
    }
  }

  Future<void> _reloadDraft() async {
    final generation = _pageGeneration;
    if (!_canDispatch(generation) || _saving || _bootstrapping) return;
    if (_formDraft != null) widget.repository.formDrafts.close(_formDraft!);
    _formDraft = null;
    setState(() {
      _ready = false;
      _load = _bootstrap();
    });
  }

  Future<void> _leave() async {
    if (_leaving || !mounted) return;
    _leaving = true;
    final generation = _pageGeneration;
    try {
      final choice = await showDialog<String>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('离开计划表单？'),
          content: const Text('可保留本机草稿，下次明确恢复后继续。草稿不会自动提交。'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('继续编辑'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, 'discard'),
              child: const Text('丢弃并离开'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, 'keep'),
              child: const Text('保留并离开'),
            ),
          ],
        ),
      );
      if (choice == null || !_canDispatch(generation)) return;
      if (choice == 'discard') {
        await widget.repository.formDrafts.discard(_formDraft!);
      } else {
        await _persistDraft();
        if (_draftFailure != null) {
          _message('草稿尚未保存，请重试或继续编辑。');
          return;
        }
      }
      if (!_canDispatch(generation)) return;
      setState(() {
        _dirty = false;
        _allowPop = true;
      });
      // PopScope must rebuild before the explicit pop is accepted.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _canDispatch(generation)) context.pop();
      });
    } catch (error) {
      if (_current(generation)) _message(friendlyApiError(error));
    } finally {
      _leaving = false;
    }
  }

  String get _weekdayLabel => !_specificWeekdays
      ? '每天'
      : '每周${_dayTokens.where(_weekdays.contains).map((d) => _dayLabels[_dayTokens.indexOf(d)]).join('、')}';

  Widget _weekdaysBlock(BuildContext context) => AppCard(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('服药星期', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        OutlinedButton.icon(
          onPressed: _locked ? null : _pickWeekdays,
          icon: const Icon(Icons.calendar_view_week_outlined),
          label: Text(_weekdayLabel),
        ),
      ],
    ),
  );

  Future<void> _pickWeekdays() async {
    if (_locked) return;
    final generation = _pageGeneration;
    var specific = _specificWeekdays;
    var days = List.of(_weekdays);
    String? error;
    final result = await showAppSheet<List<String>>(
      context,
      title: '选择服药星期',
      builder: (context) => StatefulBuilder(
        builder: (context, update) => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Wrap(
              spacing: 8,
              children: [
                ChoiceChip(
                  label: const Text('每天'),
                  selected: !specific,
                  onSelected: (_) => update(() {
                    specific = false;
                    error = null;
                  }),
                ),
                ChoiceChip(
                  label: const Text('指定星期'),
                  selected: specific,
                  onSelected: (_) => update(() => specific = true),
                ),
              ],
            ),
            if (specific)
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (var i = 0; i < _dayTokens.length; i++)
                    FilterChip(
                      label: Text('周${_dayLabels[i]}'),
                      selected: days.contains(_dayTokens[i]),
                      onSelected: (selected) => update(() {
                        days = selected
                            ? [...days, _dayTokens[i]]
                            : days.where((d) => d != _dayTokens[i]).toList();
                        error = null;
                      }),
                    ),
                ],
              ),
            if (error != null)
              Text(
                error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              children: [
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('取消'),
                ),
                FilledButton(
                  onPressed: () {
                    if (specific && days.isEmpty) {
                      update(() => error = '请至少选择一天');
                      return;
                    }
                    Navigator.pop(
                      context,
                      specific
                          ? _dayTokens.where(days.contains).toList()
                          : <String>[],
                    );
                  },
                  child: const Text('应用'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
    if (result == null || !_canDispatch(generation) || _locked) return;
    _change(() {
      _specificWeekdays = result.isNotEmpty;
      _weekdays = result.isEmpty ? List.of(_dayTokens) : result;
    });
  }

  Future<List<MedicineRecord>> _readMedicines() async {
    final result = await widget.repository.api.get('/api/v1/medicines');
    if (result is! Map || result['medicines'] is! List) {
      throw const PlanCreationException('无法读取当前药箱，请稍后重试。');
    }
    return (result['medicines'] as List)
        .whereType<Map<String, dynamic>>()
        .map(MedicineRecord.fromJson)
        .where((m) => m.id.isNotEmpty && m.name.isNotEmpty)
        .toList();
  }

  Future<void> _pickMedicine() async {
    if (_locked || _choosingMedicine) return;
    final generation = _pageGeneration;
    setState(() => _choosingMedicine = true);
    try {
      final medicines = await _readMedicines();
      if (!mounted || !_canDispatch(generation) || _locked) return;
      final chosen = await showAppSheet<MedicineRecord>(
        context,
        title: '选择药箱记录',
        builder: (context) => Column(
          children: [
            if (medicines.isEmpty) const Text('当前药箱没有可选择的药品，可返回手填药名。'),
            for (final medicine in medicines)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: choiceTile(
                  context,
                  icon: Icons.medication_outlined,
                  title: medicine.name,
                  subtitle: [
                    if (medicine.specification?.trim().isNotEmpty == true)
                      medicine.specification!.trim(),
                    if (medicine.manufacturer?.trim().isNotEmpty == true)
                      medicine.manufacturer!.trim(),
                    '记录 ${medicine.id}',
                    '剂量和时间由你填写',
                  ].join(' · '),
                  onTap: () => Navigator.pop(context, medicine),
                ),
              ),
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('取消'),
            ),
          ],
        ),
      );
      if (chosen == null || !_canDispatch(generation) || _locked) return;
      _change(() {
        _medicineId = chosen.id;
        _medicineBindingChanged = true;
        _name.text = chosen.name;
      });
    } catch (error) {
      if (_current(generation)) _message(friendlyApiError(error));
    } finally {
      if (_current(generation)) setState(() => _choosingMedicine = false);
    }
  }

  Future<void> _reviewConflict() async {
    final generation = _pageGeneration;
    if (!_canDispatch(generation) || _saving) return;
    setState(() => _saving = true);
    try {
      final detail = await widget.repository.getPlan(widget.planId!);
      if (!mounted || !_canDispatch(generation)) return;
      if (!detail.canManage || detail.plan.status == 'ended') {
        setState(() => _editAllowed = false);
        _message('当前计划已不能修改，输入仍保留在草稿中。');
        return;
      }
      final latest = detail.plan;
      final choice = await showDialog<String>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('核对最新计划'),
          content: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  '${latest.medicineName}\n${latest.dosageText}\n${latest.scheduleLabel}\n${latest.startDate} 至 ${latest.endDate ?? '长期'}',
                ),
                const SizedBox(height: 12),
                const Text('采用最新内容会替换你的输入；保留输入将在下次明确保存时提交到这个新版本，仍可能再次发生冲突。'),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('取消'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, 'latest'),
              child: const Text('采用最新内容'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, 'keep'),
              child: const Text('已核对，保留输入'),
            ),
          ],
        ),
      );
      if (choice == null || !_canDispatch(generation)) return;
      setState(() {
        if (choice == 'latest') {
          _medicineId = latest.medicineId;
          _medicineBindingChanged = false;
          _name.text = latest.medicineName;
          _dosage.text = latest.dosageText;
          _timeSlots = List.of(latest.timeSlots);
          _weekdays = latest.weekdays.isEmpty
              ? List.of(_dayTokens)
              : List.of(latest.weekdays);
          _specificWeekdays = _weekdays.length < 7;
          _startDate = latest.startDate;
          _endDate = latest.endDate;
        }
        if (!_medicineBindingChanged) _medicineId = latest.medicineId;
        _version = latest.version;
        _conflict = false;
        _dirty = true;
      });
      await _persistDraft();
    } catch (error) {
      if (_current(generation)) _message(friendlyApiError(error));
    } finally {
      if (_current(generation)) setState(() => _saving = false);
    }
  }

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
            onPressed: _baseLocked || widget.isEdit ? null : _pickProfile,
            icon: const Icon(Icons.person_outline_rounded),
            label: Text(
              _pending != null && !_profiles.any((p) => p.id == _careProfileId)
                  ? '原照护对象（未在当前列表中）'
                  : (_careProfileId.isEmpty
                        ? '选择可管理的照护对象'
                        : selected.displayName),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _pickProfile() async {
    if (_baseLocked || widget.isEdit) return;
    final generation = _pageGeneration;
    final chosen = await showAppSheet<String>(
      context,
      title: '选择照护对象',
      builder: (context) => Column(
        children: _profiles
            .where((p) => p.canManage)
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
    if (chosen != null && _canDispatch(generation) && !_baseLocked) {
      setState(() {
        _careProfileId = chosen;
        _dirty = true;
      });
      unawaited(_persistDraft());
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
                        : () => _change(
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
            onPressed: _locked ? null : () => _change(() => _endDate = null),
            child: const Text('清除结束日期，改为长期'),
          ),
        Text('有效期', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            OutlinedButton.icon(
              onPressed: _locked ? null : () => _pickDate(isStart: true),
              icon: const Icon(Icons.event_rounded),
              label: Text('开始：${_startDate.isEmpty ? '未选' : _startDate}'),
            ),
            const SizedBox(height: 10),
            OutlinedButton.icon(
              onPressed: _locked ? null : () => _pickDate(isStart: false),
              icon: const Icon(Icons.event_available_rounded),
              label: Text('结束：${_endDate ?? '长期'}'),
            ),
          ],
        ),
      ],
    ),
  );
}
