# S1–S4修复、提交与主分支核验

日期2026-10-02；实际审核目录 `E:\project\medcial_box`。本轮只审核和保存证据，未修改业务源码、提交、推送或合并。

## 结论

**四组工作都有本地提交，旧问题大部分已修；当前仍有残留，不能认定全部验收通过。七个新提交尚未推送，未合入main。**

### Git事实（本轮两次远端只读核实）

| 对象 | 提交 |
|---|---|
| 本地功能分支HEAD | `45bb7aa0dcf455ea5bc681102392cc2d46b039b2` |
| GitHub功能分支 | `19266580d93264f1a87643ab3bb4afcf31552d14` |
| 本地main与GitHub main | `ad6b31fcb4731c2c9944dd56c965bf868a99689c` |

`git ls-remote --heads origin main codex/flutter-ui-prototype`为实时远端事实，不只依据缓存的origin引用。`git merge-base --is-ancestor 45bb7aa main`退出1，且远端main仍为旧提交。未查询/断言是否存在待审PR；分支尚未合入的事实已经明确。

领先远端的7个本地提交：772acdc H0、268cf62 S1、7987d77 S2、7a94f50 S3、639813a S4、59b07da S5-A、45bb7aa Flutter计划/提醒。当前没有未提交的业务源码；有任务文档修改和AGENTS/overview/计划/报告等未跟踪文件，已保留。

## 四组修复状态

| 工作 | 本地提交 | 已改好的主要路径 | 未收口 |
|---|---|---|---|
| S1实例与历史 | 268cf62 | 同slot/A-B-A、作废实例新确认拒绝、过去快照、本人并发唯一 | 今日taken/skipped仍可能被当前状态/slot筛掉 |
| S2提醒授权 | 7987d77 | 唯一投递后占授权、发送取消请求、租约条件更新 | 旧blocked重复退款；不确定失败过期后退授权 |
| S3数量入口 | 7a94f50 | 两端药品/批次/阈值/拆分/Flutter盘点多数路径、小数和计件校验 | 小程序stocktake仍拒绝ml小数；CSV单位遗漏 |
| S4会话页面 | 639813a | 独立计划创建、日期代次/onShow、字段预计算、只读导出/冻结选项 | 409和取消丢草稿；身份失效/缓存/新增提醒联动还有竞争 |

上述四个提交均在本地HEAD历史中，但均未包含在当前远端功能分支或main里。新App界面已经有源码实现，不能再沿用“完全没有计划页”旧结论；实际页面/通知仍需专项测试。

## 本轮验证

- 根lint/typecheck/npm test/build：PASS。API193项含185 PASS、8可选PG SKIPPED；工具6/6；小程序既有测试通过。
- 严格真实PG：69/69（19+4+10+5+6+10+15），随机独立schema，未触碰现有业务库。
- Flutter test：47/47 PASS；Flutter analyze：4项info，无编译错误，但默认命令退出1（严格门禁未绿）。
- check:miniprogram：49文件中plan-create.wxss依赖检查失败，命令退出1。
- 已查明WXSS导入文件真实存在；从小程序根目录同时给官方wcsc传入plan-create与被导入样式，退出0。属于检查脚本未收集导入依赖，不能据此宣称页面实际无法编译。应修正脚本并做完整依赖/整包验证，不能忽略失败。
- APK构建、真机、真实微信身份/通知、远端部署NOT_RUN。本轮没有因测试通过而自动推送/合并。

证据在忽略目录 `.local-data/verify-45bb7aa/`：pg.log、flutter-analyze.log、wxss-dependencies.log、authorization-extra.mjs及JSONL。补充脚本使用真实API/生产数据库适配器/隔离PG＋合成身份和sender，无真实消息。

## 当前阻塞与修复意见

### V01 · P1 · 旧blocked投递能释放新投递授权

位置 `apps/api/src/jobs/dose-reminder-scheduler.ts:133-140`、`:351-368`。发送复核退款后保留旧subscription_grant_id，授权被另一投递重占后取消旧blocked，再次清consumed_at。

真实PG复现：新投递占用授权=true→取消旧blocked→同授权占用=false。修复：授权占用绑定具体投递/占用代次，释放必须CAS验证归属；退款后旧投递解除绑定，同事务保证只释放一次。补重用授权后取消旧投递的回归。

### V02 · P1 · 不确定发送结果过期后仍退款

同文件`:351-368`，领取包括failed/sending，但过期/权限失效/超过次数分支一概退授权，没有证明此前没有送达。

真实PG＋假sender抛“不确定结果”后消费=true；推进待尝试时间并进入超时复核，消费=false、cancelled1。修复：区分未发送与可能送达状态；不确定记录保留授权及核实状态，不复用或自动重发可能已送消息。租约保护结果覆盖不等于消费语义正确。

### V03 · P2 · 今日已确认记录因暂停/改slot而隐藏

位置 `apps/api/src/routes/medication-plans.ts:683,734,740,745`。只有过去日期采用历史投影，今天仍依赖当前active/日期/星期/slot。

真实PG确认taken后暂停：数据库仍1条taken，今日响应0条。修复：所有日期先读取已发生/已确认实例快照，再合并当前有效未来实例；改slot/星期/暂停不抹当天已确认记录。

### V04 · P2 · 小程序盘点遗漏毫升小数

位置 `apps/miniprogram/pages/stocktake/stocktake.ts:150`、`stocktake.wxml:22`。实际页面内存复现12.5ml，请求0次，提示填写真实余量，仍是整数校验/提示。

修复：使用共享单位解析，按批次单位验证和显示，覆盖盘点原始值/修改余量/冲突重试。

### V05 · P2 · 409和取消路径丢计划草稿

位置 `pages/plan-detail/plan-detail.ts:292-296`，冲突释放dirty guard、退出编辑并刷新；实际页面复现未保存剂量变回旧值。`pages/plan-create/plan-create.ts:236-238`取消先解除原生离开警告，实际复现无需放弃确认就返回。

修复：冲突保留本机输入与新版本差异，确认重新核对后再提交；取消有修改时保留/放弃/继续，明确放弃才清理。draft-guard目前仅引用登记，不是持久化草稿，不能将它宣称为所有离开场景可恢复。

### V06 · P1 · 新App日程提醒没有纳入身份清理

源码位置 `apps/flutter/lib/data/app_services.dart:68-76`、`local_reminder_service.dart:122/164`、`features/plan/plans_page.dart:42`。

清身份仅清库存/本机存储，没有清_today和所有通知；库存notify会触发使用旧_today重排。计划晚响应还在mounted检查前回灌。关闭提醒与旧重排也没有串行/代次保护，cancelAll之后旧任务可继续安排。

修复：统一提醒resetForIdentity与代次、串行重排，关闭/退出保证不再安排；每个await之后校验身份及enabled。补fake通知插件的退出、旧响应、关闭与并发重排行为测试，随后真机验证。

### V07 · P1 · 修改计划后App闹钟未同步

位置 `features/plan/plans_page.dart:91/244`、`plan_detail_page.dart:80`、`plan_form_page.dart:161`。push后未等返回刷新，IndexedStack保留旧列表；暂停/编辑/结束只刷新局部，服务端已取消的安排仍可能保留本地通知。

修复：计划变更通知统一repository/调度器，返回和回前台刷新；界面翻看历史日期与通知日程分开，不能把任意查看日期当_today提醒源。变更后的取消、新时间安排及跨日离线单独验收。

### V08 · P1 · 旧401/缓存写入仍可影响新会话

源码位置 `api_client.dart:178-182`、`api_medicine_repository.dart:52-53`、`app_services.dart:68-76`。401清理异步且未核对响应所属令牌，旧401可清新身份；缓存写入前守卫没有覆盖异步写期间身份切换，lastSyncedAt!也可能被清空。活动路由没有统一失效监听。

修复：请求/清理/持久写入均携带身份代次，清理按预期身份CAS，缓存按身份命名空间；401驱动当前界面回登录，不等待下次BootGate。补存储暂停及旧401晚到测试。

### V09 · P2 · CSV和Flutter历史显示遗漏新模型

`features/export/export_api_page.dart:516`单位表没有ml/blister，12.5ml会写成12.5份；应复用共享unitLabel。`models/plan_models.dart:188`历史模型漏药名/剂量快照、snapshotComplete、superseded，历史页显示当前药名/把作废pending当待确认；应保真接收和展示服务端快照。计划编辑结束日期目前没有清空动作，需补有限期→长期的UI路径。

### V10 · P1/隐私默认 · 锁屏通知含私人健康信息

`apps/flutter/lib/data/local_reminder_service.dart:133`默认拼接家人称呼、药名和剂量，不符合原计划的最少信息默认。修复：默认通用文案，点击鉴权后看详情；如以后支持敏感内容预览须用户明确选择。此项为源码确定的消息体，不是本轮真机截图证据。

## 下一步与合并意见

1. 优先修V01/V02授权归属和不确定结果；V06–V08身份/本地通知生命周期，防止S4被新通知侧链绕过。
2. 补V03今日快照、V04盘点单位、V05草稿、V09数据展示和V10默认通知内容。
3. 修编译脚本依赖采集及4个Dart info，重跑逐条门禁与新行为回归；新增App计划页面不能只靠旧demo测试通过。
4. 通过后审查当前文档/未跟踪文件，再按既有授权提交所需修复与资料、推送功能分支，审查完整diff后再合main。不要切分支时丢文档或全部stage混入所有者文件。
5. 合并后用实时远端SHA和祖先关系确认main包含最终提交；“push成功”不等于“merge成功”，上传体验版/部署亦分开验收。

本次没有执行第4/5步。当前建议 **CHANGES_REQUIRED，暂不合并**；四组本地提交存在这一事实不变。
