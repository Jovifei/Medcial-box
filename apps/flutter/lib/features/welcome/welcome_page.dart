import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/widgets/app_surfaces.dart';
import '../../core/theme/app_theme.dart';

class WelcomePage extends StatelessWidget {
  const WelcomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: AppPage(
        padding: const EdgeInsets.fromLTRB(24, 42, 24, 28),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Eyebrow('Flutter 交互原型'),
            const Spacer(),
            Container(
              width: 74,
              height: 74,
              decoration: BoxDecoration(
                color: AppColors.leaf,
                borderRadius: BorderRadius.circular(24),
              ),
              child: const Icon(
                Icons.medication_liquid_rounded,
                color: Colors.white,
                size: 40,
              ),
            ),
            const SizedBox(height: 26),
            Text(
              '把家里的药，\n记在一起。',
              style: Theme.of(context).textTheme.headlineLarge,
            ),
            const SizedBox(height: 16),
            Text(
              '一个轻盈的家庭药箱体验原型。先看交互，再决定哪些体验同步到微信小程序。',
              style: Theme.of(context).textTheme.bodyLarge
                  ?.copyWith(color: AppColors.muted),
            ),
            const SizedBox(height: 24),
            const StatusPill(
              label: '演示数据 · 不连接真实账号',
              color: AppColors.leafDeep,
              background: AppColors.mist,
            ),
            const Spacer(),
            PrimaryButton(
              label: '开始体验',
              icon: Icons.arrow_forward_rounded,
              onPressed: () => context.go('/demo/family-choice'),
            ),
            const SizedBox(height: 12),
            Center(
              child: Text(
                '当前版本专注页面跳转、选择面板和弹窗动效',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
