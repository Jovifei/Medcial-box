# R3 用药计划 + R4 通知与更新 · 交付与测试报告

- 日期：2026-10-01
- 分支／工作树：`codex/flutter-ui-prototype`（`C:\Users\Admin\.codex\worktrees\flutter-ui-prototype\medcial_box`）
- 基线提交：`c129467`
- 版本：`APP_VERSION = 0.2.0-s0s1r1`（小程序 `services/app-update.ts`）
- 运行环境：Windows，Node 22.22.2，微信开发者工具 2.02.2609231（官方 `wcc`/`wcsc` 编译器），真实 PostgreSQL 17（容器 `medbox-pg-test`，`127.0.0.1:55432`）

## 一、本轮交付

### R3 用药计划（完成）

| 子项 | 内容 | 证据 |
|---|---|---|
| R3-a 后端 | 迁移 `016` 五表、照护对象与授权、计划 CRUD、今日安排懒物化、幂等确认与纠正留痕 | 真实 PG 5/5（`integration-pg-plans`） |
| R3-b 小程序页面 | 今日安排（日期切换、时间升序、照护对象筛选、逾期只提示"未确认"）、全部计划（进行中/暂停/已结束筛选、暂停恢复带版本号）、创建计划、计划详情 | 小程序 83/83 → 89/89 |
| R3-c 编辑语义 | 迁移 `017` 时间点归档（改期不再级联删除历史）、`PUT /medication-plans/:id` 版本校验、授权列表与撤销 | 真实 PG 新增 4 例（9/9 含父测试） |
| R3-d 权限页 | 照护对象与共享权限页（本人私有／家人共用、按成员授权、撤销二次确认） | 小程序 6/6 |

关键新增接口：

- `GET /api/v1/medication-plans/:planId`（计划详情，含 `canManage`）
- `PUT /api/v1/medication-plans/:planId`（改期／改时间点／改剂量，版本冲突 409）
- `GET /api/v1/medication-plans/:planId/history`（确认事件全保留，`corrected` 标记被纠正的记录）
- `GET|DELETE /api/v1/care-profiles/:id/grants[/:memberUserId]`（授权列表与撤销）
- `GET /api/v1/medication-plans?status=all|ended`（已结束计划保留历史入口）
- `GET /api/v1/medication-plans/reminders/status`（R4 提醒状态与发送结果）

新增页面：`pages/plan-detail`、`pages/care-profiles`、`pages/release-notes`。

修复的两个真实缺陷：

1. **客户端未排序**：今日安排直接按后端返回顺序渲染，补齐客户端时间升序（后端已排，客户端再排一次防来源差异）。
2. **改期会删历史**：删除时间点因外键级联删除服药实例与确认事件，等于改写历史；改为迁移 `017` 归档时间点，历史保留、未来按新时间点物化。

### R4 通知与更新（服务端与小程序完成；真实送达与 Android 未做）

- 迁移 `018` `dose_reminder_deliveries`：与库存提醒分表分模板，互不挤占一次性订阅授权。
- 调度器 `jobs/dose-reminder-scheduler.ts`：
  - 排队只排"到点且未确认"的实例（窗口 90 分钟），无可用授权就不排队；
  - 发送前复核计划状态、实例状态、收件人权限与家庭成员身份，任一不满足即拦截并退还授权；
  - 超时旧事件取消而不是集中补发；
  - 确认服用、暂停/结束计划、撤销授权、成员移除后立即取消排队事件。
- 小程序：服药提醒状态卡片（模板可用性、最近发送结果）、订阅由用户主动点击触发、模板不可用时如实说明"不承诺长期提醒"。
- 更新链路：功能介绍每版本仅自动展示一次（最多三项），"我的 → 版本与更新"可再次查看；小程序 `UpdateManager` 提示重启，每版本一次。

## 二、测试报告

| 门禁 | 结果 |
|---|---|
| 根 `npm run lint`（`--max-warnings=0` + JSON 语法） | PASS |
| 根 `npm run typecheck`（contracts / miniprogram / api） | PASS |
| 根 `npm run build` | PASS |
| 小程序 `node --test test/*.test.mjs` | **89 PASS / 0 FAIL** |
| API 合成单测 | **182 PASS / 0 FAIL**（6 项可选 PG 按规则跳过） |
| 工具脚本 `test:tooling` | 6 PASS / 0 FAIL |
| 真实 PostgreSQL `integration-pg` | 19 PASS / 0 FAIL |
| 真实 PostgreSQL `integration-pg-reminders` | 4 PASS / 0 FAIL |
| 真实 PostgreSQL `integration-pg-quantity` | 6 PASS / 0 FAIL |
| 真实 PostgreSQL `integration-pg-tags` | 5 PASS / 0 FAIL |
| 真实 PostgreSQL `integration-pg-photos` | 6 PASS / 0 FAIL |
| 真实 PostgreSQL `integration-pg-plans`（R3） | 10 PASS / 0 FAIL |
| 真实 PostgreSQL `integration-pg-dose-reminders`（R4） | 9 PASS / 0 FAIL |
| 小程序官方编译器 `npm run check:miniprogram` | **47 个文件（WXML 23、WXSS 24）全部通过** |

本轮新增用例：

- `apps/miniprogram/test/medication-plans.test.mjs`（18 例：排序、逾期语义、幂等键、纠正确认、版本冲突、时间点校验、照护对象筛选、状态筛选、详情跳转、提醒订阅与模板不可用）
- `apps/miniprogram/test/plan-detail.test.mjs`（7 例：历史与纠正展示、编辑只影响未来、冲突刷新、已结束不可恢复、只读权限）
- `apps/miniprogram/test/care-profiles.test.mjs`（6 例：私有/共用、授权、撤销确认）
- `apps/api/test/integration-pg-plans.test.mjs` 新增 4 例（详情与历史、编辑保留历史、授权撤销、已结束不可改）
- `apps/api/test/integration-pg-dose-reminders.test.mjs`（8 例：无授权不排队、到点排队并发送、确认后取消并退还授权、暂停后取消、超时不补发、撤销授权后取消、模板不可用如实上报）

## 二之二、同时补齐的 R2-d 剩余项

- 封面照片内嵌展示：私有图片接口需 Bearer 鉴权，改用 `wx.downloadFile` 带授权头下载到本地临时文件再展示，失败只提示不阻断详情。
- 快捷操作：新增库存／修改余量／标记开封／创建用药计划（只带入药品 ID 与名称，剂量与时间点仍由用户填写）。
- 折叠区域：说明书与来源／个人剂量备注／低库存设置默认收起。
- 更多菜单：编辑资料／导出 Markdown／变更记录／归档／删除（软删除进入最近删除，30 天可恢复）。

对应用例：小程序 96/96（新增封面 3 例、详情入口与折叠 3 例、计划页带入 1 例）。

## 三、NOT_RUN / BLOCKED

- **R4 真实微信模板送达**：需药箱专用 AppID 与类目模板；本机未配置，`BLOCKED_PLATFORM`。计划与今日安排不受影响。
- **Android 双渠道通知与精确闹钟**：本机无 Flutter SDK，Flutter 端改动未执行也未验证，`NOT_RUN`。
- **R0 收口 A06/A09 与 A03 UI 层**：同上，待 Flutter SDK。
- **R5 家庭试用**：需专用 AppID、两台设备与 APK；本机 `NOT_RUN`。
- **wechatide CLI**：内部调用 `reg.exe` 被本机安全策略列入黑名单，无法启动 IDE；已改用官方 `wcc`/`wcsc` 做编译门禁。
