import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart' show TextTheme;

/// HIG Dynamic Type 阶梯（默认档）。只允许使用这里定义的字号级别，
/// 禁止在业务代码里发明阶梯外字号（见 DESIGN.md）。
abstract final class AppType {
  static const largeTitle = TextStyle(fontSize: 34, fontWeight: FontWeight.w400, height: 1.12);
  static const title1 = TextStyle(fontSize: 28, fontWeight: FontWeight.w400, height: 1.15);
  static const title2 = TextStyle(fontSize: 22, fontWeight: FontWeight.w400, height: 1.2);
  static const title3 = TextStyle(fontSize: 20, fontWeight: FontWeight.w400, height: 1.25);
  static const headline = TextStyle(fontSize: 17, fontWeight: FontWeight.w600, height: 1.3);
  static const body = TextStyle(fontSize: 17, fontWeight: FontWeight.w400, height: 1.35);
  static const callout = TextStyle(fontSize: 16, fontWeight: FontWeight.w400, height: 1.3);
  static const subhead = TextStyle(fontSize: 15, fontWeight: FontWeight.w400, height: 1.3);
  static const footnote = TextStyle(fontSize: 13, fontWeight: FontWeight.w400, height: 1.35);
  static const caption1 = TextStyle(fontSize: 12, fontWeight: FontWeight.w400, height: 1.3);
  static const caption2 = TextStyle(fontSize: 11, fontWeight: FontWeight.w400, height: 1.25);

  /// 把阶梯灌入 Material TextTheme（过渡期壳仍在用 Material 组件），
  /// 字号与字重严格对齐上表；颜色由主题的 onSurface/语义色承担。
  static TextTheme materialTextTheme(Color label, Color secondaryLabel) => TextTheme(
    headlineLarge: largeTitle.copyWith(color: label),
    headlineMedium: title1.copyWith(color: label),
    titleLarge: title2.copyWith(color: label),
    titleMedium: title3.copyWith(color: label),
    titleSmall: headline.copyWith(color: label),
    bodyLarge: body.copyWith(color: label),
    bodyMedium: body.copyWith(color: secondaryLabel),
    bodySmall: footnote.copyWith(color: secondaryLabel),
    labelLarge: headline.copyWith(color: label),
    labelMedium: footnote.copyWith(color: secondaryLabel),
    labelSmall: caption1.copyWith(color: secondaryLabel),
  );

  /// Cupertino 文本主题：按 iOS 名称映射同一阶梯。
  static CupertinoTextThemeData cupertinoTextTheme(Color label, Color secondaryLabel) =>
      CupertinoTextThemeData(
        textStyle: body.copyWith(color: label),
        // inherit:false + 显式字段：与 Cupertino 默认一致，页面切换插值不再抛断言。
        navTitleTextStyle: TextStyle(
          inherit: false,
          fontSize: 17,
          fontWeight: FontWeight.w600,
          height: 1.3,
          letterSpacing: -0.4,
          color: label,
        ),
        navLargeTitleTextStyle: largeTitle.copyWith(color: label),
        primaryColor: label,
        actionTextStyle: body.copyWith(color: label),
        pickerTextStyle: body.copyWith(color: label),
        dateTimePickerTextStyle: body.copyWith(color: label),
      );
}
