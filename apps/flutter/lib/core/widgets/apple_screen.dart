import 'package:flutter/cupertino.dart';

import '../theme/app_typography.dart';

/// 苹果风屏幕骨架：导航栏（半透明玻璃层）+ 安全区内容。
/// 新屏幕与 Stage C 改造后的屏幕统一使用；禁止再新建 Scaffold+AppBar 组合。
/// [safeAreaBottom] 置 false 用于嵌在底部玻璃 TabBar 之上的页面：
/// 内容允许滚动到栏下呈现真实模糊，由页面自行给列表加底部内边距。
class AppleScreen extends StatelessWidget {
  const AppleScreen({
    required this.title,
    required this.child,
    this.trailing,
    this.backgroundColor,
    this.safeAreaBottom = true,
    super.key,
  });

  final String title;
  final Widget child;
  final Widget? trailing;
  final Color? backgroundColor;
  final bool safeAreaBottom;

  @override
  Widget build(BuildContext context) {
    return CupertinoPageScaffold(
      backgroundColor: backgroundColor,
      navigationBar: CupertinoNavigationBar(
        middle: Text(title, style: AppType.headline),
        trailing: trailing,
      ),
      child: SafeArea(bottom: safeAreaBottom, child: child),
    );
  }
}
