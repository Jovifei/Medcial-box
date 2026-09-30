# 2026-09-30 双端家庭药箱计划与代码审核

## 结论

**CHANGES_REQUIRED / PARTIAL**。47d36e30d091d68d4b5a6d5bf3ad346ef0ab2792 已实现大部分接口和页面，但存在数据恢复损失、身份隔离和交互状态错误，不能据既有绿色测试认定计划完整完成，也不建议直接进入真实家庭数据试用。

- 审核工作树：`C:\Users\Admin\.codex\worktrees\flutter-ui-prototype\medcial_box`，分支 `codex/flutter-ui-prototype`。
- 对照：`tasks/plans/2026-09-28-dual-client-inventory.md`、`tasks/todo.md`，以及会话中批准的完整双端计划。
- 主目录 `E:\project\medcial_box` 是较早的 main/ad6b31f，存在用户未提交的 tasks/status.md、tasks/todo.md；本轮未修改该目录。
- 本轮仅代码审阅、合成内存复现、现有自动化测试和本地健康只读检查；不修改业务代码，不运行迁移或真实消息，不操作手机、ECS或凭据，不提交推送。
- 下列“内存复现”使用合成身份/数据和假发送器，证明控制流，不代表真实微信或真机验收。“静态确认”指已核对实际调用链，未在设备上重现。

## 问题清单（按修复优先级）

### A01 · P1 · JSON 恢复静默丢失有效期和说明书

- 位置：`apps/api/src/routes/backups.ts:176`；`services/backup-snapshot.ts` 的 validateFamilyMedicineBackup；`apps/api/src/inputs.ts:152`、`:319`。
- 原因：备份校验已生成内部扁平类型（expiryValue/expiryPrecision、leafletPurposeSummary 等），恢复循环又调用只接受嵌套 expiry/leaflet 的 validateMedicineInput。
- **内存复现**：校验后 `{expiry:"2027-12-31",purpose:"purpose",source:"package"}` 再校验变为三项 null。不是来源文件缺字段。
- 影响：恢复成功提示下丢失包装期限、说明摘要和来源。现有恢复集成断言偏重记录数量，未核对往返全字段。
- 修复验收：内部类型只校验一次；真实 PG 导出→预览→恢复后逐批次、逐说明书字段一致，允许变化仅限新 ID/版本/审计字段。

### A02 · P1 · 已处理库存通过备份恢复“复活”

- 位置：`apps/api/src/routes/backups.ts:55`；`apps/api/src/repositories/batches.ts:251`；迁移 `006_inventory_lifecycle.sql:20`。
- **静态确认**：备份包含 handled 批次，但没有导出 dispositionStatus；恢复 INSERT 不写该列，数据库默认 active。
- 触发：未来日期、余量 5 的批次标为已处理后导出恢复；新记录重新参与正常库存与提醒。
- 修复验收：备份版本、验证器、恢复均保留处置状态；旧版缺字段制定兼容默认并在预览提示。不能通过删掉 handled 记录来假装无损备份。

### A03 · P1 · Flutter 切换身份/退出未清空内存库存

- 位置：`apps/flutter/lib/data/api_auth_repository.dart:86`、`:120`；`api_medicine_repository.dart:15`；`features/home/production_shell.dart:182`；`features/my/my_page.dart:165`。
- **静态确认**：授权新账号、退出只清持久存储；长期共享 repository 的 _medicines 没有清空。断网退出 finally 已删令牌，但异常使导航不到登录页。运行期 401 缺少统一会话失效流程。
- 触发：A 加载库存→退出→B 授权→B 库存请求失败，仍可能显示 A 的内存列表/详情；断网退出也会停留在旧家庭界面。
- 修复验收：统一身份切换清内存/持久缓存/草稿/通知；缓存绑定 userId+familyId；旧请求响应不能在切换后回填。A→B+离线、运行中401、断网退出均验证实际屏幕与仓库状态。

### A04 · P1 · 小程序新建草稿跨账号/家庭恢复

- 位置：`apps/miniprogram/pages/medicine-edit/medicine-edit.ts:103`、`:437`、`:473`；`services/api.ts:71`；`services/auth.ts`。
- **内存复现**：草稿键只有 medicine-edit-draft:new/药品ID，恢复只校验 schema/medicineId；新 Page 共享存储时得到 `NEW_FAMILY_RESTORED_DRAFT Family A private synthetic draft`。
- 影响：A 家庭表单可在 B 家庭恢复甚至保存。
- 修复验收：身份化草稿命名空间、归属校验和退出/换家庭清理；不能依赖新建药品没有ID就安全。

### A05 · P1 · 小程序“编辑批次”慢加载会误新增

- 位置：`apps/miniprogram/pages/batch-edit/batch-edit.ts:116`、`:251`。
- **内存复现**：编辑路由带 batchId，但初始 isEdit=false；只有请求完成 fillFromBatch 后才设编辑身份。延迟读取并保存，得到 `creates:1, updates:0, isEdit:false`。
- 修复验收：路由立即锁定操作类型/目标ID，加载成功前禁止保存；网络错误/404不得退回新增；延迟、失败、连续点击都不能产生额外批次。

### A06 · P1 · Flutter 盘点冲突刷新仍提交旧版本

- 位置：`apps/flutter/lib/features/pending/stocktake_page.dart:41`、`:73`、`:81`。
- **静态确认**：_load 使用 putIfAbsent 留住旧 BatchRecord，提交读取 line.batch.version；刷新 repository 不刷新 lines。
- 触发：v1 盘点→另一端改到v2→冲突→刷新→仍发v1；成功保存后再次提交也可能携带旧版本。
- 修复验收：按批次替换新版本快照，成功/冲突行分别处理，保留用户输入须明确重新核对；第二次提交实际发新版本。

### A07 · P1 · 移除成员后仍可能向其发送排队提醒

- 位置：`apps/api/src/jobs/reminder-scheduler.ts:102`、`:158`；成员移除逻辑未撤销 reminder_deliveries。
- **内存复现**：family_members 只含 current-owner，已排队 delivery 属于 removed-user；dispatch 返回 `{queued:0,sent:1,failed:0}`，假发送器收到 removed-user。
- 原因：新任务生成查询成员，旧任务领取只 JOIN users/medicines/batches，发送前不重验成员关系。
- 修复验收：撤销/离家取消授权与未完成任务，领取及发送前复查归属；已移除成员绝不调用发送器。

### A08 · P2 · 延迟重试不检查提醒所属日期

- 位置：`apps/api/src/jobs/reminder-scheduler.ts:159`、`:172`。
- **内存复现**：当前成员，2026-10-02 领取 9月30日生成的“30天”任务，截止10月30日，实际剩28天仍调用 sender，eventLabel 为“30天后到期”。当前模板不展示 eventLabel，但过时任务仍消耗订阅机会，未来模板也会收到错误事件标签。
- 修复验收：持久事件日期/期限版本，重试前验证当前里程碑；过期事件取消或重新归类；保留发送结果不确定的状态，不能声称端到端 exactly-once。

### A09 · P2 · Flutter 余量未知和取消动作混淆

- 位置：`apps/flutter/lib/features/medicine/medicine_detail_api_page.dart:75`、`:551`；`models/medicine_models.dart:202`。
- **静态确认**：关闭面板与“未知留空”都返回null，copyWith(quantity:null) 又保留旧量。
- 触发：5盒→清空保存仍发5；直接取消也可能触发无意PUT和版本/审计变化。
- 修复验收：区分取消、确认未知、确认数值；取消0写请求，明确未知写入null，0仍为明确耗尽。

### A10 · P2 · Flutter 含归档导出污染首页与通知缓存

- 位置：`features/export/export_api_page.dart:64`、`:267`；`data/api_medicine_repository.dart:27`；`features/home/production_shell.dart:109`；`data/local_reminder_service.dart:49`。
- **静态确认**：导出/恢复查询 includeArchived:true 替换共享列表；首页和通知未按 medicine.isArchived 排除。
- 触发：开启包含归档的 CSV 导出后返回首页，归档记录重现并可能重新排期通知。
- 修复验收：只读导出快照不改变首页仓库；查询口径隔离；首页/待处理/通知各自排除归档；导出前后活动库存及通知不变。

### A11 · P2 · Flutter 分享格式和内容可能错配

- 位置：`features/export/export_api_page.dart:164`、`:301`。
- **静态确认**：分享等待旧 previewFuture 后再读取当前 kind 命名；busy期间格式/选项仍可改。CSV循环也读取可变选项。
- 触发：慢网分享Markdown→切换CSV→以.csv文件名分享旧Markdown内容。
- 修复验收：冻结格式、全部选项、库存快照；等待期间禁用修改或使用不可变导出任务；断言实际分享文件名、字节及隐私选项。

### A12 · P2 · 小程序存储失败没有内存令牌兜底

- 位置：`apps/miniprogram/services/api.ts:55`、`:64`、`:108`。
- **内存复现**：getStorageSync/setStorageSync 抛错，storeToken后请求 getAuthMe，Authorization 为 MISSING。
- 修复验收：内存会话与持久存储同步，clearToken同时清除两者；读写失败、存储满和退出均验证请求头。现有注释“本次启动有效”与实现不符。

### A13 · P2 · 正常库存投影未统一

- 位置：`apps/api/src/domain/medicine-inventory.ts:115`、`:124`；`routes/reminders.ts:119`；`apps/miniprogram/pages/index/index.ts:36`、`:57`。
- **内存复现+静态链路**：quantity=0/threshold=1 返回 exhausted，但待处理只接 low；全过期批次被过滤后返回 unknown/null，混同确知无正常库存与原始数量未知。
- 小程序首页还把 handled 批次放入数量、最严重过期状态和最早日期；已处理后待处理列表消失，首页仍可报过期。
- 修复验收：活动库存共用投影；0、全排除、部分未知、未确认换算分开；耗尽仍提供补货入口；已处理历史只在详情显示。

### A14 · P2 · OCR 仍能覆盖用户明确清空/选未知的字段

- 位置：`apps/miniprogram/pages/medicine-edit/medicine-edit.ts:767`、`:782`。
- **静态确认**：仅用当前空字符串或日期精度unknown判断是否可填入，没有字段修改版本。识别飞行中用户清空错误药名/改未知，响应又填回模型值；按 batches[0] 写入还缺少稳定批次绑定。
- 修复验收：用请求代次+字段touched版本+稳定批次ID；显式空/未知属于用户修改，晚到响应不得覆盖。

### A15 · P2 · 候选填空导致说明书来源失真

- 位置：`apps/miniprogram/pages/medicine-edit/medicine-edit.ts:698`。
- **静态确认**：说明文本非空时不覆盖，但 leafletSource 在703行无条件改为 candidate.source。原手写/拍照内容可能错误归因于供应商。
- 修复验收：来源与内容一起替换/逐字段绑定；混合内容不能全部归为单一供应商；核对前预览来源变更。

## 计划落实矩阵

| 计划方向 | 当前判断 | 尚缺的闭环 |
|---|---|---|
| 双端身份、家庭与共享库存 | PARTIAL | 代码路径齐备；A03/A04/A05/A12；设备码缺设备名称/型号供核对；运行中会话失效统一处理 |
| 开封、拆分、低库存、盘点 | PARTIAL | 基本API及拆分已实现；A06/A09/A13；跨端日期/单位共用样例与真机操作 |
| 待处理、微信与Android提醒 | PARTIAL / BLOCKED_PLATFORM | A07/A08/A10；成员时间设置未实现；真实模板、送达/点击未验收；Android并行sync/cancelAll及冷启动点击还需专项验证 |
| 药品资料、说明书、扫码 | PARTIAL | 候选与私有图片已实现；A14/A15；照片存储不等于说明书OCR/摘要闭环；资料查询时间/原文来源持久关联待补；核对页选图缩略图缺失 |
| 连续拍照草稿 | INCOMPLETE | 最多10份队列、逐项核对/补拍/删除/恢复未实现；批次编辑缺离开保留/放弃/继续流程 |
| 导出、恢复、回收站 | CHANGES_REQUIRED | A01/A02/A10/A11；小程序CSV/PDF未实现；CSV缺库存/核对状态等字段；多格式尚非同一不可变快照 |
| 备份中的家庭设置 | DESIGN_GAP | 导出包含盘点设置，恢复有意不修改当前设置；这符合保护现有家庭，但不构成设置恢复。建议管理员预览中明确选择保留当前/应用备份，默认保留 |
| 本地缓存存储 | DESIGN_DRIFT | 实际 SharedPreferences JSON，而计划写本地数据库；可保留轻量方案但需确认容量、身份命名空间、原子更新与故障恢复，不能按字面勾选已采用数据库 |
| 正式账号/部署/家庭试用 | NOT_RUN / BLOCKED | 专用AppID、模板、供应商真实查询、DevTools WXML、相机扫码通知、双账号双设备、分享及HTTPS/ECS、备份恢复演练尚未关闭 |

不应再把剩余工作简化为“3项功能 + AppID”。上述已勾选功能仍有数据正确性缺口；AppID只阻塞真实微信联调，不阻塞本地代码修复。

## 本轮验证证据

- PASS：根 lint/typecheck/test/build；小程序47/47；API179项中178 PASS+1可选PG跳过；工具6/6；Flutter analyze无问题、test40/40。
- PASS（只读运行检查）：medbox-dual-stage API/DB healthy；13302 live=ok、ready=ok、database=connected。
- PASS（问题复现）：备份重复规范化丢字段；移除成员任务继续发送；过时任务继续发送；零库存/全过期汇总；小程序草稿跨归属、存储故障无Authorization、慢编辑错误新增。
- NOT_RUN（本轮）：严格真实PG、APK重建/安装、DevTools WXML/设备/供应商/真实微信消息、服务器备份恢复。本轮未把历史18/18 PG或APK构建当成新结果。
- 文档漂移：提交内status/plan仍写PG17/17，上一轮最终执行记录为18/18；本轮报告明确区分历史与当前，下一实施阶段统一修正台账。
- 所有复现使用合成数据/假网络与假发送器；未发送真实微信通知，未改持久家庭数据。

## 建议

先完成 A01–A07 的恢复/身份隔离/错误写入修复，再统一库存投影、异步表单和导出快照，之后补缺失功能，最后做正式账号与双机验收。详细可执行清单见 `tasks/plans/2026-09-30-candidate-hardening.md`。
