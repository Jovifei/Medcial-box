# 2026-10-02 更新后深度复审

## 审核结论与代码身份

**CHANGES_REQUIRED / PARTIAL：H0明显改善，H1候选仍有回归，双端计划尚未完成。** 本报告替代上一轮针对edbc4f7的当前状态判断；旧报告作为历史证据保留。

- 当前主目录：`E:\project\medcial_box`，分支 `codex/flutter-ui-prototype`，HEAD `772acdc1e0c6f128deae482a3242a4f6c1b761f8`。
- 已提交：1926658开发者工具模拟器记录、772acdc H0数据保真修复。
- 当前未提交H1：dose-reminder-scheduler、invitations、medication-plans、服药提醒PG测试、小程序本人档案调用及services/api；新迁移019未跟踪。下面明确区分提交与工作区候选。
- 原Flutter工作树虽然同一分支HEAD，但文件/索引状态不同；本轮以主目录实际文件为准，不能拿旧工作树运行结果替代。
- 对照2026-10-01双端体验计划及2026-10-02上一轮修复方案。本轮不修改业务源码、既有测试或迁移，不提交，不改设备/平台/服务器；新增审核文档与被忽略的合成复现材料。原有overview.md、.flutter_tool_state和其他修改保留。

## 本轮验证

| 项目 | 结果与边界 |
|---|---|
| 根lint/typecheck/build | PASS |
| 小程序测试 | **97 PASS / 1 FAIL，共98项**；首次本人档案测试替身未跟新接口，整体npm test不通过 |
| API常规测试 | 185 PASS / 7可选PG SKIPPED，共192项 |
| 工具测试 | 6/6 PASS，单独补跑 |
| 严格真实PG七套件 | **62/62 PASS**（19+4+7+5+6+10+11），测试在medbox-pg-test:55432随机独立schema执行并清理 |
| 官方WXML/WXSS编译 | 47文件 PASS，不能证明模板表达式、导航和点击正确 |
| Flutter analyze | PASS，无问题；旧FamilyRecord导入错误已关闭 |
| Flutter test | **43/43 PASS**，不能推导尚未实现的App计划功能完成 |
| 补充真实PG | 确认同slot编辑丢安排、作废实例可确认、今日快照漂移、暂停隐藏历史、并发本人重复、发送后退授权；同时确认endDate:null清空与非法日期400已修 |
| 开发者工具历史实跑 | 已阅读1926658报告及步骤；是原生wx.login取code＋开发假身份网关＋真实本地API/PG的顺序链路 |
| APK/真机/真实微信身份与消息/供应商/远端 | 本轮NOT_RUN |

不能将组合PowerShell命令最后一次编译成功的退出码当作npm test成功；本轮明确读到小程序失败和退出码1。

补充材料：`.local-data/audit-update-20261002/pg.log`、`mini.log`、`extra.mjs`、`extra.jsonl`。extra脚本用真实API及生产数据库适配器，在隔离PG中采用假微信身份和受控sender；“复现断言成功”表示缺陷存在，不是产品PASS。

## 上轮问题的修复进展

| 上轮编号 | 当前复核 |
|---|---|
| B01模型/字段丢失 | 已提交修复：Flutter读写num/double、标签/条码及缓存往返已补；表单链路仍未全部适配，见R08 |
| B02整体录入 | 已提交修复：单位表对齐、小数校验、标签读写、单位确认；既有回归通过。详情阈值未同步，见R07 |
| B03库存计算 | 已提交定点汇总及耗尽补货修复，新增PG/规则测试通过 |
| B04标签备份 | 已提交v2标签/来源保真修复，PG回归通过 |
| B05重复消耗授权 | 未提交候选改为先唯一投递后占用授权，重复排队测试通过；发送竞争还未关闭，见R05 |
| B06改期旧提醒 | 未提交候选加入作废/slot复核；重新物化及发送边界有新回归，见R01/R05 |
| B07普通授权重入 | 未提交候选同事务删care_grants并取消服药投递；创建审计与固有权限仍耦合，需收口设计 |
| B08历史 | 未提交019增加快照，过去不重建；筛选及今天投影仍错误，见R03/R04 |
| B09并发日程500 | 未提交候选ON CONFLICT主要路径已改；不能因此忽略作废后唯一键冲突，见R01 |
| B10本人私有 | 未提交self接口绑定当前用户，页面已切换；并发幂等未完成，见R06 |
| B15Flutter门禁 | 本轮已验证关闭，analyze及43测试通过 |
| B16/B17结束日期/非法日期 | 未提交候选经补充真实PG确认：null真正清空、2026-02-31返回400 |
| B19未知日期排序 | 已提交修复，空日期先处理，升降序均置末 |
| B23已处理库存 | 已提交卡片/汇总口径修复；未因此推导全部双端筛选完成 |
| B11/B12/B13/B14/B18/B20/B21/B22/B24/B25 | 仍有对应残留，见下方R09–R18 |

## 当前缺陷：19组

P1 11组、P2 7组、P3 1组。P1阻止完整试用发布；源码确认与实测复现分开记录。

### R01 · P1 · 只改剂量后相同时间安排消失
- 位置：`apps/api/src/routes/medication-plans.ts:578`、`:710-720`；019未改变(slot_id,dose_date)唯一键。
- 真实PG：创建08:00→读今日1条→仅改剂量→今日0条。编辑将全部今日及未来pending作废；同slot再次INSERT撞旧唯一键，回读又排除作废行。A→B→A也有同类问题。
- 修复：保留历史，以活动实例唯一约束/版本化实例允许作废后创建新实例；只作废真正尚未发生的未来安排，不能把当天早已到点记录一并清掉。

### R02 · P1 · 作废安排仍可确认
- 位置：`apps/api/src/routes/medication-plans.ts:751-771`。
- 真实PG：R01旧occurrence已superseded，POST新幂等键仍200/taken。
- 修复：事务内核验实例有效性，新确认对作废实例409；已有幂等结果和允许的历史纠正单独处理。旧列表/乱序响应不能产生新确认。

### R03 · P1 · 暂停/结束或改范围后历史日程隐藏
- 位置：`apps/api/src/routes/medication-plans.ts:662-671`。
- 真实PG：昨天有记录，暂停计划后昨天日程从1条变0。进入past逻辑前先筛当前active、当前起止和星期，快照无法拯救被筛掉的数据。
- 修复：过去按既有occurrences查询并按当前权限过滤，不依据当前计划排程；暂停/结束不会抹掉历史入口。

### R04 · P1 · 今日已服用记录仍显示新药名/新剂量
- 位置：`apps/api/src/routes/medication-plans.ts:726-730`。
- 真实PG：taken实例快照保留旧药/旧剂量；改计划后今日响应却为新药/新剂量，还标snapshotComplete=true。
- 修复：今天和过去均读取实例快照；缺少旧快照如实显示不完整，不能把当前计划值称作历史事实。

### R05 · P1 · 发送与取消竞争退还已送出授权
- 位置：`apps/api/src/routes/medication-plans.ts:588-594`；`apps/api/src/jobs/dose-reminder-scheduler.ts:350-357`。
- 真实PG＋受控sender：投递sending时编辑计划，授权退还；sender随后返回成功，最终投递sent、consumed_at却为空。该授权可再次被使用，旧发送结果也覆盖了取消状态。
- 修复：定义发送不可撤回边界；sending只标取消请求，不直接退授权；结果按attempt/lease条件更新。仅确定未发送的占用可释放，不确定结果保留核实状态。

### R06 · P2 · self接口并发创建两个本人档案
- 位置：`apps/api/src/routes/medication-plans.ts:170-192`；care_profiles无家庭＋关联用户唯一约束。
- 真实PG控制两次SELECT完成后同时继续：201/201，两个不同ID。
- 修复：清查重复后新增非空linked_user_id的唯一约束，INSERT冲突回读；历史计划不得通过删除重复档案而级联丢失。

### R07 · P1 · 小程序详情阈值把毫升/板误改成片
- 位置：`apps/miniprogram/pages/medicine-detail/medicine-detail.ts:244-245`、`:324`、`:514-520`。
- 实际页面合成复现：10ml阈值加载为index0“片”，直接保存变10 tablet；小数阈值仍整数校验。整体录入H0修复未覆盖此入口。
- 修复：复用单位/精度表，正确回读ml/blister；切单位确认，单位不变时保留语义。覆盖所有设置入口。

### R08 · P1 · Flutter模型已double，表单仍int
- 位置：`stocktake_page.dart:59`、`:92`；`medicine_entry_api_page.dart:448-452`；`medicine_detail_api_page.dart:507`、`:519`、`:644`、`:699`；`api_workflow_repository.dart:183`（均在apps/flutter/lib对应目录）。
- 源码确认：12数量初始化成“12.0”，盘点int.tryParse拒绝；12.5录入/新增/拆分拒绝。阈值及新增批次菜单未包含新单位，ml阈值initialValue不在items可触发断言；补货修改仍int参数。
- 修复：全表单按单位解析、定点格式化，计件显示“12”而非“12.0”；菜单、阈值、盘点、拆分及补货同步。增加生产页面测试。

### R09 · P1 · Flutter盘点冲突后不能重试
- 位置：`apps/flutter/lib/features/pending/stocktake_page.dart:67`、`:86-88`、`:235-259`。
- 源码确认：serverChanged=true后提交拒绝，用户修改控件没有解除/重新核对动作；只能重开页面丢输入。
- 修复：显式接受最新版本并核对后解除该行阻塞，成功/冲突项分开处理。

### R10 · P1 · Flutter会话晚响应、401和断网退出未收口
- 位置：`apps/flutter/lib/data/api_medicine_repository.dart:36-41`；`features/my/my_page.dart:166-171`；`data/api_client.dart:183-194`；`data/api_auth_repository.dart:156-158`。
- 源码确认：清空后旧请求仍回灌；401仅报错；logout异常跳不到连接页。清理钩子自身抛错还可能中断后续令牌删除。
- 修复：会话代次守卫所有回填/缓存写入；清理步骤各自保证执行；本地退出进入未登录态，服务端撤销失败独立告知。

### R11 · P1 · 小程序换日期可确认错日期
- 位置：`apps/miniprogram/pages/medication-plans/medication-plans.ts:169-207`、`:297-327`。
- 源码仍与上轮已复现路径相同：没有请求代次/日期快照，loading也不阻止旧列表确认。
- 修复：旧响应作废，加载时锁定确认，提交前核对当前实例和日期归属。

### R12 · P1 · 详情创建计划仍navigateTo底部导航页
- 位置：`apps/miniprogram/pages/medicine-detail/medicine-detail.ts:796`，目标注册在app.json tabBar。
- 源码与上轮相同，平台导航方式不支持。模拟器从计划Tab创建成功不覆盖此入口。
- 修复：独立创建页接收药品身份，保存后switchTab；模拟导航替身遵守真实限制。

### R13 · P2 · 返回计划页不刷新
- 位置：`apps/miniprogram/pages/medication-plans/medication-plans.ts:156-167`。
- 没有onShow，详情返回/切tab/午夜保留旧内容。
- 修复：回前台和写入返回合并刷新，今日模式跨日更新，用户手选日期保持。

### R14 · P2 · 更新仍可能丢计划草稿
- 位置：`apps/miniprogram/services/app-update.ts:79-89`及两计划表单。
- 确认立即applyUpdate，未注册编辑状态/持久计划草稿，提示“先保存”不是保存措施。
- 修复：更新前保存/放弃/继续三选，保存失败延期；退出页面也保护草稿。

### R15 · P2 · Flutter归档导出污染首页与通知
- 位置：`apps/flutter/lib/features/export/export_api_page.dart:64-66`、`:267`；活动repository与local_reminder_service。
- CSV/恢复含归档查询仍覆盖主库存并触发通知；首页无额外归档过滤。
- 修复：独立只读导出快照，归档恢复查询不改变活动列表，通知过滤归档。

### R16 · P2 · Flutter导出格式和隐私仍有竞态
- 位置：`apps/flutter/lib/features/export/export_api_page.dart:164-185`、`:298-325`、`:82-137`。
- 等旧预览后读新kind；busy控件可改；CSV在await后读可变选项，可出现扩展名/内容或列数不一致。
- 修复：不可变选项＋数据＋文件元信息绑定；系统分享期间锁定控件。

### R17 · P2 · 原WXML方法表达式仍未清理
- 位置：`apps/miniprogram/pages/index/index.wxml:34-44`；`medication-plans.wxml:143`；`plan-detail.wxml:16`。
- 新录入chips预计算已做，但原.indexOf/.join仍保留上轮WCC运行缺陷：选中态/时间文本失真。编译通过不等于表达式正确。
- 修复：TS预计算，模板只读取字段，保留生成模板执行回归。

### R18 · P3 · 只读照护权限说明错误
- 位置：`apps/miniprogram/pages/care-profiles/care-profiles.ts:74-78`。
- 403/网络失败被吞成空授权列表，误显示“仅创建者可见”。
- 修复：读取无权、失败与确实无授权分开；查看者只展示自身访问级别。

### R19 · P2 · 新本人接口未同步客户端回归测试
- 位置：`apps/miniprogram/test/medication-plans.test.mjs:272-280`。
- 当前97/98，替身仍只有旧createCareProfile，页面改用ensureSelfCareProfile，测试失败。
- 修复：替身按真实接口身份绑定语义返回并断言本人私有；不能简单删测试或无条件返回private。

## 计划缺项与验收评价

1. Flutter仍三导航，无完整生产照护/计划/今日安排/确认历史/授权页面，服药本地通知/精确闹钟/重启恢复及版本发行入口未形成闭环。
2. 小程序仍缺首页照片摘要、游客“先了解”、完整状态与最近录入排序、连续10份草稿、明确包装换算目标单位、独立库存药品选择与独立提醒接收设置等。
3. 本人基本身份已改正确；历史错建“我自己”未迁正、创建者有效权限与created_by审计未分离。不能按称呼批量迁正，也不能自动把家庭管理员变成私有记录管理员。
4. 模拟器网关将任意code映射固定openid；报告证明页面/本地API/PG单身份顺序流程，不能证明真实微信code2session或两账号隔离。正式消息与设备权限仍需单独验收。
5. 状态文档同时保留“CLI可用”和“仍阻塞”、“全部自动化完成”和缺功能/失败门禁，需更新当前摘要。历史段落保留，但不得作为当前状态。
6. 两工作树同分支HEAD、文件却不同，后续运行/交付必须绑定绝对目录、HEAD＋未提交diff及构建配置。恢复到3000的源码配置和13300模拟器运行步骤应明确匹配，不能让用户导入旧目录/错误后端。

## 修复与发布意见

按配套 `tasks/plans/2026-10-02-remaining-remediation.md`：先收口实例生命周期和发送授权状态，继而贯通全部数量入口、会话与页面状态；补齐双端功能后再双机真实试用。H0通过不代表H1、H3或R3/R4完成。P1未关、npm test失败时不标记完整候选通过。

本轮只新增这两份文档及忽略的审核材料，不更改现有业务改动、暂存区或未跟踪迁移，不执行真实消息/安装/部署。
