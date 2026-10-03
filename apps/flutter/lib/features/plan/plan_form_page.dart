import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/widgets/app_surfaces.dart';
import '../../data/api_client.dart';
import '../../data/api_plan_repository.dart';
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

  @override
  void dispose() {
    _name.dispose();
    _dosage.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    _startDate = _formatDate(DateTime.now());
    _load = _bootstrap();
  }

  Future<void> _bootstrap() async {
    try {
      final profiles = await widget.repository.listCareProfiles();
      if (!mounted) return;
      setState(() {
        _profiles = profiles;
        if (_careProfileId.isEmpty && profiles.isNotEmpty) {
          _careProfileId = profiles.first.id;
        }
      });
      if (widget.isEdit) {
        final detail = await widget.repository.getPlan(widget.planId!);
        if (!mounted) return;
        final plan = detail.plan;
        setState(() {
          _name.text = plan.medicineName;
          _dosage.text = plan.dosageText;
          _timeSlots = List<String>.from(plan.timeSlots);
          _weekdays = plan.weekdays;
          _careProfileId = plan.careProfileId;
          _startDate = plan.startDate;
          _endDate = plan.endDate;
          _version = plan.version;
        });
      }
    } catch (error) {
      if (mounted) setState(() => _failure = error);
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
    final picked = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.now(),
    );
    if (picked == null) return;
    setState(() {
      _timeSlots = [
        ..._timeSlots,
        '${_two(picked.hour)}:${_two(picked.minute)}',
      ]..sort();
    });
  }

  Future<void> _pickDate({required bool isStart}) async {
    final initial = DateTime.tryParse(
      isStart ? _startDate : (_endDate ?? _startDate),
    );
    final picked = await showDatePicker(
      context: context,
      initialDate: initial ?? DateTime.now(),
      firstDate: DateTime(2020),
      lastDate: DateTime(2100),
    );
    if (picked == null) return;
    setState(() {
      if (isStart) {
        _startDate = _formatDate(picked);
      } else {
        _endDate = _formatDate(picked);
      }
    });
  }

  Future<void> _submit() async {
    if (_saving) return;
    final invalid = _validate();
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
        await widget.repository.createPlan(draft);
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(widget.isEdit ? '计划已更新' : '计划已创建')),
      );
      context.pop();
    } catch (error) {
      if (mounted) {
        setState(() => _saving = false);
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(friendlyApiError(error))));
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
                  child: Text(friendlyApiError(_failure!)),
                ),
              _profilesBlock(context),
              const SizedBox(height: 14),
              AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    TextField(
                      controller: _name,
                      decoration: const InputDecoration(
                        labelText: '药品名称',
                        hintText: '例如：儿童退烧药',
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _dosage,
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
                label: _saving ? '保存中…' : (widget.isEdit ? '保存修改' : '创建计划'),
                onPressed: _saving ? null : _submit,
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
            onPressed: _pickProfile,
            icon: const Icon(Icons.person_outline_rounded),
            label: Text(selected.displayName),
          ),
        ],
      ),
    );
  }

  Future<void> _pickProfile() async {
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
    if (chosen != null && mounted) setState(() => _careProfileId = chosen);
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
              onPressed: _addTimeSlot,
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
                    onDeleted: () => setState(
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
            onPressed: () => setState(() => _endDate = null),
            child: const Text('清除结束日期，改为长期'),
          ),
        Text('有效期', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: OutlinedButton.icon(
                onPressed: () => _pickDate(isStart: true),
                icon: const Icon(Icons.event_rounded),
                label: Text('开始：${_startDate.isEmpty ? '未选' : _startDate}'),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: OutlinedButton.icon(
                onPressed: () => _pickDate(isStart: false),
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
