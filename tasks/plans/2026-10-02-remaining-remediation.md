# 更新复审后的剩余修复实施方案

## 基线与目标

以主目录当前772acdc＋未提交H1为输入，先核对并保留实际工作区，避免使用文件状态不同的旧Flutter工作树。复审见 `tasks/reviews/2026-10-02-update-reaudit.md`。下列任务均待执行；本轮只审核，不实现。

H0数量模型、字段与备份保真、Flutter门禁已有进展，继续沿用。目标是修复H1回归和未覆盖入口，再完成原双端体验计划，不重写项目。

## S1：服药实例与历史（R01–R04/R06）

- [ ] 为活动实例建立唯一约束：新增后续迁移将旧(slot_id,dose_date)全局唯一改为superseded_at为空的活动唯一索引，物化INSERT使用相同谓词冲突目标。作废实例及事件完整保留；同slot作废后可生成新ID，A→B→A也可恢复。
- [ ] 编辑以服务端上海当前日历时间确定生效边界，仅作废尚未发生的未来pending；过去日期和今日已到点/已确认记录保留，不能用dose_date>=today代替未来。
- [ ] 今日及过去统一从实例快照投影；过去不筛当前计划active/星期/起止。仍按当前照护权限鉴权。缺旧快照明确不完整，不冒充当前值为历史。
- [ ] 作废实例的新确认409；已落库幂等重放返回原结果；历史纠正保留事件，不通过确认作废安排恢复它。
- [ ] 本人档案新增非空linked_user_id的家庭＋账号唯一索引与冲突回读；既有重复档案先预览、由本人确认归并计划引用，不级联删除历史。旧未关联本人档案同样不能按名字自动迁正。
- [ ] 019若已应用不可改checksum，追加下一编号迁移；评估创建者离家时的交接/归档，使创建审计与当前管理授权分离，重入不默认恢复撤销的管理权。

落点：API medication-plans、统一物化服务、实例/照护迁移、contracts及两端日程模型。

验收：改剂量同slot仍有1个有效新未来实例；A→B→A；作废确认拒绝；暂停/结束/改星期后历史仍可见；今天taken显示原快照；并发首次self只有1档案；两个物化worker只有1活动实例。真实隔离PG检查行、事件及响应内容，不仅接口200。

## S2：投递与授权状态机（R05）

- [ ] queued/尚未发送失败可取消并释放保留授权；sending仅标cancel_requested，不直接退还。成功后授权仍消费；不确定结果保留待核实状态，不重新复用。
- [ ] sender结果更新带attempt/lease条件；旧worker不能覆盖新状态。发送前再次核验有效实例/权限，跨过请求发送边界不能承诺撤回已送消息。
- [ ] 编辑、暂停、确认、撤销与离家统一调用同一取消入口；不能各自写不同退款SQL。
- [ ] 保持先唯一投递后占用授权的已修路径，独立设置提醒接收资格与查看/管理权限。

落点：dose-reminder-scheduler、订阅占用/投递契约及必要新迁移、计划/家庭操作。

验收：受控sender屏障下发送×编辑/确认/移除竞争；成功发送授权不退；旧结果不覆盖取消；多worker/重复10轮仅占1；模糊发送结果不重复通知。真实微信送达独立记录，假sender仅证明状态机。

## S3：所有数量与设置入口（R07–R09）

- [ ] 小程序详情阈值复用共享值/文案/精度表，毫升与板正确回读；切单位明确确认，零与未知分开。
- [ ] Flutter录入、新增、余量、阈值、盘点、拆分和补货修改统一按单位解析；计件初始文本12，ml最多3位小数。新单位必须出现在所有选择器，禁止initialValue找不到item。
- [ ] 盘点冲突提供“按最新数据重新核对”动作，更新版本并解除该行阻塞，保留未提交输入并展示差异。
- [ ] 增加旧客户端新单位写入保护与明确升级提示；不能仅改模型而默认已安装旧APK安全。

验收：12及12.5实际生产页面可提交，所有设置入口10ml保存仍10ml；0/未知/等阈值、拆分守恒、混合单位；冲突v1→刷新v2→核对后可提交v2。API和缓存字段继续全量往返验证。

## S4：会话、导航、草稿与导出（R10–R19）

- [ ] Flutter会话代次保护所有读取回填/缓存/通知；401/离家/退出统一失效。清理钩子失败仍确保令牌清除和导航，服务器撤销错误单独告知。
  - R10 · Flutter · 代码已写：`api_medicine_repository` 会话代次守卫所有回填/缓存写入；`api_auth_repository.logout` 分步清理各自 try/catch 并单独返回服务端撤销错误；`api_client` 401→`onUnauthorized`；`app_services` 挂钩失效；`my_page` 退出后仍导航到 `/connect` 并单独提示撤销未完成。**验证 NOT_RUN**：本机无 Dart/Flutter SDK，`flutter analyze/test` 未运行，仅括号平衡启发式核对，不得记为 PASS。
- [x] 小程序独立计划创建页承接药品身份，tab只负责列表；onShow刷新与日期请求代次保护，加载期间不确认旧实例。
  - R11/R12/R13 · 小程序 · **PASS（自动化门禁）**：新增 `pages/plan-create`（保存后 `switchTab`，绝不 `navigateTo` tab 页）；`medication-plans` 加请求代次＋`onShow` 合并刷新＋加载期锁定确认；`medicine-detail` 改走独立创建页。设备端日期乱序/午夜/tab返回走查留待 S5。
- [x] 全部模板选择状态/时间文字在TS预计算；更新前注册编辑状态，保存/放弃/继续，保存失败延期重启；草稿绑定账号/家庭/照护权限。
  - R14/R17 · 小程序 · **PASS（自动化门禁）**：`services/draft-guard` 注册表；`plan-create`/`plan-detail` 编辑态登记＋原生 `enableAlertBeforeUnload`；`app-update` 保存/放弃/继续三选、保存失败延期重启；`index.wxml`/`medication-plans.wxml`/`plan-detail.wxml` 的 `.indexOf`/`.join` 方法表达式改 TS 预计算。WCC 生成模板真机显示留待 S5。
- [ ] Flutter导出独立只读快照，绑定不可变选项/字节/扩展名/列；分享发出期间锁定，不把归档查询回填活动仓库。
  - R15/R16 · Flutter · 代码已写：`api_workflow_repository` 只读 `fetchMedicinesForExport`/`fetchDosageNotesForExport`（不碰共享快照）；`export_api_page` 用 `_ExportOptions`/`_ExportPreview` 绑定不可变选项↔文本↔扩展名↔MIME，`busy` 期间锁定 SegmentedButton/Switch/刷新；`local_reminder_service` 过滤归档；trash/restore 刷新改活动列表。**验证 NOT_RUN**：无 Dart SDK。分享格式/隐私乱序真机走查留待 S5。
- [x] 只读授权清单无权与空/失败区分；修正self测试替身并断言真实绑定语义。
  - R18/R19 · 小程序 · **PASS（自动化门禁）**：`care-profiles` 区分 403/网络失败/确实无授权，查看者只展示自身访问级别；`medication-plans.test` self 替身改 `ensureSelfCareProfile` 真实身份绑定语义并断言本人私有。

验收：日期乱序、tab返回/午夜、详情创建、旧请求晚到/401/断网退出、盘点重试、更新草稿恢复、分享格式/隐私乱序、WCC生成模板显示。小屏/大字体/键盘和连续点击分别走查。

### S4 门禁台账（2026-10-02）

- 源码身份：分支 `codex/flutter-ui-prototype`；S1/S2/S3 已提交（`268cf62`/`7987d77`/`7a94f50`）；S4 为 HEAD `7a94f50` 之上的未提交工作区 diff（Flutter 10 文件＋小程序页面/服务/测试＋新增 `plan-create/`、`draft-guard.ts`、`app-update.test.mjs`、`plan-create.test.mjs`）。
- 目录 `E:\project\medcial_box\apps\miniprogram`：
  - `npm test` → exit 0（tests 146 / pass 146 / fail 0）。
  - `npm run typecheck`（`tsc -p tsconfig.json --noEmit`）→ exit 0。
  - `npm run lint`（`eslint app.ts pages services typings --ext .ts --max-warnings=0`）→ exit 0。
- Flutter 门禁（`analyze`/`test`/`build apk`）→ **NOT_RUN**：`command -v flutter`、`command -v dart` 均无 SDK；R10/R15/R16 仅代码完成，无真实验证，记 NOT_RUN（非 PASS、非 BLOCKED）。
- 真机/真微信验收（code2session、两账号隔离、分享格式与隐私乱序、WCC 生成模板显示、小屏/大字体/键盘/连点走查）→ 本轮未执行，统一留待 S5 真实家庭试用。

## S5：双端功能与真实验收

- [ ] Flutter补四导航、照片标签筛选、照护与计划/今日确认/历史/权限、服药通知及精确闹钟权限、重启恢复、更新发行入口。
  - S5-B/C/D · Flutter · 代码已写，**验证 NOT_RUN**（本机无 Dart/Flutter SDK）：新增 `ApiPlanRepository`+`plan_models`，`AppServices.plans`；`production_shell` 升为四导航（用药计划 tab）；`PlansPage`（今日安排+服用/跳过确认，日期取服务端）、`PlanDetailPage`（暂停/恢复/结束携版本+编辑/历史）、`PlanFormPage`（建/改，星期原样保留）、`PlanHistoryPage`、`CareProfilesPage`、`CarePermissionsPage`；`CabinetHomePage` 人群/用途标签多选筛选 + 封面缩略图；`ReleaseNotesPage` + “我的→版本与更新”；`LocalReminderService` 到期+服药双类通知、`requestExactAlarmsPermission`/`exactAllowWhileIdle`、`setTodaySchedule` 回灌；AndroidManifest 加 POST/EXACT_ALARM/WAKE 权限（boot 接收器已存在）。15 个 Dart 文件括号/圆括号/方括号全平衡（启发式核对，非编译）。
- [x] 小程序补首页缩略图/位置/完整状态。
  - S5-A · 小程序 · **PASS**：`toCabinetItem` 预计算 locationText（去重/“等 N 处”）、openedText、isArchived；`loadCovers` 复用 `downloadLeafletPhoto` 按 coverPhotoId 缓存、coverToken 代次守卫；卡片重排含缩略图/状态行/位置行。门禁（`apps/miniprogram`）：`npm test` 149/149、`typecheck`、`lint` 全 exit 0。
- [ ] 小程序游客浏览、最近录入排序、10 份草稿、包装换算目标单位、库存药品选择、独立提醒接收人（本轮按用户选择暂缓；最近录入/独立接收人需后端 API/迁移，包装换算与既有“单位不自动换算”决定冲突，需单独定夺）。
- [ ] 当前状态台账改为“已提交/工作区候选/已验证/外部待验”，统一目录与后端地址；历史模拟器开发假网关记录不能升级成真实身份验收。
- [ ] 门禁逐条读取退出码：根lint/typecheck/test/build、严格PG、新增状态机/实例回归、Flutter analyze/test/build apk、官方编译及页面绑定验证。不得用最后一个命令成功掩盖前面失败。
  - **NOT_RUN（Flutter）**：无 Dart/Flutter SDK，`flutter analyze/test/build apk` 无法执行；S5-B/C/D 一律记 NOT_RUN，禁止记 PASS。小程序三项门禁本轮真实 exit 0。
- [ ] 两账号两手机确认真实登录/共享、相机扫码实样、计划提醒送达与点击、改期撤销、文件分享和更新；再独立HTTPS部署及数据库＋图片恢复演练。
  - S5-E · **BLOCKED（本机）**：无真机、无 AppSecret、本轮不碰生产/部署 → 无法执行真实微信/两账号/送达/部署/恢复验收；见 S5 交接清单交用户执行。

任何P1或测试失败停止完整候选发布。新增迁移部署前备份，失败保留原数据，不能自动回删快照字段。全部任务记录源码/未提交diff身份、命令、结果和PASS/BLOCKED/NOT_RUN；后续联网搜索、分析及健康档案继续排在核心修复之后。
