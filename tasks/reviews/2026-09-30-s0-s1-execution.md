# 2026-09-30 S0 + S1 执行记录（审核 A01/A02/A04/A07/A12/A03）

- 基线：`codex/flutter-ui-prototype / 47d36e30`，工作树 `C:\Users\Admin\.codex\worktrees\flutter-ui-prototype\medcial_box`。
- 输入：`tasks/reviews/2026-09-30-plan-code-audit.md`（CHANGES_REQUIRED）+ `tasks/plans/2026-09-30-candidate-hardening.md`（S0/S1）。
- 未改动主目录 `E:\project\medcial_box`；未推送任何提交；未触及手机、ECS、凭据。

## S0 · 备份恢复保真（A01/A02）— PASS

| 改动 | 文件 |
|---|---|
| 备份批次携带 `dispositionStatus`；新增 `BackupBatchInput` / `BackupMedicineInput`；预览新增 `handledBatchCount`、`settingsPolicy` | `packages/contracts/src/index.ts` |
| 导出写入处置状态；校验解析（缺省 active = 旧版兼容，非法值报错）；`ValidatedBackupMedicineFields` 类型 | `apps/api/src/services/backup-snapshot.ts` |
| `insertBatch` 增加 `options.dispositionStatus`，写入 `disposition_status` 列 | `apps/api/src/repositories/batches.ts` |
| 导出统一走 `createFamilyMedicineBackup`；**恢复不再二次调用 `validateMedicineInput`**；预览返回处置状态计数与"仅库存恢复" | `apps/api/src/routes/backups.ts` |

根因确认：备份校验已产出内部扁平类型（`expiryValue/expiryPrecision`、`leafletPurposeSummary`…），恢复循环又按外部嵌套格式解析一次 → 有效期/说明书/来源静默变 null；备份不含 `dispositionStatus` 且 `insertBatch` 不写该列 → 数据库默认 `active`，已处理库存"复活"。

## S1 · 身份隔离

- **A12 内存令牌兜底**（小程序，PASS）：`services/api.ts` 增加内存令牌镜像，`storeToken/readToken/clearToken` 三者同步；存储抛错时请求仍带 `Authorization`。
- **A04 草稿身份化**（小程序，PASS）：新增 `services/session-scope.ts`（userId+familyId 命名空间，内存镜像 + 生命周期）；草稿键改为 `medicine-edit-draft:<userId>:<familyId>:<entity>`，写入归属并在恢复时校验；旧版无归属草稿只提示不迁移（`draftForeign` + WXML 提示卡）；`loadMedicine` 固化身份后 `refreshDraftScope()` 重定位。身份缺失时草稿读写整体禁用（绝不退回全局键）。
- **A07 提醒成员复核**（API，PASS）：`blockDeliveriesForDepartedMembers()` 在每轮调度前作废孤儿任务并释放其订阅授权；`claimDeliveries` 带 `is_member`；发送前最后一道复核；`cancelDeliveriesForMember()` 在移除成员/退出家庭的同一事务内取消其待发任务与授权。
- **A03 会话隔离**（Flutter，代码已改、验证 NOT_RUN）：`ApiMedicineRepository.clearSessionSnapshot()`；`AppServices` 统一 `clearIdentityData()` 注入 `ApiAuthRepository.onIdentitySwitch` 与 `ApiFamilyRepository.onFamilyChanged`；退出/换账号/换家庭都清内存+磁盘；`logout` 服务端撤销失败也切到未登录态。

## 验证证据

| 项目 | 命令 | 结果 |
|---|---|---|
| lint | `npm run lint` | PASS |
| typecheck | `npm run typecheck` | PASS |
| 单元测试 | `npm test` | 小程序 51/51、API 182 PASS（2 个 PG 套件跳过）、工具 6/6 |
| build | `npm run build` | PASS |
| 真实 PG 集成 | `TEST_DATABASE_URL=... npm run test:integration` | integration-pg **19/19**、integration-pg-reminders **3/3** |
| Flutter | `flutter analyze` / `flutter test` | **NOT_RUN**：本机无 Flutter SDK（flutter/dart 均不可用） |

PG 环境：一次性容器 `medbox-pg-test`（postgres:17-alpine，宿主 55432，密码 medboxtest），未触碰现有 medbox 容器与数据；测试用隔离 schema 且跑完即 DROP。清理命令：`docker rm -f medbox-pg-test`。

## 认证方法（重要）

- A07 做过**反向验证**：临时禁用三处修复后，两个用例同时红灯（假发送器收到 removed-user 的 openid），恢复后转绿——确保测试不是"假通过"。
- A01/A02 往返测试对药品全字段（含说明书 6 字段、日/月/未知有效期、开封期限、阈值、归档、处置状态）逐项比对，只允许 ID/版本/时间/审计字段变化；并断言 handled 的 5 盒不计入余量（`stockStatus = ok/4`）。

## 过程中的环境约束（后续注意）

1. `auth/wechat` 限流为 **30 次/分钟且按客户端地址进程内共享**：integration-pg 套件已用满 29，新增登录会把最后的用例挤成 429。因此新测试要么单用户登录，要么放进独立文件（独立进程配额）。**不要为测试放宽产品限流。**
2. node:test 中把 `await t.test(...)` 嵌进另一个 `t.test` 内部会导致挂起（"Promise resolution is still pending"），表现为父/子测试 `cancelledByParent` 且耗时 ~10s。新子测试必须与既有子测试同级。
3. `DELETE /medicines/:id` = 归档（is_archived），`POST /medicines/:id/trash` = 回收站（deleted_at，不进备份导出）。
4. `npm run build --workspace @home-medicine/api` 报错时仍会 emit 部分 dist，排错时用 `npx tsc -p apps/api/tsconfig.json` 看完整错误。

## 未完成 / 下一步

- S2（编辑/盘点/数量/识别回填 A05/A06/A09/A13/A14/A15）、S3（导出与提醒 A08/A10/A11）、S4（连续拍照草稿、小程序 CSV/PDF、提醒时刻）、S5（双账号双机、部署）。
- A03 的 UI 层（运行期 401 统一失效、断网退出导航）未做；A03 改动需在有 Flutter SDK 的环境跑 `flutter analyze && flutter test` 验证，并补 A03 真机/Widget 层验证。
