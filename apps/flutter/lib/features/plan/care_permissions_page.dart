import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_surfaces.dart';
import '../../data/api_auth_repository.dart';
import '../../data/api_client.dart';
import '../../data/api_plan_repository.dart';
import '../../models/medicine_models.dart';
import '../../models/plan_models.dart';

/// 单个照护对象的查看/管理权限（与照护权限解耦于服药提醒接收资格）。
class CarePermissionsPage extends StatefulWidget {
  const CarePermissionsPage({
    super.key,
    required this.repository,
    required this.families,
    required this.careProfileId,
  });
  final ApiPlanRepository repository;
  final ApiFamilyRepository families;
  final String careProfileId;

  @override
  State<CarePermissionsPage> createState() => _CarePermissionsPageState();
}

class _CarePermissionsPageState extends State<CarePermissionsPage> {
  Future<void>? _load;
  CareGrantList? _grants;
  List<FamilyMemberRecord> _members = const [];
  Object? _failure;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load = _reload();
  }

  Future<void> _reload() async {
    try {
      final grants = await widget.repository.listCareGrants(
        widget.careProfileId,
      );
      final family = await widget.families.getCurrentFamily();
      if (!mounted) return;
      setState(() {
        _grants = grants;
        _members = family.members;
        _failure = null;
      });
    } catch (error) {
      if (mounted) setState(() => _failure = error);
    }
  }

  Future<void> _transfer(CareGrant grant) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('交接照护管理'),
        content: Text('将管理责任交给${grant.displayName}，交接后你可以退出家庭。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('确认交接'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _busy = true);
    try {
      await widget.repository.transferCareManagement(
        widget.careProfileId,
        grant.memberUserId,
      );
      await _reload();
    } catch (error) {
      if (mounted) _toast(friendlyApiError(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _setReceive(CareGrant grant, bool value) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await widget.repository.createCareGrant(
        widget.careProfileId,
        memberUserId: grant.memberUserId,
        canManage: grant.canManage,
        receiveDoseReminders: value,
      );
      await _reload();
    } catch (error) {
      if (mounted) _toast(friendlyApiError(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _setManage(CareGrant grant, bool canManage) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await widget.repository.createCareGrant(
        widget.careProfileId,
        memberUserId: grant.memberUserId,
        canManage: canManage,
        receiveDoseReminders: grant.receiveDoseReminders,
      );
      await _reload();
    } catch (error) {
      if (mounted) _toast(friendlyApiError(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _revoke(CareGrant grant) async {
    if (_busy) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('撤销权限'),
        content: Text('撤销后，“${grant.displayName}”将不再能查看或管理该照护对象的计划。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('撤销'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _busy = true);
    try {
      await widget.repository.revokeCareGrant(
        widget.careProfileId,
        grant.memberUserId,
      );
      await _reload();
    } catch (error) {
      if (mounted) _toast(friendlyApiError(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _addGrant() async {
    final granted =
        _grants?.grants.map((grant) => grant.memberUserId).toSet() ??
        <String>{};
    final candidates = _members
        .where((member) => !granted.contains(member.id))
        .toList(growable: false);
    if (candidates.isEmpty) {
      _toast('没有可添加的家庭成员。');
      return;
    }
    final chosen = await showAppSheet<String>(
      context,
      title: '选择家庭成员',
      builder: (context) => Column(
        children: candidates
            .map(
              (member) => Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: choiceTile(
                  context,
                  icon: Icons.person_outline_rounded,
                  title: member.displayName,
                  subtitle: member.isSelf
                      ? '我'
                      : (member.role == 'owner' ? '管理员' : '成员'),
                  onTap: () => Navigator.pop(context, member.id),
                ),
              ),
            )
            .toList(growable: false),
      ),
    );
    if (chosen == null || !mounted) return;
    setState(() => _busy = true);
    try {
      await widget.repository.createCareGrant(
        widget.careProfileId,
        memberUserId: chosen,
        canManage: false,
      );
      await _reload();
    } catch (error) {
      if (mounted) _toast(friendlyApiError(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _toast(String message) =>
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(message)));

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text('${_grants?.displayName ?? '照护对象'} · 权限')),
    body: FutureBuilder<void>(
      future: _load,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done &&
            _grants == null) {
          return const Center(child: CircularProgressIndicator());
        }
        final grants = _grants?.grants ?? const <CareGrant>[];
        return AppPage(
          child: ListView(
            children: [
              if (_failure != null && _grants == null)
                AppCard(
                  color: const Color(0xFFFFF2ED),
                  child: Text(friendlyApiError(_failure!)),
                ),
              AppCard(
                color: AppColors.mist,
                child: const Text(
                  '“仅查看”可看到计划与服药记录；“可查看与管理”可修改计划、确认服药。仅档案创建者或管理员可在此调整权限。',
                ),
              ),
              const SizedBox(height: 12),
              if (grants.isEmpty)
                const AppCard(child: Text('还没有为其他成员开放该照护对象的权限。'))
              else
                ...grants.map(_grantCard),
              const SizedBox(height: 14),
              PrimaryButton(
                label: '添加成员权限',
                icon: Icons.person_add_alt_1_rounded,
                onPressed: _busy ? null : _addGrant,
              ),
            ],
          ),
        );
      },
    ),
  );

  Widget _grantCard(CareGrant grant) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: AppCard(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: Column(
        children: [
          SwitchListTile.adaptive(
            contentPadding: EdgeInsets.zero,
            title: Text(
              grant.displayName,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            subtitle: Text(grant.levelLabel),
            value: grant.canManage,
            onChanged: _busy ? null : (value) => _setManage(grant, value),
          ),
          SwitchListTile.adaptive(
            title: const Text('接收此人的服药提醒'),
            subtitle: const Text('与查看和管理权限分开设置'),
            value: grant.receiveDoseReminders,
            onChanged: _busy ? null : (value) => _setReceive(grant, value),
          ),
          if (grant.canManage)
            TextButton(
              onPressed: _busy ? null : () => _transfer(grant),
              child: const Text('交接管理责任给此成员'),
            ),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: _busy ? null : () => _revoke(grant),
              icon: const Icon(Icons.link_off_rounded, size: 18),
              label: const Text('撤销权限'),
            ),
          ),
        ],
      ),
    ),
  );
}
