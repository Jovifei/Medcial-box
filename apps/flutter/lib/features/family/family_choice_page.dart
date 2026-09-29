import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/widgets/app_surfaces.dart';
import '../../core/theme/app_theme.dart';

class FamilyChoicePage extends StatelessWidget {
  const FamilyChoicePage({super.key});

  Future<void> _showCreate(BuildContext context) async {
    final created = await showAppSheet<bool>(
      context,
      title: '创建演示家庭',
      builder: (context) {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '先用一个轻量表单感受底部面板的操作节奏。',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
            const SizedBox(height: 16),
            const TextField(
              decoration: InputDecoration(
                labelText: '家庭名称',
                hintText: '例如：幸福之家',
              ),
            ),
            const SizedBox(height: 18),
            PrimaryButton(
              label: '创建并进入药箱',
              onPressed: () => Navigator.of(context).pop(true),
            ),
          ],
        );
      },
    );
    if (created == true && context.mounted) context.go('/demo/home');
  }

  Future<void> _showJoin(BuildContext context) async {
    final joined = await showAppSheet<bool>(
      context,
      title: '加入家人的药箱',
      builder: (context) {
        final controller = TextEditingController();
        return StatefulBuilder(
          builder: (context, setState) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '邀请码预览、确认和消耗会在真实版本接入。',
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
                const SizedBox(height: 16),
                TextField(
                  controller: controller,
                  onChanged: (_) => setState(() {}),
                  decoration: const InputDecoration(
                    labelText: '邀请码',
                    hintText: '粘贴家人发来的邀请码',
                  ),
                ),
                const SizedBox(height: 18),
                PrimaryButton(
                  label: '预览家庭',
                  onPressed: controller.text.trim().isEmpty
                      ? null
                      : () => Navigator.of(context).pop(true),
                ),
              ],
            );
          },
        );
      },
    );
    if (joined == true && context.mounted) context.go('/demo/home');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: BackButton(onPressed: () => context.go('/demo/welcome')),
        title: const Text('选择家庭药箱'),
      ),
      body: AppPage(
        padding: const EdgeInsets.fromLTRB(20, 14, 20, 28),
        child: ListView(
          children: [
            const Eyebrow('一步进入'),
            const SizedBox(height: 12),
            Text('先选择你的家庭', style: Theme.of(context).textTheme.headlineMedium),
            const SizedBox(height: 10),
            Text(
              '一个账号首版只加入一个家庭。这里用合成流程演示底部面板和确认动作。',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
            const SizedBox(height: 26),
            choiceTile(
              context,
              icon: Icons.add_home_rounded,
              title: '创建家庭药箱',
              subtitle: '创建后可以邀请家人一起维护',
              onTap: () => _showCreate(context),
            ),
            const SizedBox(height: 14),
            choiceTile(
              context,
              icon: Icons.group_add_rounded,
              title: '加入家人的药箱',
              subtitle: '先预览家庭，再确认使用邀请码',
              onTap: () => _showJoin(context),
              tint: const Color(0xFFF6EAD4),
            ),
            const SizedBox(height: 30),
            AppCard(
              color: AppColors.mist,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(
                    Icons.auto_awesome_rounded,
                    color: AppColors.leafDeep,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      '这是 Flutter 页面原型，当前不访问微信账号或家庭数据。',
                      style: Theme.of(context).textTheme.bodyMedium
                          ?.copyWith(color: AppColors.leafDeep),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
