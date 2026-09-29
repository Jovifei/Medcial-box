import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/widgets/app_surfaces.dart';
import '../../data/api_auth_repository.dart';
import '../../data/api_client.dart';

class FamilyChoiceApiPage extends StatelessWidget {
  const FamilyChoiceApiPage({super.key, required this.repository});
  final ApiFamilyRepository repository;

  Future<void> _create(BuildContext context) async {
    final name = await showAppSheet<String>(
      context,
      title: '创建家庭药箱',
      builder: (_) => const _CreateFamilyForm(),
    );
    if (name == null || !context.mounted) return;
    try {
      await repository.createFamily(name);
      if (context.mounted) context.go('/home');
    } catch (error) {
      if (context.mounted) _showError(context, error);
    }
  }

  Future<void> _join(BuildContext context) async {
    final code = await showAppSheet<String>(
      context,
      title: '加入家人的药箱',
      builder: (_) => const _JoinFamilyForm(),
    );
    if (code == null || !context.mounted) return;
    try {
      final preview = await repository.previewInvitation(code);
      if (!context.mounted) return;
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('确认加入家庭？'),
          content: Text('你将加入“${preview.familyName}”，与家庭成员共同维护库存。邀请码确认后会被使用一次。'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('确认加入'),
            ),
          ],
        ),
      );
      if (confirmed != true || !context.mounted) return;
      await repository.acceptInvitation(code);
      if (context.mounted) context.go('/home');
    } catch (error) {
      if (context.mounted) _showError(context, error);
    }
  }

  static void _showError(BuildContext context, Object error) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(friendlyApiError(error))),
    );
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('家庭药箱')),
    body: AppPage(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: ListView(
            children: [
              const SizedBox(height: 24),
              Text('先选择你的家庭', style: Theme.of(context).textTheme.headlineMedium),
              const SizedBox(height: 8),
              const Text('家庭成员共享药品库存。加入前会先显示家庭名称供你核对。'),
              const SizedBox(height: 24),
              choiceTile(
                context,
                icon: Icons.add_home_rounded,
                title: '创建家庭药箱',
                subtitle: '你将成为管理员，可以邀请家人',
                onTap: () => _create(context),
              ),
              const SizedBox(height: 14),
              choiceTile(
                context,
                icon: Icons.group_add_rounded,
                title: '加入家人的药箱',
                subtitle: '粘贴一次性邀请码，确认后加入',
                tint: const Color(0xFFF6EAD4),
                onTap: () => _join(context),
              ),
              const SizedBox(height: 18),
              const AppCard(
                color: Color(0xFFE9F1EB),
                child: Text('药箱只记录家庭库存与资料，不在 App 内提供问诊或选药建议。'),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

class _CreateFamilyForm extends StatefulWidget {
  const _CreateFamilyForm();

  @override
  State<_CreateFamilyForm> createState() => _CreateFamilyFormState();
}

class _CreateFamilyFormState extends State<_CreateFamilyForm> {
  final controller = TextEditingController(text: '家庭药箱');

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Column(
    children: [
      TextField(
        controller: controller,
        maxLength: 40,
        textInputAction: TextInputAction.done,
        decoration: const InputDecoration(labelText: '家庭名称'),
      ),
      const SizedBox(height: 8),
      PrimaryButton(
        label: '创建并进入药箱',
        onPressed: () {
          final name = controller.text.trim();
          if (name.isNotEmpty) Navigator.pop(context, name);
        },
      ),
    ],
  );
}

class _JoinFamilyForm extends StatefulWidget {
  const _JoinFamilyForm();

  @override
  State<_JoinFamilyForm> createState() => _JoinFamilyFormState();
}

class _JoinFamilyFormState extends State<_JoinFamilyForm> {
  final controller = TextEditingController();

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Column(
    children: [
      TextField(
        controller: controller,
        autofocus: true,
        textCapitalization: TextCapitalization.characters,
        decoration: const InputDecoration(labelText: '邀请码', hintText: '粘贴家人发来的邀请码'),
      ),
      const SizedBox(height: 8),
      PrimaryButton(
        label: '预览家庭',
        onPressed: () {
          final code = controller.text.trim();
          if (code.isNotEmpty) Navigator.pop(context, code);
        },
      ),
    ],
  );
}
