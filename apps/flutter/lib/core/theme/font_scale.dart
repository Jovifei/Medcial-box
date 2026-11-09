import 'package:flutter/cupertino.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 字号档位（小 / 标准 / 大）：适配不同人群（含适老需求）。
/// 全局通过 MediaQuery.textScaler 应用，页面代码不感知档位。
enum FontScaleSetting { small, medium, large }

extension FontScaleSettingFactor on FontScaleSetting {
  double get factorValue {
    switch (this) {
      case FontScaleSetting.small:
        return 0.90;
      case FontScaleSetting.medium:
        return 1.00;
      case FontScaleSetting.large:
        return 1.20;
    }
  }
}

/// Applies the in-app preference after the platform's complete scaling curve.
/// The platform may scale small and large text differently; sampling scale(1)
/// and replacing it with a linear scaler would discard that accessibility rule.
class SystemAndAppTextScaler extends TextScaler {
  const SystemAndAppTextScaler({required this.system, required this.factor});

  final TextScaler system;
  final double factor;

  @override
  double scale(double fontSize) => system.scale(fontSize) * factor;

  // Compatibility estimate only. Rendering always uses scale(fontSize).
  @override
  double get textScaleFactor => scale(14) / 14;

  @override
  bool operator ==(Object other) =>
      other is SystemAndAppTextScaler &&
      other.system == system &&
      other.factor == factor;

  @override
  int get hashCode => Object.hash(system, factor);
}

class FontScaleController extends ChangeNotifier {
  FontScaleController._(this.setting);

  static const _key = 'ui.fontScale';
  FontScaleSetting setting;

  static FontScaleController fallback() =>
      FontScaleController._(FontScaleSetting.medium);

  static Future<FontScaleController> load() async {
    try {
      final preferences = await SharedPreferences.getInstance();
      final raw = preferences.getString(_key);
      final setting = FontScaleSetting.values.firstWhere(
        (value) => value.name == raw,
        orElse: () => FontScaleSetting.medium,
      );
      return FontScaleController._(setting);
    } catch (_) {
      // 偏好读取失败时回退标准档，不阻断启动。
      return FontScaleController.fallback();
    }
  }

  double get factor {
    switch (setting) {
      case FontScaleSetting.small:
        return 0.90;
      case FontScaleSetting.medium:
        return 1.00;
      case FontScaleSetting.large:
        return 1.20;
    }
  }

  TextScaler combineWithSystem(TextScaler system) => factor == 1
      ? system
      : SystemAndAppTextScaler(system: system, factor: factor);

  String get label {
    switch (setting) {
      case FontScaleSetting.small:
        return '小';
      case FontScaleSetting.medium:
        return '标准';
      case FontScaleSetting.large:
        return '大';
    }
  }

  Future<void> set(FontScaleSetting next) async {
    if (next == setting) return;
    setting = next;
    notifyListeners();
    try {
      final preferences = await SharedPreferences.getInstance();
      await preferences.setString(_key, next.name);
    } catch (_) {
      // 持久化失败时本次会话仍生效，下次启动回退。
    }
  }
}
