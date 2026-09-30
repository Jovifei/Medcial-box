# 修复批次报告 · 2026-10-01 · S0 备份恢复保真 + S1 身份隔离

## 一、版本记录

| 项目 | 值 |
|---|---|
| 仓库 / 分支 | `Jovifei/Medcial-box` · `codex/flutter-ui-prototype` |
| 修复批次 | **S0 + S1**（对应候选修复计划第一阶段） |
| 基线提交 | `47d36e30d091d68d4b5a6d5bf3ad346ef0ab2792` |
| 本批次提交 | 见本文件所在提交及其前一提交（代码 + 台账） |
| 工作树 | `C:\Users\Admin\.codex\worktrees\flutter-ui-prototype\medcial_box` |
| 涉及问题 | A01、A02、A03（数据层）、A04、A07、A12 |
| 未涉及 | A05/A06/A08/A09/A10/A11/A13/A14/A15（属 S2/S3）、S4 功能补齐、S5 真实验收 |

> 小程序无 versionCode 概念；本批次以「计划阶段编号 + 提交 SHA」作为版本标识，与项目既有 `tasks/status.md` 台账一致。

## 二、更新内容

### S0 · 备份恢复保真（A01 / A02）

| 问题 | 根因 | 修复 |
|---|---|---|
| A01 JSON 恢复丢弃有效期/说明书/来源 | 备份校验已产出内部扁平类型（`expiryValue`/`expiryPrecision`、`leafletPurposeSummary`…），恢复循环又用只接受外部嵌套格式的 `validateMedicineInput` 二次解析，三项落为 null | 恢复直接消费已验证类型，删除二次解析 |
| A02 已处理库存恢复后"复活" | 备份不含 `dispositionStatus`，`insertBatch` 不写该列，数据库默认 `active` | 备份携带处置状态并在恢复时写库；旧版备份缺省按 `active` 兼容，预览提示 |

改动文件：

- `packages/contracts/src/index.ts`：新增 `DispositionStatus`、`BackupBatchInput`、`BackupMedicineInput`；`FamilyMedicineBackup.medicines` 使用备份专用类型；`BackupPreviewResponse` 新增 `handledBatchCount`、`settingsPolicy`
- `apps/api/src/services/backup-snapshot.ts`：导出写入处置状态；校验解析并校验 `dispositionStatus`；`ValidatedBackupMedicineFields` / `ValidatedBackupBatchFields`
- `apps/api/src/repositories/batches.ts`：`insertBatch` 支持 `options.dispositionStatus`
- `apps/api/src/routes/backups.ts`：导出统一走 `createFamilyMedicineBackup`；恢复不再二次解析；预览返回处置状态计数与「仅库存恢复」策略

### S1 · 身份隔离

| 问题 | 修复 |
|---|---|
| A12 存储失败后请求丢失 Authorization | `services/api.ts` 增加内存令牌镜像，`storeToken`/`readToken`/`clearToken` 三者同步 |
| A04 草稿跨账号/家庭恢复 | 新增 `services/session-scope.ts`（userId+familyId 命名空间）；草稿键身份化并记录归属，恢复时校验；旧版无归属草稿只提示不迁移；身份缺失时禁用草稿读写 |
| A07 被移除成员仍收排队提醒 | 每轮调度前作废孤儿任务并释放其授权；领取时带 `is_member`；发送前最后复核；移除/退出在同一事务内取消待发任务与授权 |
| A03 Flutter 换账号残留上一家庭库存 | `ApiMedicineRepository.clearSessionSnapshot()`；`AppServices.clearIdentityData()` 统一注入 `ApiAuthRepository.onIdentitySwitch` 与 `ApiFamilyRepository.onFamilyChanged`；退出（含服务端撤销失败）必切未登录态 |

改动文件：

- `apps/miniprogram/services/session-scope.ts`（新增）、`services/api.ts`、`services/auth.ts`
- `apps/miniprogram/pages/medicine-edit/medicine-edit.ts`、`medicine-edit.wxml`
- `apps/api/src/jobs/reminder-scheduler.ts`、`apps/api/src/routes/invitations.ts`
- `apps/flutter/lib/data/api_medicine_repository.dart`、`api_auth_repository.dart`、`app_services.dart`
- `scripts/run-integration.mjs`（PG 套件拆分为独立进程）

新增测试：`apps/api/test/integration-pg-reminders.test.mjs`、`apps/flutter/test/session_identity_switch_test.dart`、小程序 `test/next-stage.test.mjs` 追加 4 例、`test/runtime.mjs` 增加会话替身。

## 三、测试报告

环境：Windows + Git Bash；Node 22.22.2；一次性 PostgreSQL 17.11（容器 `medbox-pg-test`，宿主 `127.0.0.1:55432`，隔离 schema 跑完即 DROP）。

| # | 项目 | 命令 | 结果 |
|---|---|---|---|
| 1 | Lint | `npm run lint` | **PASS** |
| 2 | 类型检查 | `npm run typecheck` | **PASS** |
| 3 | 构建 | `npm run build` | **PASS** |
| 4 | 小程序测试 | `node --test test/*.test.mjs`（apps/miniprogram） | **PASS 51/51** |
| 5 | API 单元 | `node --test test/*.test.mjs`（apps/api） | **PASS 182**，2 个 PG 套件按设计跳过 |
| 6 | 工具脚本 | `node --test scripts/*.test.mjs` | **PASS 6/6** |
| 7 | 真实 PG 集成 | `TEST_DATABASE_URL=... npm run test:integration` | **PASS 19/19**（主套件）+ **3/3**（提醒套件） |
| 8 | Flutter analyze / test | `flutter analyze` / `flutter test` | **NOT_RUN**：本机未安装 Flutter SDK |

### 关键验收断言

- **A01/A02 往返保真**：真实 PG 导出 → 预览 → 恢复（先清空源数据）后逐字段比对药品名称/规格/厂家/批准文号/条码/成分/用途、说明书 6 字段、阈值、归档标记、批次（批号、日/月/未知有效期、数量、单位、包装换算、存放位置、开封状态与日期、开封期限、处置状态），仅允许 ID/版本/时间/审计字段变化。
- **已处理库存不复活**：handled 的 5 盒在恢复后不计入余量，`stockStatus = { ok, quantity: 4, unit: box }`（3 + 1）。
- **篡改即失效**：预览后修改任一药品的 `dispositionStatus`，恢复返回 409，不写入。
- **A07 反向验证**（确保测试非"假通过"）：临时禁用三处修复后，两个用例同时红灯，假发送器确实收到被移除成员的 openid（与审核复现一致）；恢复修复后转绿。
- **A07 语义**：成员在家庭内时正常收到 2 条；被移除/退出后重试任务被标记 `blocked/NOT_A_MEMBER`，其订阅授权 `consumed_at` 置位，发送器零调用。
- **A04/A12**：存储读写抛错时请求仍带 `Bearer` 头；退出同时清内存与持久令牌；A 家庭草稿在 B 账号登录后既不可见也不可恢复，且 B 的草稿落独立命名空间；旧版无归属草稿仅提示、内容不进入表单、文件不被删除。

### 未验证项（不冒充 PASS）

- **Flutter**：A03 代码改动与新增测试**未运行**，需在具备 Flutter SDK 的环境执行 `flutter analyze && flutter test`；A03 的 UI 层（运行期 401 统一失效、断网退出导航）本轮未实现。
- **真实微信 / 真机**：小程序页面运行、订阅消息实际送达、双账号双设备家庭试用、APK 构建与安装均未执行。
- **S2/S3/S4/S5** 全部问题（A05、A06、A08–A11、A13–A15 及缺失功能）仍待处理。
