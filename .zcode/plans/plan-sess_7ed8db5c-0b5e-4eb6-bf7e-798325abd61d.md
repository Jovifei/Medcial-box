## Context

小程序功能已完整，现要求 Android App（apps/flutter）对齐小程序功能并完成"苹果风"UI。会诊文档结论（用户提供的《苹果风UI团队会诊与执行方案》）：跨端框架靠**约束文件**钉住 HIG 规则、**系统组件优先**、**截图循环验收**。探查结论：Flutter 已覆盖约 22/26 页（Material 3 主题），配对链路已两端打通（8 位一次性连接码，DeviceLinkPage ↔ 小程序 app-link 页，本批不动仅回归）；真实缺口 4 项（家庭设置、提醒设置、备份恢复、详情页内批次/照片补齐），服务端 API 全部已备好（families/settings、notification-preferences GET/PUT、backups.ts）。子代理不可派发（宿主已知故障），全部主会话执行。

**已拍板**：全 Cupertino 化｜4 项缺口全补｜配对保持现状｜版本 1.2.0 / Android build 18。

## Stage A：约束文件 + Cupertino 基座

1. 新建 `apps/flutter/DESIGN.md`：照会诊模板钉死——Dynamic Type 字号阶梯（Large Title 34→Caption2 11，禁止阶梯外字号）、语义色 token（systemBlue 等系统色 + label/secondaryLabel/systemBackground，浅深两套）、44×44pt 命中区、8pt 网格/页边距 16–20/卡片内距 16、卡片圆角 10–16 连续圆角、SF Symbols 风格图标、动效只动 transform/opacity（200–350ms 弹簧曲线）、玻璃只用于导航/控件层；**反面清单**（Inter/紫渐变/假玻璃/三等宽卡片/阶梯外字号，命中即打回）。
2. `lib/core/theme/app_theme.dart` 重写为 Cupertino 体系：新增 `CupertinoThemeData`（含深色），保留原文件语义色导出供过渡；`main.dart`/`app.dart` MaterialApp→CupertinoApp 骨架（GoRouter 路由表保留），导航过渡用系统转场。
3. 新建 `lib/core/theme/app_typography.dart`（阶梯映射 TextStyle）与 `app_colors.dart`（语义色 token，浅深两套）。
4. 用 visualize 技能做一页「风格预览」HTML（阶梯/色板/组件样例）给用户过目后再动全量屏幕。

## Stage B：功能缺口 4 项（新 UI 直接按 Cupertino 写）

1. **家庭设置页** `lib/features/family/family_settings_page.dart`：改名/成员管理/邀请码——复用 `api_workflow_repository.dart` 已有的 `/api/v1/families/settings` GET/PUT 与 my_page 现有邀请码逻辑。
2. **提醒/通知设置页** `lib/features/my/notification_settings_page.dart`：对接 `reminders.ts` 的 GET/PUT `/api/v1/notification-preferences` + 本地 `local_reminder_service.dart`。
3. **备份恢复页** `lib/features/my/backup_restore_page.dart`：对接 `backups.ts`（createJsonBackup/preview/restore 流程，参照小程序 `pages/backup-restore`，含确认令牌）。
4. **详情页内补齐**：`medicine_detail_api_page.dart` 补批次编辑入口与照片管理区（对齐小程序 medicine-photos/batch-edit 能力，复用 leaflet_photo_page 与 batches API）。
5. 路由注册进 `app.dart`（/family-settings、/notification-settings、/backup-restore），my_page 入口接线。

## Stage C：逐屏 Cupertino 改造 + 截图循环

- 屏清单（18 屏，两批）：核心批 = connect / family-choice / home / medicine-detail / medicine-entry / plans / plan-form / my；第二批 = plan-detail / plan-history / care-profiles / care-permissions / pending / stocktake / trash / audit / export / release-notes。
- 每屏：按 DESIGN.md 改写 → `android_build_and_run` 到模拟器 → `android_screenshot` → 与 iOS 系统设置/App Store 参照并排对比 → 修差异 → 循环（截图预算：每屏 2–3 张，屏幕无变化不重拍）。
- 对照反面清单逐屏打分，命中即改。

## Stage D：深色模式 + 收口 1.2.0/build18

1. 全部屏幕深色模式过一遍截图（语义色自动适配验证）。
2. `flutter test`（test/ + integration_test/ 中可跑部分）全绿、根仓库 lint/typecheck 不回归。
3. 版本收口：VERSION.json → 1.2.0/18；`apps/flutter/pubspec.yaml` → 1.2.0+18；小程序 `APP_VERSION` → 1.2.0 + 版本说明；**小程序树哈希将变化 → 按 QA 白名单治理流程登记新哈希并重跑 test:mini:qa**。
4. 回执 69 + 提交推送 main；真机安装验收与体验版上传列为待 Jovi 操作项（同前批边界）。

## 验证方式

- 每屏：android-emulator 插件 `android_build_and_run` + `android_screenshot` 截图循环；console 无错误。
- Stage A/D：`flutter test`、`flutter analyze`、根 `npm run lint`。
- 配对回归：模拟器跑 App 显示连接码链路（UI 层验证；端到端确认沿用既有小程序验收路径）。
- 最终：IDE 交互测试（登录→首页→详情→计划→新 3 页），3 张验收截图入 `.local-data/ide-verify-*/`。

## 执行边界

- 分屏提交、每 Stage 收尾更新 tasks/todo.md；约 120 工具回合时提醒开新会话接续。
- 不碰小程序业务代码（除 APP_VERSION/版本说明）；不改 API；配对协议不动。