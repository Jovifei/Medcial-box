import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_surfaces.dart';
import '../../data/api_auth_repository.dart';
import '../../data/api_client.dart';
import '../../data/api_plan_repository.dart';
import '../../models/plan_models.dart';

/// 照护对象管理：列出档案、创建本人档案或新的照护对象，并进入各自权限页。
class CareProfilesPage extends StatefulWidget {
  const CareProfilesPage({
    super.key,
    required this.repository,
    required this.families,
  });
  final ApiPlanRepository repository;
  final ApiFamilyRepository families;

  @override
  State<CareProfilesPage> createState() => _CareProfilesPageState();
}

class _CareProfilesPageState extends State<CareProfilesPage> {
  Future<void>? _load;
  List<CareProfileSummary> _profiles = const [];
  Object? _failure;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load = _reload();
  }

  Future<void> _reload() async {
    try {
      final profiles = await widget.repository.listCareProfiles();
      if (!mounted) return;
      setState(() {
        _profiles = profiles;
        _failure = null;
      });
    } catch (error) {
      if (mounted) setState(() => _failure = error);
    }
  }

  Future<void> _ensureSelf() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await widget.repository.ensureSelfCareProfile();
      await _reload();
    } catch (error) {
      if (mounted) _toast(friendlyApiError(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<String?> _promptName({String? initial}) async {
    final controller = TextEditingController(text: initial ?? '');
    final name = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('照护对象称呼'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(hintText: '例如：奶奶'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, controller.text.trim()),
            child: const Text('保存'),
          ),
        ],
      ),
    );
    controller.dispose();
    return name;
  }

  Future<void> _createProfile() async {
    final displayName = await _promptName();
    if (displayName == null || displayName.isEmpty || !mounted) return;
    setState(() => _busy = true);
    try {
      await widget.repository.createCareProfile(displayName: displayName);
      await _reload();
    } catch (error) {
      if (mounted) _toast(friendlyApiError(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _toast(String message) => ScaffoldMessenger.of(
    context,
  ).showSnackBar(SnackBar(content: Text(message)));

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('照护对象与权限')),
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
              if (_failure != null && _profiles.isEmpty)
                AppCard(
                  color: const Color(0xFFFFF2ED),
                  child: Text(friendlyApiError(_failure!)),
                ),
              AppCard(
                color: AppColors.mist,
                child: const Text(
                  '照护对象是“被照顾的人”的档案。权限决定哪位家庭成员可以查看或管理其计划与服药记录。',
                ),
              ),
              const SizedBox(height: 12),
              ..._profiles.map(_profileCard),
              const SizedBox(height: 14),
              SoftButton(
                label: '创建我的本人档案',
                icon: Icons.person_add_alt_1_rounded,
                onPressed: _busy ? null : _ensureSelf,
              ),
              const SizedBox(height: 10),
              PrimaryButton(
                label: '新建照护对象',
                icon: Icons.add_rounded,
                onPressed: _busy ? null : _createProfile,
              ),
            ],
          ),
        );
      },
    ),
  );

  Widget _profileCard(CareProfileSummary profile) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: AppCard(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      child: ListTile(
        contentPadding: EdgeInsets.zero,
        leading: Icon(
          profile.isSelf
              ? Icons.person_rounded
              : Icons.medical_information_outlined,
          color: AppColors.leaf,
        ),
        title: Text(
          profile.displayName,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        subtitle: Text(
          profile.isSelf
              ? '本人档案'
              : (profile.isPrivate ? '仅你可见' : '家庭共享'),
        ),
        trailing: const Icon(
          Icons.chevron_right_rounded,
          color: AppColors.muted,
        ),
        onTap: () => context.push('/care-profiles/${profile.id}/permissions'),
      ),
    ),
  );
}
