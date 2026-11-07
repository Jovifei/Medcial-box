import 'package:flutter/material.dart';

/// iOS 语义色 token（HIG）：浅色/深色两套，禁止在业务代码里写散装 hex。
/// 品牌强调色只有一个（accent，药箱绿），其余全部走系统语义色。
abstract final class AppSemanticColors {
  // 品牌强调色（唯一，浅深同值；深色下提亮一档保证对比）
  static const accentLight = Color(0xFF087F5B);
  static const accentDark = Color(0xFF30B58B);

  static const labelLight = Color(0xFF000000);
  static const labelDark = Color(0xFFFFFFFF);
  static const secondaryLabelLight = Color(0x993C3C43);
  static const secondaryLabelDark = Color(0x99EBEBF5);
  static const tertiaryLabelLight = Color(0x4D3C3C43);
  static const tertiaryLabelDark = Color(0x4DEBEBF5);

  static const systemBackgroundLight = Color(0xFFFFFFFF);
  static const systemBackgroundDark = Color(0xFF000000);
  static const secondarySystemBackgroundLight = Color(0xFFF2F2F7);
  static const secondarySystemBackgroundDark = Color(0xFF1C1C1E);
  static const tertiarySystemBackgroundLight = Color(0xFFFFFFFF);
  static const tertiarySystemBackgroundDark = Color(0xFF2C2C2E);

  static const separatorLight = Color(0x5C3C3C43);
  static const separatorDark = Color(0x54545488);

  static const systemBlue = Color(0xFF007AFF);
  static const systemGreen = Color(0xFF34C759);
  static const systemIndigo = Color(0xFF5856D6);
  static const systemOrange = Color(0xFFFF9500);
  static const systemPink = Color(0xFFFF2D55);
  static const systemPurple = Color(0xFFAF52DE);
  static const systemRed = Color(0xFFFF3B30);
  static const systemTeal = Color(0xFF30B0C7);
  static const systemYellow = Color(0xFFFFCC00);
  static const systemGray = Color(0xFF8E8E93);
  static const systemGray2 = Color(0xFFAEAEB2);
  static const systemGray3 = Color(0xFFC7C7CC);
  static const systemGray4 = Color(0xFFD1D1D6);
  static const systemGray5 = Color(0xFFE5E5EA);
  static const systemGray6 = Color(0xFFF2F2F7);

  /// 按当前亮度取值；组件代码通过 of(brightness) 拿整组。
  static ({Color accent, Color label, Color secondaryLabel, Color tertiaryLabel,
      Color background, Color secondaryBackground, Color tertiaryBackground,
      Color separator, Color danger, Color success, Color warning}) of(
      Brightness brightness) {
    final dark = brightness == Brightness.dark;
    return (
      accent: dark ? accentDark : accentLight,
      label: dark ? labelDark : labelLight,
      secondaryLabel: dark ? secondaryLabelDark : secondaryLabelLight,
      tertiaryLabel: dark ? tertiaryLabelDark : tertiaryLabelLight,
      background: dark ? systemBackgroundDark : systemBackgroundLight,
      secondaryBackground:
          dark ? secondarySystemBackgroundDark : secondarySystemBackgroundLight,
      tertiaryBackground:
          dark ? tertiarySystemBackgroundDark : tertiarySystemBackgroundLight,
      separator: dark ? separatorDark : separatorLight,
      danger: systemRed,
      success: systemGreen,
      warning: systemOrange,
    );
  }
}
