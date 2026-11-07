import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// 苹果风屏幕骨架：导航栏（半透明玻璃层）+ 安全区内容。
/// 新屏幕与 Stage C 改造后的屏幕统一使用；禁止再新建 Scaffold+AppBar 组合。
/// [safeAreaBottom] 置 false 用于嵌在底部玻璃 TabBar 之上的页面：
/// 内容允许滚动到栏下呈现真实模糊，由页面自行给列表加底部内边距。
class AppleScreen extends StatelessWidget {
  const AppleScreen({
    required this.title,
    required this.child,
    this.trailing,
    this.leading,
    this.backgroundColor,
    this.safeAreaBottom = true,
    super.key,
  });

  final String title;
  final Widget child;
  final Widget? trailing;
  final Widget? leading;
  final Color? backgroundColor;
  final bool safeAreaBottom;

  @override
  Widget build(BuildContext context) {
    return CupertinoPageScaffold(
      backgroundColor: backgroundColor,
      navigationBar: CupertinoNavigationBar(
        leading: leading,
        middle: Text(title),
        trailing: trailing,
      ),
      // 透明 Material + 内嵌 Scaffold：页内 InkWell/TextField 需要祖先，
      // ScaffoldMessenger/SnackBar 机制原样保留（迁移期页面零改动即可运行）。
      child: Material(
        type: MaterialType.transparency,
        child: Scaffold(
          backgroundColor: Colors.transparent,
          body: SafeArea(bottom: safeAreaBottom, child: child),
        ),
      ),
    );
  }
}

/// Material Scaffold 专用的苹果风导航栏（PreferredSizeWidget）：
/// 让尚未整页迁移的页面一行接入玻璃导航栏与阶梯标题。
/// 页内仍可有 FAB/bottomNavigationBar/SnackBar，行为不变。
PreferredSizeWidget appleAppBar(
  String title, {
  List<Widget>? actions,
  Widget? leading,
}) {
  return PreferredSize(
    preferredSize: const Size.fromHeight(kToolbarHeight),
    child: Builder(
      builder: (context) => CupertinoTheme(
        data: cupertinoTheme(
          brightness: View.of(context).platformDispatcher.platformBrightness,
        ),
        child: CupertinoNavigationBar(
          leading: leading,
          middle: Text(title),
          trailing: actions == null || actions.isEmpty
              ? null
              : Row(mainAxisSize: MainAxisSize.min, children: actions),
        ),
      ),
    ),
  );
}
