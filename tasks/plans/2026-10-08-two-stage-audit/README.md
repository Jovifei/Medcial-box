# JF小药箱两阶段代码审核与人工验收计划

状态：PLAN_READY / INITIAL_AUDIT；完整验收 NOT_RUN。分支：codex/two-stage-audit-20261008。
产品基线：f675416ced73b59144c1f3d327dcdc741608a84e。此分支先提交计划和证据，不修改业务源码，也不合入 main。

## 目标和阶段

1. **阶段一：Codex 本机测试与独立子代理代码审查。** 主代理冻结环境、管理安全范围、执行测试、复核发现和证据；子代理按单一模块独立审查真实调用链、负例及覆盖缺口。范围为小程序、共享 API、PG、照片/草稿、计划/提醒、导出/恢复、打包及必要 Android 对齐检查。发现问题先复现登记；本次不自动授权业务修复、部署或发布。
2. **阶段二：Jovi 人工使用和交互验收。** Codex 提供精确候选与一条一条可操作的测试卡，Jovi 使用两台手机验证相机、登录、中文日期、布局、共享、真实通知、分享及保数据升级。人工发现回到阶段一定位/修复/独立复审后再测，不让用户重复盲测。

“第二阶段代码 bug”审查按用户意图放在人工交互之前；正式第二阶段只做已通过安全门槛的真人/真机验证。两阶段各有结论，自动化通过不能替代人工验收。

## 资料与差异

A包132项、B包156项，共288条来源规格，存在重叠，不能称288个独立用例或已执行测试。保留原始ID和全文；以A:BASE-01 / B:BASE-01区分重名。[覆盖映射](coverage-matrix.json)逐项登记本机与人工子范围、变体、证据及缺陷，父项全部必测子断言通过才可PASS。

A审核de74a585，B审核f675416；A禁止混入旧PR2的说明是旧快照。目前main已含修正后的post-merge工具，不机械排除，分别视为STATIC_SYNTAX、SOURCE_ONLY，不算运行/升级证明。原方案、JSON和压缩包哈希见[sources](sources)及[provenance](provenance.json)。重复的人读用例表、压缩包、原始图和过程输出不提交，保留机器读规范与关键审核文档。

两个样本方案为A54张（30清晰/12困难/12边界）与B60张（30清晰、其余分层）。执行前冻结一个样本清单及覆盖映射，不能相加成114张已收集样本。药名等95%、正确精度/误填和p95目标属于待确认验收政策，不是已有产品承诺；标注由人独立完成，不可用模型输出当真值。重复识别只计运行次数，不增加独立样本数。

## 当前已经做了什么

- 两包内部清单完整性校验：A7项、B10项均匹配；不等于工程测试通过。
- 三个独立只读子代理分别审查A包、B包与当前测试/代码调用链。
- 在隔离f675416新构建API，执行经审阅的B局部契约探针：开启/关闭库存提醒均退出1，LOSS_RISK_REPRODUCED。实际页面方法+生产输入校验器运行，UI/API被stub；没有运行SQL/PG、设备或模型。[初始证据](initial-results.json)
- 既有全量测试数仅作f675416历史证据，本轮完整回归尚未执行；288条规格仍NOT_RUN。

## 阶段一执行顺序

| 工作包 | 目的/路径 | 执行与证据 | 失败或回滚边界 |
|---|---|---|---|
| L0 基线 | AGENTS、package、CI、版本、README；实际commit/tree/mini子树 | 新隔离worktree检出冻结提交；记录Node/npm/Flutter/PG/IDE/model版本及匿名配置摘要，git status前后 | dirty不覆盖；代码变化先提交再生成QA；环境未知标BLOCKED |
| L1 优先库存保真 | medicine-detail、api.ts、inputs、medicines路由/仓库、threshold测试 | 先AUD-01合成双批次+条码/标签+已软删除批次；开/关阈值、过期版本、跨家庭、并发、事务失败；实际路由和PG前后逐字段比较 | 当前局部契约FAIL；真实家庭此入口BLOCKED；保存失败现场，不清原库 |
| L2 完整回归 | apps、packages、scripts；当前package脚本 | npm ci → API/build → lint/typecheck → npm test；精准HEAD mini QA；source包门禁。命令逐条保留时间/退出码/数量，重复执行去重 | 失败不被后续命令覆盖；缺PG只阻塞PG子阶段，不阻塞独立回归 |
| L3 严格PG/恢复 | run-integration13套、migrations、backup Docker | 只新建本轮无生产权限专用PG及私照目录；TEST_DATABASE_URL核身份后REQUIRE_POSTGRES_TESTS=1、npm run test:integration；隔离Docker成对恢复 | 现有套件含TRUNCATE users CASCADE，未核隔离绝不能跑；异常仅清理有归属证据的资源 |
| L4 识别/异步/照片 | recognition routes/provider、medicine-edit、photo lifecycle、QA helper | 真路由、真实页面和实际模块；只在外部fetch/FS/平台边界注入超时、断流、413、迟到401/OCR、持久失败/删除竞争；盲测真实provider另列 | 不改模型/GPU/网络；不发送私照或转云服务；无驱动标BLOCKED(TEST_AUTOMATION_MISSING)，不改成人工责任 |
| L5 计划/授权/导出 | plans/reminders/exports、身份状态、Flutter store | 真PG幂等未知结果、权限撤销、提醒关闭、导出归属；旧serializer生成合成旧资料并重载当前store恢复 | static关键词和JSON自写自读不能标PASS；不卸载/清数据/使用连接码 |
| L6 UI/SDK/包/Android | date/time组件、四入口、生成副本、Flutter | 官方IDE/MCP编译隔离副本；边界尺寸/字体页面驱动；Flutter analyze/test/debug/unsigned release（双端影响时）；生成HTTPS副本执行release gate | 当前check:miniprogram-compile固定源码并先release gate，不能据退出结果称SDK编译成功；需适配候选参数/官方IDE路径。签名/真机另列 |
| L7 独立复审及交接 | 本计划/results/defects/verdict | 单模块子代理复审，主代理交叉核对发现；关闭前后同一断言；记录source/test-driver/hash及证据 | 不为了绿灯删QA树/helper指纹/未知组件守卫或负例；P0/P1未关不推进相关人工路径 |

每个工作包输出PASS/FAIL/BLOCKED/NOT_RUN/SKIPPED与范围；静态检查另标STATIC_ONLY，不能代替原用例整项结果。不适用须说明范围与依据，不用SKIPPED隐藏必测项。

### 独立代码审核任务包

| 子代理包 | 文件/接口边界 | 必须检查的不变量 |
|---|---|---|
| R1 库存写入 | detail/edit/batch、inputs、medicine/batch repositories | 仅阈值改变时保留批次及所有非目标字段；软删除/并发和过期version明确 |
| R2 登录与家庭 | auth/session、services/api/auth、family页面 | 真身份/权限与迟到响应隔离；不使用固定openid证明双用户 |
| R3 拍照/识别 | medicine-edit、recognitions、providers | 拍照告知与实际上传一致；加载解除；超大输入/响应、错误类别及人工字段保留 |
| R4 草稿/私照 | photo-file-lifecycle、queue、ownership/lease、Flutter store | 重启/删除/迟到writer不复活照片，不串家庭、不清新草稿 |
| R5 计划/提醒 | plan/dose/reminder路由/调度/客户端 | 丢响应安全重试；关闭、撤权和切家庭后不继续投递；实际通知到达另验 |
| R6 导出/升级/恢复 | exports、backup、serializer、session store | 原件归属与配额、成对恢复、保数据升级；正式证书/API配置单独门槛 |
| R7 页面/日期/包 | 四入口、共享组件、IDE/release脚本 | 中文和精度一致、长品牌规格不重叠、日期单位实际事件链；不以source gate冒充release |

只读审查先提交发现。缺陷复现与测试驱动可在隔离测试目录实现；业务修复需按授权范围另登记，功能取舍问Jovi。历史远端负责实现的流程保留，本阶段本地获授权负责独立审核/验证，未重新派发远端任务。

## 阶段二准入与人工配合

进入某条人工路径前须：对应P0/P1关闭并复验、无破坏真实数据风险、使用可证明版本的候选、真实HTTPS可用、两微信身份同服务、必要隐私告知/同意成立。尚无稳定HTTPS时仍可继续本机测试，人工登录路径BLOCKED；此前TLS失败不能当作当前长期状态，准备候选时重测。

Jovi只需：两台手机（Android/iPhone可分开连接）、测试微信账号、明确授权的脱敏包装照片、看到实际界面后确认权限与交互；无需每次升级手动导出，无需交出微信密码/AppSecret。Codex给出逐步操作、同步收集脱敏日志、SQL读回与证据，不笼统说“请测试”。[人工测试卡](human-checklist.md)

首次执行使用合成库存，不用真实家庭资料。真实图的目的地、预算和授权独立核对，不自动使用第三方模型。代码上传、提审、发布和后台法律声明分别由Jovi决定。

## 交付和停止条件

本分支计划交付：provenance、两原始矩阵、coverage-matrix、initial-results、defects、human-checklist、本README。后续每次运行新增证据记录，不覆盖首个失败，results与baseline/配置绑定。

最终交付分别回答：①本机自动化完成程度；②真人体验安全准入；③微信提审/发布准入；④Android正式分发准入。不能凭main合并、测试数、HTTP200或二维码标最终完成。每项必测变体非PASS/P0P1未关闭，相关门槛保持PENDING/BLOCKED。

停止：发现可能影响原数据库/私照/进程的目标身份不符立即停止该动作；外部权限拒绝不绕过；不删除未知资源、不reset/clean/stash/强推；其他独立合成工作继续。复验期间固定接口/存储命名空间/版本及配置，变更即重新核对。
