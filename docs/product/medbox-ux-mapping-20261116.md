# 小药箱 M1–M5 两端现状映射（T1）

- 依据：小药箱最终方案 v1.0 —— Jovifei/Medcial-box draft PR #15（head `033dc25423305dd9d7ca6fc9056081bbce57e1da`），文件 `docs/product/execution-plan-ux-m1-m5-20261116.md`；以及工作总群 #238 修改版派单（「T1 先固定两端版本……M1–M5 映射对照并入此步」）。
- 出表日期：2026-11-16。
- 状态口径：
  - **已具备**：该固定版本的源码/测试/回执有直接证据，并注明证据位置。
  - **缺失**：该固定版本明确未实现该能力（以源码行为为证）。
  - **未验**：当前没有直接证据，须真机/平台取证；不虚构缺失。

## 1. 两端版本固定

### 1.1 微信小程序 1.2.1

- 固定源码：`5a194002bb6f199939f02cd4df3c1812e9d71982`（= 远端 `main` 与 `codex/miniprogram-ui-integration-20261109` 的同一提交）。
- 候选包：138 个文件，包 SHA-256 `6cbd1b20f87c396f22a012a1ff053a7ce0a0b4e498919660cf2458cb4f71ff75`；官方 wcc 29 份、wcsc 30 份编译全部通过。
- 同 SHA CI：run `42830052152` 四项通过（main）。
- 上传回执：`execution_success`，1.2.1 开发版包体 666,262 字节，Jovi 在微信开发者工具确认上传（2026-11-10）；记录于小程序工作区 `E:\project\medcial_box-miniprogram` 的分支 `codex/miniprogram-ui-integration-20261109` 提交 `3d4a074977f564edb7da01aa712f0366288380ee`（该分支较远端多 3 个文档记录提交，均为台账/文档，不改小程序源码）。
- **未验**：体验版/体验资格未确认（属 T4 启动前四项，须业主另行确认）；微信后台与真机另验。

### 1.2 Android App 1.2.1 / build 20

- 构建源码：`2f88956d56b192521b7865036dd5bab85da34b75`，源码树 `6cbb60861ce9426cc5c842754b216a6a184932f1`。
- 版本：`1.2.1 / build 20 / candidate`（根 `VERSION.json`）；Debug 包沿用现装测试版的包名、证书与 HTTPS API；相机声明为可选 Android 硬件。
- 校验：`flutter analyze` 无问题；定向测试 63 通过；`lintDebug` 0 错误 4 警告；APK SHA-256 `27a40df2b2d4c5bd4f5c1a78f79c9dc0c2780cac0ad514bd85e98789cf98cb4c`；aapt2 确认 build 20 / Debug 标记与原签名匹配。
- 装机证据：同签名覆盖安装 `Success`（1.2.1/build 19 → 1.2.1/build 20 Debug），设备装机 APK 摘要与候选一致，首次安装时间保留（2026-11-10）。
- 工作区状态：当前检出 `E:\project\medcial_box` @ `codex/app-ui-integration-20261109`，HEAD `1519c9e3ed209e63788187994a3fee827bf9e71a`；该分支尚未推送远端，远端 `main` 为 `5a19400`（其 `VERSION.json` 仍为 build 19）。
- **未验**：设备启动与真实业务数据复验；正式签名、保数据升级、发布。

### 1.3 测试资格

- 小程序：开发版上传成功（`execution_success`）；体验资格未确认 → **未验**。
- Android：本机 Debug 测试包装机；其他测试设备、正式签名 → **未验**。

## 2. 关联 PR 现状

- **PR #14**（App 苹果风交互与系统大字号适配）：open / draft，head `b8eecaeb894b1f791e45b2584be83beeb5189d2b`，`mergeable_state=dirty`（2026-11-16 GitHub API 实查）；其改动已并入本地集成提交 `2b1c4d5033914545745c942344340d39d6eaf440`；PR 内同 SHA CI run `42637641020` 四 job SUCCESS（含 Flutter 927 项通过）；PR 正文所述版本仍 `1.2.1+19`，本地集成后为 `1.2.1+20`。正式签名、手机安装、保数据升级、真实服务在 PR 内标注未执行。
- **PR #15**（最终方案 v1.0）：open / draft，head `033dc25423305dd9d7ca6fc9056081bbce57e1da`；本表以其为唯一正文来源。

## 3. M1–M5 映射对照

### M1 状态准确（区分加载、读取失败与确实为空；刷新失败保留旧库存并可重试）

| 端 | 状态 | 证据 |
| --- | --- | --- |
| 小程序 1.2.1 @ `5a19400` | 已具备（三态区分 + 重试）；**缺失**（刷新失败保留旧库存） | `apps/miniprogram/pages/index/index.ts`：`loading`（:220/:260）、`errorMessage`、`showUnavailable`（:489，失败时 `allItems: []` 清空）、`onRetry`（:639）；`apps/miniprogram/pages/index/index.wxml`：错误卡（:42）与两个空态卡（:49/:54）分离 |
| App build 20 @ `2f88956` | 已具备 | `apps/flutter/lib/features/home/production_shell.dart`：`_load()`（:316）失败保留上次数据并显示「暂时无法更新，正在显示上次读取的药箱。」（:545）与「重新加载」；`test/cabinet_loading_state_test.dart`：loading/failure/成功空态三态区分测试 |

- **未验**：两端真机演练。

### M2 找药与识别（当前家庭、药品规格与批次、筛选结果可辨）

| 端 | 状态 | 证据 |
| --- | --- | --- |
| 小程序 1.2.1 @ `5a19400` | 已具备 | `apps/miniprogram/pages/index/index.wxml`：当前家庭（:11）、搜索框（:20）、用途/人群/状态筛选（:32）、排序与筛选摘要（:40）、无匹配空态（:54–:57）；规格与批次展示在 `pages/medicine-detail/` |
| App build 20 @ `2f88956` | 已具备 | `apps/flutter/lib/features/home/production_shell.dart`：检索栏、筛选与排序控件、当前家庭区块；`test/apple_ui_interaction_test.dart`；PR #14 正文（搜索/筛选/排序/结果数量、当前家庭与家庭管理入口） |

- **未验**：真机找药路径。

### M3 不确定信息（分开表达未知数量、零库存与未知效期）

| 端 | 状态 | 证据 |
| --- | --- | --- |
| 小程序 1.2.1 @ `5a19400` | 已具备 | 未知数量 →「库存待核对」：`pages/index/index.wxml:94`、`pages/medicine-detail/medicine-detail.ts:281/:408/:429`；未知效期 →「有效期未知」：`pages/index/index.ts:144`；零库存「已用完」筛选：`pages/index/index.wxml:38`、`pages/index/index.ts:526/:546`；「已耗尽」：`medicine-detail.ts:409` |
| App build 20 @ `2f88956` | 已具备 | `apps/flutter/lib/features/home/home_page.dart`：未知效期「待补充」（:292、:413 `ExpiryState.unknown`）、数量未知（:375） |

- **未验**：真机混合数据核对。

### M4 记录与纠错（区分计划读取失败、待确认与已记录，并提供纠正反馈）

| 端 | 状态 | 证据 |
| --- | --- | --- |
| 小程序 1.2.1 @ `5a19400` | 已具备 | `apps/miniprogram/pages/plan-detail/plan-detail.ts:53`（未确认/已服用/本次跳过）、`plan-detail.wxml:73`（纠正留痕）；`pages/medication-plans/medication-plans.wxml:42`（「已过时间未确认；不判定漏服」）、:44/:48（记录中/重试、已服用）；`medication-plans.ts:201`（提醒读取失败只影响提示区，不拖垮页面） |
| App build 20 @ `2f88956` | 已具备 | `apps/flutter/lib/features/plan/plans_page.dart:327`（「待确认 X 次 · 已记录 Y 次」）；`apps/flutter/lib/features/pending/pending_page.dart:346`（数量待确认）；`test/dose_confirmation_retry_test.dart` |

- **未验**：双机双账号流程（归 T2 覆盖）。

### M5 可用性（窄屏与大字号下主操作可达；状态同时用文字表达）

| 端 | 状态 | 证据 |
| --- | --- | --- |
| 小程序 1.2.1 @ `5a19400` | 已具备（文档+源码）；真机未验 | `docs/design/APPLE_UI_DELIVERY_20261109.md:47`（48 命中区目标、320 宽/200% 文字单独核查）；`apps/miniprogram/services/app-update.ts:37`（大字号/窄屏录入提示）；状态均有文字表达（库存待核对、有效期未知、已耗尽等） |
| App build 20 @ `2f88956` | 已具备（源码+测试）；真机未验 | `apps/flutter/lib/core/theme/font_scale.dart`（保留系统 `TextScaler` 后叠加用户档位）；`test/system_font_scale_test.dart`；PR #14 正文（系统 200% 仍 200%、大档 240%、点击区域至少 48） |

- **未验**：两端真机大字号/窄屏操作。

## 4. 未验清单（汇总）

1. 小程序体验资格（T4 启动前四项之一，待业主确认）；微信后台与真机验收。
2. Android 启动与真实业务数据复验；正式签名、保数据升级、发布。
3. 两端真机的 M1–M5 实际操作路径（由 T2 双机双账号四步验收覆盖）。
4. PR #14 仍为 open/draft，`mergeable_state=dirty`，远端未合并。

## 5. 与方案边界的一致性

- 本表只读源码、回执、CI 记录与 GitHub API（PR #14/#15 状态），未改码、未部署、未使用真实数据、未合并 main。
- 最小改动清单待 T2 结果与本映射汇合后，按最终方案 §2（T3）另行立行、逐项表决。