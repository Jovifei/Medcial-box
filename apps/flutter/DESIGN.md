# Apple 风格 UI 约束（apps/flutter · JF小药箱 Android App）

依据：《苹果风UI团队会诊与执行方案》（2026-11-06）+ Apple HIG（developer.apple.com/design）。
产品类型：家庭药箱记录与照护工具——**内容清晰、UI 服务内容、克制**。
本文件是常驻上下文约束；任何屏幕改动前先读本文件，改动后按「验收循环」自查。

## 三原则

Clarity（内容清晰）· Deference（UI 不抢戏）· Depth（层级与动效表达结构）。

## 字体（HIG Dynamic Type 阶梯，默认档；只许用阶梯字号）

| 级别 | 字号 | 字重 | 用途 |
| --- | --- | --- | --- |
| largeTitle | 34 | 400 | 首页大标题（滚动收成 17 导航标题） |
| title1 | 28 | 400 | 特大区块标题（少用） |
| title2 | 22 | 400 | 区块标题 |
| title3 | 20 | 400 | 次级区块标题 |
| headline | 17 | 600 | 列表行主文本/重点 |
| body | 17 | 400 | 正文 |
| callout | 16 | 400 | 次级正文 |
| subhead | 15 | 400 | 辅助行、输入框 |
| footnote | 13 | 400 | 脚注、次要说明 |
| caption1 | 12 | 400 | 时间戳、标签 |
| caption2 | 11 | 400 | 最小注记 |

- 禁止发明阶梯外字号；层级靠字号+字重，不靠颜色。
- 中文栈：PingFang SC / Noto Sans SC（现有 `sans` 字体资产），**禁止 Inter/Roboto**。
- 所有文本随系统字号缩放（textScaler），不写死溢出。

## 颜色（语义 token，不写死散装 hex）

- 代码一律用 `AppSemanticColors`（app_colors.dart）：label / secondaryLabel / tertiaryLabel /
  systemBackground / secondarySystemBackground / tertiarySystemBackground / separator /
  systemRed|Orange|Yellow|Green|Teal|Blue|Indigo|Purple / systemGray–Gray6。
- **强调色全 App 只一个**：品牌绿 `accent`（#087F5B，药箱品牌延续），仅用于主按钮、选中态、链接。
- 浅色/深色两套值都已定义，必须都实现（Stage D 全屏过深色）。
- 危险=systemRed，警告=systemOrange，成功=systemGreen；禁止自造高饱和 hex、禁止大面积色块。

## 间距与布局

- 8pt 网格、4pt 细分；页面左右边距 16–20；卡片内边距 16；列表行距 8–12。
- **所有可点元素命中区 ≥ 44×44**；对齐 safe area；分组列表用 iOS inset grouped 样式。

## 圆角与材质

- 控件用系统连续圆角；卡片 10–16；禁止"万物大圆角"。
- 玻璃/模糊只允许出现在导航栏与控件层（如滚动时导航栏毛玻璃）；**内容层禁止假玻璃**。

## 图标

- 图标风格对齐 SF Symbols：线性、可变字重；用 Flutter 内置线性图标或自绘 SF 风格路径。
- 不用 emoji 当图标；不混用两套图标风格。

## 动效（core/motion/app_motion.dart 统一管）

- 只动 transform 与 opacity；时长 200–350ms；优先系统转场（页面 push 用 CupertinoPage 右滑入）。
- 弹簧曲线用于交互反馈；无目的不加动效；滚动性能优先。

## 组件策略（系统组件优先，自绘是负分）

- 导航栏：CupertinoNavigationBar（大标题滚动收缩用 CupertinoSliverNavigationBar）。
- 列表：CupertinoListSection.insetGrouped + CupertinoListTile。
- 开关/滑杆/日期：CupertinoSwitch / CupertinoSlider / CupertinoDatePicker。
- 确认与选项：CupertinoAlertDialog / CupertinoActionSheet；加载：CupertinoActivityIndicator。
- 输入：CupertinoTextField；Tab：CupertinoTabBar。
- 底层仍保留少量 Material 依赖时，视觉参数必须与本文件一致（无波纹：NoSplash）。

## 反面清单（出现任一条即打回）

Inter/Roboto 字体｜紫色渐变 hero｜三张等宽白卡片+药丸徽章｜装饰性渐变按钮｜全屏发光｜
假玻璃滥用｜Lorem ipsum｜阶梯外字号｜波纹点击效果｜彩色大底色块。

## 验收循环（每屏必走）

1. 构建并运行到 Android 模拟器，截图；
2. 与 iOS 系统设置/App Store 参照并排对比，列差异；
3. 修复后重截图，直至达标（每屏 2–3 张，画面无变化不重拍）；
4. 深浅色各过一遍；真机核对 44pt 命中区与滚动；
5. 过一遍反面清单，任何一条命中即打回。

## 参照

- 系统设置页 = 分组设置/详情类屏幕参照；App Store 首页 = 内容流参照。
- 品牌与既有资产：保留 `assets/fonts` 与品牌绿 accent；其余旧 Material 绿色系（paper/mist/line 等）在新屏中废弃。
