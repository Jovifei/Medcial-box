import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import 'app_colors.dart';
import 'app_typography.dart';

/// 旧品牌色（Material 过渡期仍在部分屏幕使用；新屏幕一律用 AppSemanticColors）。
/// 新增屏幕禁止引用这里除 [AppColors.leaf]（= accent）以外的成员。
abstract final class AppColors {
  @Deprecated('Use AppSemanticColors.accent instead')
  static const leaf = Color(0xFF087F5B);
  @Deprecated('Use AppSemanticColors.of(...) instead')
  static const ink = Color(0xFF17382C);
  @Deprecated('Use AppSemanticColors.of(...) instead')
  static const muted = Color(0xFF536A60);
  @Deprecated('Use AppSemanticColors.of(...) instead')
  static const leafDeep = Color(0xFF075E45);
  @Deprecated('Use AppSemanticColors.of(...) instead')
  static const mist = Color(0xFFEAF3EE);
  @Deprecated('Use AppSemanticColors.of(...) instead')
  static const line = Color(0xFFDCE7E0);
  @Deprecated('Use AppSemanticColors.of(...) instead')
  static const terracotta = Color(0xFFB42318);
  @Deprecated('Use AppSemanticColors.of(...) instead')
  static const amber = Color(0xFFB45309);
  @Deprecated('Use AppSemanticColors.of(...) instead')
  static const paper = Color(0xFFF7FAF8);
}

/// 过渡期 Material 主题：字号走 HIG 阶梯、色走语义 token、无波纹。
/// Stage C 逐屏 Cupertino 化完成后，壳切换为 CupertinoApp，本主题仅服务存留 Material 组件。
ThemeData appTheme({Brightness brightness = Brightness.light}) {
  final c = AppSemanticColors.of(brightness);
  final scheme = ColorScheme.fromSeed(
    seedColor: c.accent,
    brightness: brightness,
  ).copyWith(
    primary: c.accent,
    onPrimary: c.background,
    surface: c.background,
    onSurface: c.label,
    error: c.danger,
  );
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: c.background,
    fontFamily: 'sans',
    splashFactory: NoSplash.splashFactory,
    textTheme: AppType.materialTextTheme(c.label, c.secondaryLabel),
    appBarTheme: AppBarTheme(
      backgroundColor: c.background,
      foregroundColor: c.label,
      elevation: 0,
      centerTitle: false,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: c.secondaryBackground,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 15),
      border: OutlineInputBorder(
        borderRadius: const BorderRadius.all(Radius.circular(12)),
        borderSide: BorderSide(color: c.separator),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: const BorderRadius.all(Radius.circular(12)),
        borderSide: BorderSide(color: c.separator),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: const BorderRadius.all(Radius.circular(12)),
        borderSide: BorderSide(color: c.accent, width: 1.5),
      ),
    ),
    cardTheme: CardThemeData(
      color: c.secondaryBackground,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: const BorderRadius.all(Radius.circular(12)),
        side: BorderSide(color: c.separator),
      ),
    ),
  );
}

/// Cupertino 主题（目标态）：浅色/深色各一套，颜色与阶梯全部来自 DESIGN.md 约束。
CupertinoThemeData cupertinoTheme({Brightness brightness = Brightness.light}) {
  final c = AppSemanticColors.of(brightness);
  final isDark = brightness == Brightness.dark;
  return CupertinoThemeData(
    brightness: brightness,
    primaryColor: c.accent,
    scaffoldBackgroundColor: c.background,
    barBackgroundColor: isDark
        ? const Color(0xF0161616)
        : const Color(0xF0F9F9F9), // 导航层半透明+模糊=允许的玻璃位置
    textTheme: AppType.cupertinoTextTheme(c.label, c.secondaryLabel),
  );
}
