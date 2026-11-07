import 'package:flutter/cupertino.dart';

import '../theme/app_typography.dart';

/// 苹果风屏幕骨架：导航栏（半透明玻璃层）+ 安全区内容。
/// 新屏幕与 Stage C 改造后的屏幕统一使用；禁止再新建 Scaffold+AppBar 组合。
class AppleScreen extends StatelessWidget {
  const AppleScreen({
    required this.title,
    required this.child,
    this.trailing,
    this.backgroundColor,
    super.key,
  });

  final String title;
  final Widget child;
  final Widget? trailing;
  final Color? backgroundColor;

  @override
  Widget build(BuildContext context) {
    return CupertinoPageScaffold(
      backgroundColor: backgroundColor,
      navigationBar: CupertinoNavigationBar(
        middle: Text(title, style: AppType.headline),
        trailing: trailing,
      ),
      child: SafeArea(child: child),
    );
  }
}
