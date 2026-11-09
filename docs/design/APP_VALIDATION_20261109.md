# App 本轮实现与验证回执

日期：2026-11-09（Asia/Shanghai）。分支：`codex/app-apple-ui-20261109`。

## 源码边界

本分支从 `main@3a9afefe3fcae0f5a827a728c7b71faa5fec102a` 创建。
用户本机的 `7ecc7b3dd30e81b1c8d6bee533e076dde3e1b07b` 尚未可访问，不在本分支中。
最终提交 SHA、完整源码树及对应远端 CI 以此分支的 Draft PR 为准。

仅修改 Flutter 展示、交互、主题、对应测试及交付文档；没有修改 API、模型、数据库迁移、存储键、微信业务源码或版本号。
现有 Android Flutter 客户端仍为 `1.2.1+19 candidate`，不是 iOS 原生客户端交付。

## 已执行的本地验证

环境：官方 Flutter 3.47.9 / Dart 3.13.7，Linux host engine，合成测试数据。

| 项目 | 最终结果 | 解释 |
| --- | --- | --- |
| `dart analyze` | PASS，No issues found | 当前 Flutter 工程静态分析；远端仍执行仓库既有 `flutter analyze` |
| 7 个目标套件 | 46 PASS / 0 FAIL / 0 SKIP | 见下方清单，包含真实 Widget、导航、缓存与系统字号行为 |
| 交互套件及渲染复核 | 5 PASS / 0 FAIL | 是上述 46 项的重复渲染运行，不额外相加 |
| `git diff --check` | PASS | 无补丁空白错误 |
| App 图片人工检查 | 3 张实际查看 | 只采用 `app-evidence/` 中最终图片，较早不合格渲染不作证据 |
| Android 安装及保数据升级 | NOT_RUN | host Widget 测试不能代替设备验证 |
| 正式签名与发布 | NOT_RUN | 不修改签名或发布状态 |

目标套件：`apple_ui_interaction_test.dart`、`system_font_scale_test.dart`、
`restart_boot_gate_test.dart`、`three_tab_navigation_test.dart`、
`cabinet_loading_state_test.dart`、`cabinet_entry_navigation_test.dart`、
`closeout_plan_widget_test.dart`。

这些测试覆盖搜索与筛选清除、家庭入口定位、原三栏导航、归档入口、重试与空态区别、
长文字、系统 200% 字号及应用大档 240%、系统非线性缩放保留。
没有把 2026-11-08 历史 902 PASS / 19 SKIP 计入本轮结果。

## 实际渲染图片

| 图片 | 检查场景 |
| --- | --- |
| [01-cabinet-390.png](app-evidence/01-cabinet-390.png) | 390 逻辑像素宽、浅色药箱；中文、长药名、未知日期和品牌主按钮 |
| [02-filter-320-text200.png](app-evidence/02-filter-320-text200.png) | 320 逻辑像素宽、200% 文字；筛选标题与选项换行、可滚动及操作可用 |
| [03-plans-dark-390.png](app-evidence/03-plans-dark-390.png) | 390 逻辑像素宽、深色计划；语义色、计数、记录操作与主按钮 |

图片由真实生产页面 Widget 在 Flutter host engine 中渲染，使用合成 HTTP 数据、仓库测试中文字体及 Cupertino 字体别名。
它们不是 Android 模拟器或真机截图。截图夹具未装配完整 `ProductionShell` 的底部 TabBar；三栏与家庭导航由另外的行为测试验证。
图片检查没有取代 TalkBack、手机平台字体、键盘、系统手势或真实账号验收。

复现步骤见 [App 实现说明](../../apps/flutter/docs/APPLE_UI_20261109.md)。

## 待完成事项

- 发布本分支后核对精确提交的既有 CI；PR 中记录真实结果，不复用主线历史 CI。
- 取得并合入缺失的本机候选后，再跑受影响回归，确认其两个提交的业务能力完整保留。
- 完成 Android 真机、签名、保数据安装、真实服务与可访问性验收。
- Figma Starter MCP 调用额度阻止画布写入；新文件为空白，HTML 参考不是可编辑 Figma 设计稿。
- 本机 Windows 看板 wrapper 不可用；待上报文件记录 NOT_SENT，不能当作成功回执。

总体设计、现有能力清单和平台差异见 [交付说明](APPLE_UI_DELIVERY_20261109.md)。
