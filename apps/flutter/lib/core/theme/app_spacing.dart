/// 全局统一尺寸令牌（DESIGN.md 落地）：所有屏幕共用，禁止散装数值。
/// 8pt 网格；页面左右边距 16；卡片内距 16；卡片圆角 14；分组行距 8。
abstract final class AppSpacing {
  /// 页面左右边距（全屏统一 16）。
  static const double pageH = 16;

  /// 卡片内边距。
  static const double cardPad = 16;

  /// 卡片/分组容器圆角。
  static const double cardRadius = 14;

  /// 小控件（输入框、缩略图）圆角。
  static const double controlRadius = 10;

  /// 区块之间的纵向间距。
  static const double sectionGap = 12;

  /// 组内行间距。
  static const double rowGap = 8;

  /// 页面底部保底留白（FAB/底部栏避让另加）。
  static const double pageBottom = 24;
}
