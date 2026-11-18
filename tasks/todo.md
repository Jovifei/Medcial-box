# 当前任务：微信小程序参数与交互审核修复（2026-11-02）

## 2026-11-17 最终方案 T3 首项与 1.2.2 小程序上传

- [x] 按最终方案 v1.0 复核剩余项：T1 已完成；T2 合成测试完成、真机四步待业主账号/环境；T4 五家庭试点待参与人、账号与 1.2.2 体验资格。
- [x] T3 首项修复（M1）：首页刷新失败不再清空已加载库存，保留列表与筛选计数并显示「暂时无法更新药箱」降级提示；首次加载失败行为不变。新增 2 项回归。
- [x] 版本递增 1.2.2 / Android build 21；根 VERSION.json、小程序 APP_VERSION、Flutter pubspec 与版本说明同步，版本一致性检查通过。
- [x] 本轮验证：小程序 761 PASS / 0 FAIL；lint、typecheck 通过；隔离 QA 42 PASS / 1 SKIP；源码包 137 文件 893,048 字节；HTTPS 候选 137 文件 892,909 字节；官方 wcc/wcsc 59 文件编译 0 失败。
- [x] 微信开发者工具登录态有效（Jovi）；上传回执 `execution_success`，版本 1.2.2、包体 697,677 字节；手机预览推送 success。
- [ ] 待业主资源：T2 双机双账号真机四步（邀请/录入找药/识别失败手填/导出撤权）、T4 五家庭七天试点；体验版设置与平台审核由 Jovi 在微信后台操作。
- [ ] 本轮未改 API/数据库/家庭数据，未部署服务端，未合并 main，未使用真实药品数据。

### 1.2.2 候选身份

- 修复提交 `cd0dd85`、版本提交 `acc94f2`、台账 `78182fa`（分支 `codex/miniprogram-ui-integration-20261109`，已推送 origin）。
- 小程序树 `0b09793f7b9a45414531e05d9c0f7d82e0932cc2`，仓库树 `71ddd66aa2853a4975c488e01688a6713235db48`。
- HTTPS 候选目录 `.local-data/mini-staging-cac82c4d-167f-4365-a84b-20fdf0ccd828`，API 基址 `https://medbox.joviluma.com`。
- 上传描述「1.2.2候选：首页刷新失败保留上次库存并提示重试（M1）；版本元数据同步 1.2.2」。

### T3 第二项（320 宽 / 200% 字号）

- [x] 日期拆为独立不可断行片段并在 ≤360px 宽度下将余量/效期改为上下排列；筛选 chip 单行滚动；底部留白改为 6.5em；搜索占位缩短为「搜索药名或位置」。
- [x] 新增 5 项窄屏大字号回归；小程序 766 PASS / 0 FAIL；lint、typecheck 通过；源码包 139 文件 1,020,199 字节；HTTPS 候选 137 文件 894,158 字节；官方 wcc/wcsc 59 文件编译 0 失败。
- [x] 提交 `7a62ab4`；群内 #324 发出修复前后对比与结果，Muse 复核待回。
- [x] 自动跟进任务改为每分钟检查，并加入「不得修改 QA 白名单/安全门禁、不得并发修改」硬边界。
- [ ] QA 新源码树待独立审核后再登记；版本仍 1.2.2，未递增、未上传；分支提交按主会话授权推送。

### 1.2.3 发布候选与微信上传

- [x] 递增版本 1.2.3 / Android build 22；根 VERSION.json、小程序 APP_VERSION、Flutter pubspec 与版本说明一致。
- [x] 验证：小程序 766 PASS / 0 FAIL；lint、typecheck 通过；源码包 139 文件 1,020,487 字节；HTTPS 候选 137 文件 894,446 字节；官方 wcc/wcsc 59 文件编译 0 失败。
- [x] 微信上传 1.2.3 开发版回执 `execution_success`，包体 667,530 字节；手机预览推送 success（698,311 字节）。
- [x] 版本提交 `41ee063`，已推送 origin（分支 `codex/miniprogram-ui-integration-20261109`）。
- [ ] 体验版设置与正式审核由 Jovi 在微信后台操作；T2 真机四步与 T4 五家庭试点仍待资源。

### UI 设计规则与验收标准 v0.1 起草（Pachat #348，2026-11-17）

- [x] 读取群消息 #348（游标 347→348）：业主拍板将「设计令牌+参照清单」升级为全项目《UI 设计规则与验收标准》，指定 Claude Code 先出 v0.1 草稿，其他人独立补缺口、交叉互评后经 Muse 复核报业主终审。
- [x] 起草 `docs/design/UI_DESIGN_RULES_ACCEPTANCE_v0.1-20261117.md`，按业主建议七节：设计令牌（色/字/距/圆角/阴影，取现行两端代码实测值）、组件与版式规则（三栏分工/导航/状态/表单）、各端适配（小程序、Flutter、Web 桌面不拉宽移动版）、参照工作流（#346 四法）、验收清单（几何验证表、320–402 宽×100%/200% 字号矩阵、证据层级、门禁条目）；8 项待决集中在第 6 节差距表并逐条标【待业主拍板/待确认】。
- [x] 验证：根 lint、typecheck 通过；`node --test scripts/*.test.mjs`（test:tooling）262 项 188 pass / 45 fail / 29 skip——45 项失败均为存量：43 项为 QA 源码树 `c662757c` 待独立审核登记的在案待办（该哈希为 HEAD 已提交子树，本次 docs/design 新增不在 apps/miniprogram，不改变该树）、1 项 Windows tar 把 `C:` 当远程主机的环境问题、1 项本机缺 `age.exe`。小程序业务测试未运行（本次改动不在 apps/miniprogram，不触及）。
- [x] 提交 `bd1eecb`（中文标题「起草 UI 设计规则与验收标准 v0.1（Pachat #348）」，仅本地未推送；初稿提交曾为 `55276e5`，补记 SHA 后 amend 为现值，群内已勘误）；群内 #352 回复 #348。边界：纯文档新增，未改业务代码、未改 QA 白名单/门禁、未递增版本、未上传、未推送、未合并。
- [ ] 各端成员独立补缺口/反对意见 → 交叉评审收敛一稿 → Muse 复核 → 业主终审后固化 v1.0；8 项待决项需业主逐项拍板。

### Pachat 审核跟进自动任务（2026-11-17）

- [x] 读取群消息 #341–#346（游标 340→346）：#341 Jovi 附短视频截图问 modern-web-guidance 项目评价与 UI 借鉴；#343/#345 Jovi 群成员管理（本人操作，未介入）；#344 Jovi 附微信文章问 UI 优化借鉴。
- [x] 调研结论（已发群 #346）：modern-web-guidance 为谷歌 Chrome 官方真实项目、评价正面但数字自报，面向标准 Web 与 WXML/Flutter 双端不兼容；文章讲 21st.dev（React+Tailwind）组件超市，组件搬不进双端。可借鉴四条方法论：参照先行（设计令牌+参照清单）、候选收敛人拍板、窄屏大字号回归（T3 已有）、生成物过门禁再提交（门禁已具备）。建议不引入第三方工具，仅整理设计令牌清单为 UI 验收附件，待 Jovi 主会话拍板。
- [x] 本轮未修改任何文件、未提交、未递增版本；小程序工作树保持干净（HEAD `ffddadb`）。
- [x] MateLink CI 核查（群 #359 Jovi 本人确认授权，按 #167 转达的 12:51 批准方案；游标 358→362）：main 上 miniprogram 作业失败根因为 f2e0a8e3 把 `miniprogram/project.config.json` 的 `setting.urlCheck` 从 true 改为 false，taro 构建复制进 dist 后断言 `urlCheck===true` 失败。修复提交 `7d65fd53`（MateLink 分支 `codex/miniprogram-urlcheck-fix-20261117`，已推送）：恢复 urlCheck=true，保留域名校验。本地复现 CI 作业五步全过（npm ci / typecheck / vitest 1213 pass / build:weapp / dist urlCheck=true 断言）；该分支 CI run 44107314330 miniprogram 作业转绿。群内 #362 回执。verify（Go copylocks，main 同红）与 android（main 同红）为 #167 声明的范围外存量，未动；合并 main 不在自动任务边界内。matelink hub 已上报（event cb7ed2c8，revision 1）。

### B1 AI 中转云函数与 aiApi 封装

- [x] 新增 `cloudfunctions/aiRelay`（入参校验、模型白名单、`ai_usage` 日志、明确错误码）与 `services/ai-api.ts`，接入 `app.ts` 启动初始化；新增 8 项回归。
- [x] 云环境 `yaoxiagn-d2goac4i31a1c8485` 创建 `ai_usage` 集合；`aiRelay` 部署成功，Active、超时 60 秒、Nodejs16.13。
- [x] 虚构文本联调：`deepseek-v4.1-flash` 返回「虚构联调通过」，usage 129 tokens，耗时 2,062 ms；`ai_usage` 回读 1 条 ok=true。
- [x] 验证：小程序 774 PASS / 0 FAIL；lint、typecheck 通过；源码包 140 文件 1,024,725 字节；B1 候选 138 文件 898,684 字节。
- [x] 提交 `c7f94cc` 已推送；回执见 [B1 回执](../../docs/product/medbox-ai-b1-20261117.md)。
- [x] B2 药品说明摘要接入详情页已完成；版本递增、上传与额度控制台数值核对待后续。

### B2 药品说明摘要接入详情页

- [x] 新增 `services/ai-summary.ts` 与详情页「AI 说明摘要」卡：用户主动生成、加载/错误/重试态，固定标注「AI 生成，请以说明书为准」；不自动调用、不发送家庭/账号/私人备注。
- [x] 真实联调：虚构氯雷他定资料 → `deepseek-v4.1-flash` 返回 41 字摘要，usage 440 tokens，耗时 3,344 ms；`ai_usage` 回读 2 条均 ok=true。
- [x] 验证：小程序 778 PASS / 0 FAIL（新增 4 项）；lint、typecheck；源码包 141 文件 1,031,330 字节；B2 候选 139 文件 905,289 字节；官方编译 59 文件 0 失败。
- [x] 提交 `5d64aa3` 已推送；回执见 [B2 回执](../../docs/product/medbox-ai-b2-20261117.md)。
- [ ] C1 后端识图接口与 provider 配置、C2 拍照回填与人工确认待执行；版本递增与上传待业主确认。

### C1 MoMA 识图 provider 与 72B→32B 降级

- [x] 沿用现有 `POST /api/v1/recognitions/medicine` 契约；新增 MoMA OpenAI-compatible provider 与 `FallbackMedicineRecognitionProvider`：72B 在限流/5xx/超时后自动切 32B，格式错误不降级。
- [x] 配置 `MEDICINE_RECOGNITION_PROVIDER=moma`、`MOMA_BASE_URL/API_KEY/MODEL/FALLBACK_MODEL`；compose 与 env 示例、readiness 检查已补。
- [x] 验证：API 全量 316 pass / 31 skip / 0 fail；识别专项 16 pass；lint、typecheck 通过。
- [x] 提交 `ec40a6e` 已推送；回执见 [C1 回执](../../docs/product/medbox-ai-c1-20261117.md)。
- [ ] 真实 MoMA 调用待私有环境配置；C2 前端拍照回填流程已存在，单账号虚构标签自测待 API 部署与业主确认；版本上传待确认。

### C2 拍照回填与人工确认自测（TokenHub 视觉模型）

- [x] 业主提供 TokenHub 端点后，按可用模型改用 `hy-vision-2.0-instruct` 主模型与 `hunyuan-t1-vision-20250916` 后备；解析器兼容 `<answer>`/代码围栏，超时 45 秒。
- [x] 虚构标签图（测试药品甲 / 10mg × 12片 / TEST20261117 / 2027-06-30）经真实 TokenHub 模型识别四字段全对；API 返回 `requiresConfirmation: true`、零数据库写入、3,093 ms。
- [x] 验证：API 全量 320 pass / 31 skip / 0 fail（351 项）；识别专项 20 pass；lint、typecheck 通过。
- [x] 提交 `c66d9a7` 已推送；回执见 [C2 回执](../../docs/product/medbox-ai-c2-20261117.md)。
- [x] 本机隔离部署完成：dev-simulator-server 13310 + 真实本地 API/QA PostgreSQL + 开发微信网关 + TokenHub；登录 200、建家庭 201、识图四字段 4,799 ms、识别后药品数 0、人工确认后 1。
- [x] 小程序实机模拟器登录「AI自测家庭」并显示 1 种药品；详情 AI 摘要实时生成（资料不足时不编造）；截图 `c2-live-home.png` / `c2-live-detail-summary.png`。
- [x] 说明：照片选择器未做 UI 自动化；识图走同一 API，前端回填/确认由 778 项测试覆盖；未部署生产/测试服务器、未使用真实数据。
- [x] 生产 API 部署完成：f4ec101 / medbox-api:1.2.3-f4ec101，health 200、DB 基线不变、旧镜像保留；TOKENHUB_* 私有注入。
- [ ] 1.2.4 上传/预览（确认中）、实体设备单账号流程、第二账号验收与额度控制台数值核对待后续。

### 小药箱 UI/交互/数据逻辑修复（清单 #1–#10）

- [x] 共享单位表与 quantityUnitShort：盘点、补货、首页统一中文单位；未知枚举显示「单位待核对」，不回落「份」。
- [x] 统一「已用完」；计划页「全部」空态改「还没有用药计划」；首页余量去掉「数量：」前缀；月精度加「按包装月份」。
- [x] 待处理折叠标题 48px + aria-expanded；盘点保存按钮 disabled 视觉态；详情修改余量遮罩点按关闭且保护未保存输入。
- [x] 计划页底部留白改 6.5em；320 宽/200% 合成截图显示安全提示在按钮上方。
- [x] 验证：小程序 789 PASS / 0 FAIL；typecheck、lint；源码包 142 文件；UI 修复候选 140 文件 907,809 字节；官方编译 59 文件 0 失败。
- [ ] #5/#9 微信原生触控/键盘证据待补；群审通过后再递增版本并上传（建议 1.2.5），未通过前不上传。
## 2026-11-16 小药箱群内讨论

- [x] 核对公开仓库、核心需求与双端最近的交付回执。
- [x] 以独立临时 Codex 身份加入指定的项目讨论群。
- [x] 整理讨论稿，覆盖使用流程、执行验收、界面体验和推广，核对公开链接和证据范围。
- [x] 在群内发送自我介绍和讨论稿，核验服务器回执。

### 群聊反馈跟进与执行计划

- [x] 核对讨论稿和后续讨论，确认群内当前反馈范围。
- [x] 核对可复用的交付、真实设备与验收材料。
- [x] 产出按优先级排列的执行计划，标出群内事实、建议和验收门槛。

复核结果：群内目前收到收稿和后续组织讨论的回复。另行交付本地执行计划，建议先验证两账号双机家庭流程，再按试用卡点修界面，最后以小规模家庭试用决定推广。计划含分工、通过标准、停止条件与试用记录口径，尚待实际试用验证。

- [x] 已在原群讨论线回帖并附执行计划，复核消息与附件送达。群里后续提出先补双端现状与 M1–M5 证据对照，已在回帖说明认同的验收方向。

### 讨论发起回执

- 项目介绍、公开仓库和 Markdown 讨论稿已发至指定协作群，服务端回读的附件与本机稿内容一致。
- 讨论稿引用 11 月 10 日交付回执，保留开发版、测试包装机和真实业务验收的证据边界。家庭试用及推广指标为讨论提议。

## 2026-11-10 微信小程序更新验证

- [x] 固定本地已验接收提交 `5a194002bb6f199939f02cd4df3c1812e9d71982` 及精确小程序树。
- [x] 从精确提交生成 HTTPS 候选包，核验包摘要和官方 WXML/WXSS 编译。
- [x] 以 `5a19400` 快进远端 main，核对同提交的四项主线 CI。
- [x] 核对微信登录账号及目标小程序权限，完成 1.2.1 开发版上传。

### 微信候选复核

- `5a194002bb6f199939f02cd4df3c1812e9d71982` 生成 1.2.1 HTTPS 候选，包 SHA-256 为 `6cbd1b20f87c396f22a012a1ff053a7ce0a0b4e498919660cf2458cb4f71ff75`。138 个文件通过候选包校验，官方 wcc 29 份与 wcsc 30 份全部通过。编译后再次校验包摘要。
- 独立候选分支的 [同 SHA CI](https://github.com/Jovifei/Medcial-box/actions/runs/42651995969) 四项通过。该候选没有 API 代码或迁移差异。当前 HTTPS 服务 ready 为 1.1.3。
- 微信登录仍过期。扫码任务返回 `Task not found`，重开返回 `terminated`。实时 `main@3a9afef` 尚未包含候选，按[微信验收 SOP](../apps/miniprogram/docs/16-SOP-微信后台设置与真实验收清单.md)补齐登录和主线同 SHA CI 后上传开发版。微信后台与真机另验。

### 主线候选与上传回执

- 小程序候选 `5a194002bb6f199939f02cd4df3c1812e9d71982` 已快进远端 main。main 的 [同 SHA CI](https://github.com/Jovifei/Medcial-box/actions/runs/42830052152) 四项通过。
- 旧包根目录额外放入了验证回执，触发文件集校验。从同一提交重建干净候选后，138 文件与原包摘要一致，本轮 29 份 WXML、30 份 WXSS 官方编译通过并再次校验包摘要。回执单独存放。
- Jovi 完成扫码登录后，已核验账号能管理目标小程序。Jovi 在微信开发者工具确认上传，原任务回执为 `execution_success`，1.2.1 开发版包体 666,262 字节。

## 2026-11-09 Windows 双端 UI 接收计划

- [x] 确认同仓分端。App 使用 `E:\project\medcial_box`，小程序从 `E:\project\medcial_box-miniprogram` 打开同仓的 Codex 工作区。
- [x] 将小程序远端 `b9467bfc854c740e177c37ca18557f69959f9011` 接收到 `codex/miniprogram-ui-integration-20261109`，保留网页端同 SHA CI 证据。
- [x] 整理公共索引、小程序专属回执与端内索引。验证引用和打包排除项，独立核对文档整理后的精确子树，再登记到隔离 QA 白名单。
- [x] 提交小程序接收结果并验证版本、源码门禁、业务测试与隔离 QA。
- [ ] 小程序接收通过后，从 App 本地 `7ecc7b3dd30e81b1c8d6bee533e076dde3e1b07b` 开集成分支，合入 App 远端 `b8eecaeb894b1f791e45b2584be83beeb5189d2b`。核对重叠入口、补齐 App 专属文档并运行 Flutter 验证。
- [ ] 记录实际检出、提交和复验结果。微信后台、签名安装、保数据升级、真机和发布分别取证。

下方 11 月 9 日网页端台账记录远端执行环境的交付状态。Windows 工作区已核实本地 App 功能提交存在。

### 小程序本地接收复核

- 本地接收与文档提交为 `db463be9f55669caf4adfa1bb601f2c9a810e6cd`，精确小程序树为 `597c2950579ac04540ca52970deb15a9d81931ba`。相对远端小程序树仅有端内文档差异。
- 该提交通过本地 lint、版本一致性、源码包门禁、业务测试（759 通过，0 失败，0 跳过）和隔离 QA。核对公共与小程序索引 29 条相对链接。
- [原 UI 分支验证回执](../apps/miniprogram/docs/MINIPROGRAM_VALIDATION_20261109.md) 记录远端源码与独立复核。微信开发者工具视觉检查、微信后台与他人真机按原门槛取证。

## 2026-11-09 双平台 Apple 风 UI 分支优化

- [x] 实时核对 `main@3a9afefe3fcae0f5a827a728c7b71faa5fec102a`，建立独立 App 与微信小程序工作区。
- [x] 保留“药箱 / 用药计划 / 我的”三栏、中文紧凑字号和全部原有业务入口，分别优化筛选、状态反馈与平台布局。
- [x] 设计原则、源码功能清单、平台差异和分支接入方法写入 [本轮交付说明](../docs/design/APPLE_UI_DELIVERY_20261109.md)。
- [x] 提供可点击的 HTML 设计参考；Figma 新文件为空白，因 Starter MCP 额度耗尽尚未回填。
- [ ] `codex/flutter-app-parity@7ecc7b3…` 两个本地提交尚未取得，不能标记与本轮合并完成；待该分支推送后按交付说明合入并复验。
- [ ] 官方微信渲染、真实设备、签名及保数据安装按原门槛核验；历史 902 PASS / 19 SKIP 不计作本轮结果。
- [ ] Windows 本机 Hub wrapper 在当前执行环境不存在，revision 读取失败；待本机生成正式上报事件，状态保留在设计目录 pending JSON。

各端最终测试与提交结果以各自 `docs/design` 交付回执和独立 PR 为准。本轮不复用旧 Draft PR #7，不改变生产服务与版本号。

## 2026-11-07 文档归档与本机大清理（Jovi 授权，grill-me 逐项确认）

- [x] `.local-data` 7.6GB→2.3MB：删除 10 月审计/交付副本（含 4 个内嵌 detached worktree）、旧 QA/mini 隔离包与 candidate 日志；保留 logs/、medicine-catalog/、ide-verify-20261107/ 截图、staging-target.json、现行 mini 两个隔离包与 hub-pending-20261023.json（Hub 上报契约要求保留）。
- [x] 删除 3 个已合并分支的 worktree（C盘 flutter-ui-prototype、medbox-pr6-local-repair、medbox-ui-simplify）及本地分支；`codex/archive/local-delivery-handoff-20261008` 未合并仍保留。
- [x] 删除 var/（bug dump 脚本+1.1.2 部署草稿）与 demo-output/；reports/ 候选 JSON 保留。
- [x] 删除工作树历史文档：`docs/operations/archive/` 45 篇、`tasks/plans/`、`tasks/archive/`、`tasks/reports/`；README/status/operations 索引/17-ARC/lessons 断链已修复并注明 git 历史可查（`3096197` 及之前）。

## 2026-11-07 分支与文档清理收尾（Jovi 授权）

- [x] 远端删除 4 个已合并分支：`ui-stage1-closeout-20261031`、`medbox-home-archive-20261028`、`ui-overhaul-p0-20261026`、`muse/medbox-health-build-info-20261105`。
- [x] 本地删除 8 个已合并分支；保留 `codex/archive/local-delivery-handoff-20261008`（唯一未合并历史）与含未跟踪本地产物的 `codex/medbox-pr6-local-repair-20261024`、`codex/ui-simplify-20261025`、`codex/archive/flutter-ui-prototype`。
- [x] 移除 6 个干净 worktree 并 prune 4 个失效记录；8 个含未跟踪产物的 worktree/目录按安全规则保留未强制删除。
- [x] 历史文档归档：52 篇 01–59 期回执/计划/交接移入 `docs/operations/archive/`，根目录仅留 15 个有效文档 + 索引 `docs/operations/README.md`。
- [x] 全量 Markdown 相对链接校验：移动相关断链全部修复（docs/README、根 README、flutter README、overview、status、todo、lessons、archive 内部）；仅剩 3 条移动前即存在的本机证据绝对路径。
- [x] `npm run test:tooling` 通过（232 PASS / 0 FAIL / 30 SKIP，与基线一致）。
- [ ] 待 Owner：关闭陈旧 Draft PR #7（其 head/base 分支内容已全部在 main，关闭后可一并删除 `codex/medbox-fix-batch-20261025` 与 `codex/medbox-106-p1p3-20261023`）。

## 2026-11-07 项目阶段收尾（Jovi 确认"该做的已做完"）

- [x] 主线与远端一致：`main` = `origin/main` = `54157bb`，工作区仅余 `AGENTS.md` 本机 Token 控制规则，本轮一并入库。
- [x] 管道结论：CI 门禁以 PR HEAD 为准——PR #12 HEAD `ac8c10c` 四项全绿（run 41982343649）；merge 提交与纯文档提交不重复触发 CI（与 PR #11 行为一致）。
- [x] 线上运行确认：`/api/v1/health/ready` 200，`version=1.1.3`、`build=f29742b…`、`database=connected`；数据基线此前已复核无损。
- [x] 200% 字号模拟器验证：维持 NOT_RUN，原因记录为桌面自动化与 Owner 前台窗口冲突风险（见 2026-11-02 教训），非工程阻断；小程序 320/327/402 宽渲染已实测通过。
- [ ] 仅剩 Owner 平台动作：微信后台把 `1.1.3` 开发版本设为体验版/提交审核发布；不属于 Agent 可越权执行项。
- [x] 本节后 Hub 收尾报告按 AGENTS 规则提交；若连接失败保留 pending JSON 并如实报告，不自动重试。

## 2026-11-07 最新代码拉取、管道核验与 API 版本巡检上线（已完成）

- [x] 拉取远端最新代码：PR #12 `muse/medbox-health-build-info-20261105`（源码提交 `ac8c10c`，健康接口回报版本与构建 SHA）。
- [x] 核对同 SHA 四项 CI（run 41982343649）全部成功；合并至 `main`（合并提交 `f29742b`），推送 `origin/main`。
- [x] 服务器只读基线核对：2 家庭、11 药品、11 批次、22 照片、37 迁移；源码 tar 本地/服务器 SHA256 一致。
- [x] 服务器从精确源码构建 `medbox-api:1.1.3-f29742b`；BuildKit 并发 npm 异常改顺序构建成功，镜像内注入版本与 SHA。
- [x] 仅重建 API 容器（DB/私照卷未动），Compose 备份 `compose.yaml.bak-20261107-f29742b`，旧镜像保留可回退。
- [x] 公网健康接口确认版本巡检生效：`/health/ready` 返回 `version=1.1.3`、`build=f29742b…`、`database=connected`。
- [x] 数据完整性复核保持：2 家庭、11 药品、11 批次、22 照片、2 用户、3 成员、37 迁移。
- [x] 形成 66 号回执：`docs/operations/66-RECEIPT-主线更新与API版本巡检上线-20261107.md`。
- [ ] 体验版/正式发布仍按微信平台规则由 Jovi 后台操作；200% 大字号模拟器验证待无冲突窗口补做。

## 2026-11-03 体验版发布与主线合并（已完成）

- [x] 微信开发者工具扫码登录完成，登录态已有效（`loginExpired=false`，用户 Jovi）。
- [x] QA 模拟器渲染修复通过全套测试并中文提交：`53048f2 修复QA工程模拟器配置模块与AppID身份校验`。
- [x] 推送分支并触发 PR #11 CI（run 41468901370，四项 verify / backup-docker / flutter / candidate-delivery 全绿）。
- [x] 分支合入 `main`：合并提交 `cd62a62`，已推送 `origin/main`；PR #11 在 GitHub 标记已合并。
- [x] 官方编译与包门禁：从 `cd62a62` 生成独立 HTTPS 候选包，`check-miniprogram-package` release 模式通过；官方 `wcc`（29 WXML）和 `wcsc`（30 WXSS）编译通过。
- [x] 微信体验版上传成功：版本 `1.1.3`，包大小 648,321 字节；自动预览推送成功；本地预览码存 `E:\Claude_allow\Download\medcial_box\preview-1.1.3-cd62a62.png`。
- [ ] 正式上线审核：需 Jovi 在 mp.weixin.qq.com 后台将该开发版本设为体验版，并按需提交平台审核。

## 2026-11-02 QA 模拟器渲染修复（PR #11 收尾）

- [x] 官方模拟器实测确认 QA 工程硬编码 `touristappid` 触发 `APPID_ERROR`；真实渲染又暴露 `app.js` 直接 `require('./qa/config.json')`，微信运行时拒绝 JSON 模块导致首页空白。
- [x] 最小修复（仅 scripts）：`prepare-miniprogram-qa.mjs` 同步生成 `qa/config.js` CommonJS 模块并要求运行时依赖校验只接受 `.js`；`app.js` 改加载 `config.js`；保留 `qa/config.json` 作为人工审阅文件。
- [x] 新增回归：模拟器 AppID 身份必须与 QA 配置一致（`wx…` 或 `touristappid`）；测试夹具禁止 JSON require 以还原官方运行时；生成产物断言使用 `config.js`。
- [x] 完整门禁：lint/typecheck PASS；小程序 755 PASS、API 311 PASS/31 SKIP、工具 232 PASS/30 SKIP；QA 套件 42 PASS/1 SKIP；发布门禁继续拒绝 QA 工程（QA-only build 负例保留）。
- [x] 官方模拟器真实渲染：登录页、首页在 iPhone 17（402 宽）与 HUAWEI Pura X 外屏（327 宽）均完整渲染，console 无 error；登录→首页导航可用。截图存 `E:\Claude_allow\Download\medcial_box\pr11-qa-2eafcf7\`。
- [ ] 200% 字号官方模拟器检查未完成：桌面自动化与 Owner 正在使用的窗口发生句柄冲突后立即中止；待 Owner 空闲时补验。合成沙盒仍零原生网络，业务影响评估不变。
- [x] 本阶段仅微信小程序；Flutter/Android/APK/App 签名与发布保持移除状态。

## 2026-11-02 最新授权与本轮交付

- [x] Jovi 已授权在最新分支修改、中文提交，并在交付固定 SHA 后由本地 Codex 接收验证；不沿用下方历史“待授权”状态阻止本轮工作。
- [x] 实时核对 GitHub 分支 `codex/ui-stage1-closeout-20261031@2f9f30bd3fc181e7696b21fc6d58dea520e15004`、main 与已合并 PR #10；不复用旧 Draft PR #7。
- [x] 本轮仅处理微信小程序参数、显示与操作时序，不改 API、数据库或 Flutter 功能；绑定连接 `workspace_info` 报 `-32603 Internal error`，E 盘实时脏树未经远端确认，必须由本地接收时保全。
- [x] 首页独立区分未知数量/效期、阈值未知与实物全零；排序保留管理日期及月份语义。
- [x] 录入提交期间保护 payload，保留新编辑草稿，令旧保存返回与原生失败回调失效。
- [x] 详情普通写操作绑定原显示家庭/药品/页面代次；自身认证失效恢复，旧回执不得干扰新页。
- [x] 关键点击区、文字层级和步骤编号高度在现有组件内收尾，无外部 UI 依赖。
- [x] 完整云端 Node 套件 `1310 PASS / 47 SKIP / 0 FAIL`，lint/typecheck/build、source gate 与精确源码隔离 QA 通过；跳过原因和独立复审见 64 号回执。
- [x] mini tree `542916132a867185d75b75b84b91addb7431b812` 已审核登记；原生/网络/文件权限边界不变。
- [ ] 本地按最终固定 SHA 保全式接收，执行官方微信编译与隔离渲染验收；未取得证据不得标 PASS。
- [ ] 合并、生产部署、微信上传、真实设备与正式发布不属于本轮授权动作。

详细实现、红绿回归、独立复审和接收规则见 `docs/operations/64-RECEIPT-小程序参数与交互审核修复-20261102.md`。本节为提交前执行记录；最终 GitHub SHA、同 SHA 四项 CI 和最终候选摘要以关联新 Draft PR 正文及 Actions artifact 的交付表为准。以下保留历史阶段事实，不代表本次源码已上传或验收。

## 2026-10-31 C2C 接力与下一阶段规划

- [x] 读取根目录 `AGENTS.md`、当前 `tasks/lessons.md`、`tasks/todo.md` 与 Obsidian 项目记录。
- [x] 读取旧会话并提炼最终目标、已完成、阻塞、关键文件和下一步。
- [x] 读取当前 `main@bd7a903`、版本和 62 号交付回执；确认工作区存在未提交 UI 第一阶段改动。
- [x] 形成交给远端规划层的接力文档：`tasks/plans/2026-10-31-c2c-接力与下一阶段提案.md`。
- [x] 核对 Codex with ChatGPT 版本并更新本机 C2C 工具至 `535a07d`；保留现有项目连接器，不新建第二个连接器。
- [x] C2C bridge 恢复健康后，在同一项目聊天发送一次完整阶段规划请求；未重复发送、不把计划当执行结果。
- [x] 远端已返回 `STATE: PLAN`；方案只读审查，未改代码、未跑测试、未提交或部署。
- [ ] Jovi 审阅并授权后，才执行批准范围；未授权前保留当前 dirty 工作区不动。

### 2026-10-31 联合审查补充结论

- [x] 核对 GitHub：本地与 `origin/main@bd7a903e4f15d81f5d097b9d81547ad5acb006ab` 一致；同 SHA CI run `41068160217` 成功。
- [x] 核对开放 PR：唯一开放 Draft PR #7 属旧 1.0.6 分支链，不复用为本轮 1.1.2 UI 承载。
- [x] 核对 Codex with ChatGPT 用法：远端通过本地只读 MCP 读取代码和 diff；GitHub 仅用于后续分支、PR、CI 与候选证据。
- [x] 远端联合审查返回数据流结论：首页输入/筛选、身份局部保护、草稿字段恢复、人工修改标记、提交前校验和 payload 字段有直接接线证据；请求收尾、ACK、照片同步、草稿清理和旧回执失效仍需补核。
- [x] 远端联合审查确认 UI 待收口项：效期文案错配、微信筛选触控回退、默认卡片位置行、scroll-view QA 白名单、Flutter 步骤编号高度和有药品首页卡片验证。
- [x] 远端联合审查推荐合并路线：新建 `codex/*` 分支和聚焦 PR，要求最终 SHA 四项 CI；PR 四绿和合并后实际 SHA 分别取证，不复用 PR #7，不直接提交 main。
- [ ] 本地两个只读审查辅助代理未返回结果，不作为审查证据；后续以主代理和远端审查为准。
- [x] 主代理补核数据流尾段：微信保存后先持久化药品/批次/上传回执，再上传照片、封面与来源；失败保留 `photo_pending`，成功清理草稿并回首页。Flutter 创建/更新、批次版本、照片上传、封面版本和来源回执均逐步 `requireCurrentIntent()`，成功后清理草稿；当前证据未发现断链。
- [x] 主代理确认两个审查辅助代理未返回结果，不作为证据；后续以主代理、远端审查和实际测试为准。

### 远端方案待授权执行范围

- [ ] Flutter 首页：纠正“包装有效期”与实际管理期限字段的文案错配；补有药品长名称/规格、库存待核对、未知数量、320 宽和 2 倍字号回归。
- [ ] Flutter 录入：修正步骤编号在大字体下的固定高度约束；实测短视口、键盘、安全区和底部留白；验证品牌/规格展开、收起、草稿恢复及保存 payload。
- [ ] 微信首页：恢复筛选/清除入口触控尺寸；移除默认卡片新增的位置行但保留位置搜索；验证长文案、横向筛选和两列指标。
- [ ] 微信 QA：精确审核 `scroll-view` 的用途和属性，更新标签白名单及正/负向门禁测试；继续拒绝未知标签、危险组件和越界原生能力。
- [ ] 证据：按最终 40 位 SHA 生成独立候选目录，执行相关回归、lint/typecheck/build、Flutter analyze/test、官方 WXML/WXSS 编译和精确 QA；未执行/跳过/环境阻断分开记录。
- [ ] 明确不在本阶段：API/数据库、生产部署/迁移、真实家庭写入、微信上传、真机操作、Android 正式签名和正式发布。

### 2026-10-31 执行与证据

- [x] 新建 `codex/ui-stage1-closeout-20261031`，保留原 dirty 改动并完成中文提交。
- [x] UI/QA 修复、lint/typecheck/build、Node `230 PASS / 30 SKIP`、Flutter analyze 与 `900 PASS / 19 SKIP` 完成。
- [x] 精确候选固定为 `ed2abd3d6ff9d65362cb4582a49dfdefd513059e`；source package gate 与 mini QA 通过。
- [ ] 官方微信编译、体验版上传和预览等待开发者工具重新登录；当前状态 `APPID_ERROR / loginExpired=true`。
- [ ] 推送、聚焦 PR、同 SHA CI、候选回执、部署/真机/正式发布门槛继续按授权执行。

### 范围纠正（Jovi，2026-10-31）

- [x] 当前阶段范围纠正为：只处理微信小程序，不处理 Android/Flutter App。
- [x] 已确认远端 `main` 已指向合并提交 `f68095c36ffa8d35af173fae51c1c2ccc0e22a96`；不重复 push `main`。
- [ ] 从合并后的 `main` SHA 重新生成小程序候选，执行官方编译、体验版上传和预览。
- [ ] Android、APK、正式签名、App 安装和 App 发布从本阶段验收项移除。


## 2026-10-30 UI 第一阶段：首页与药品录入/编辑页

- [x] 首页视觉层级：家庭入口、搜索、横向筛选、药品图文与余量/效期摘要重排。
- [x] 小程序录入页：采集、必填核对、库存效期分段；低频资料保持折叠并扩大触控区。
- [x] Flutter 首页：统一筛选胶囊、放大药盒图、突出余量与效期。
- [x] Flutter 录入页：步骤标识、紧凑核心表单、可访问的折叠区与底部安全间距。
- [x] 保持数据流、保存契约、请求序号、身份闸与候选预填行为不变。
- [x] Flutter `analyze`、320/360/430 宽度与 100%/200% 字号、键盘和导航定向回归。
- [x] 小程序首页/录入/导航相关 42 项定向回归。
- [ ] lint、typecheck、小程序 QA/包门禁与更广回归。
- [ ] 候选预览与真机视觉验收；本轮不擅自正式发布。

## 2026-10-28 测试、合并与保数据部署（全部完成）

- [x] 复核 `d9c9576` 四项 CI，PR #9 合并为 `main@a80e6aa`，本地 main 已快进；合并提交四项 CI 全部成功。
- [x] 按 main SHA 生成 HTTPS 小程序候选并通过包检查、首页模板和样式官方单文件编译。
- [x] 使用既有 SSH 别名只读核对生产 API、原 DB 与私照卷、36 项迁移账本及 035 差异。
- [x] 停写排他采集 DB dump 与私照卷归档，双端校验一致并完成临时 PostgreSQL 17 容器隔离恢复验证。
- [x] 服务器从精确源码构建 `medbox-api:1.1.2-a80e6aa` 镜像，安全切换并保留旧镜像与原 compose 配置。
- [x] 生产服务升级后公网 health/ready 恢复 200，035 迁移成功应用（37 项），原有 11 药品、11 批次、22 照片与 2 家庭数据无损。
- [x] 微信开发者工具验证登录，上传 1.1.2 体验版包体（617 KB），生成本地预览二维码图片。
- [x] 形成 62 号交付回执（[62 号回执](../docs/operations/62-RECEIPT-合并部署与体验版上线-20261028.md)）。

---

## 2026-10-27 按Jovi授权实施双端大修

- [x] Jovi回复“执行吧”，确认按10月27日完整方案实施；固定现有`21428be`并保留既有未提交方案/图稿。
- [x] P0：修复私照缓存身份作用域、详情重复摘要；合成作用域测试通过，真机待验。
- [x] P1：微信和Flutter三导航、药箱关注、家庭管理与旧链接兼容；相关单元/Widget测试通过，最终全量待复跑。
- [x] P2：双端详情与录入层级、可读字号、关键控件和低频功能收纳；源码、自动化与编译通过，真机另验。
- [x] P3：双端多图逐张核对、冲突处理、人工修改/清空优先、兼容旧草稿；自动化通过，真机另验。
- [x] P4：来源资料持久化、双端阅读、旧服务与结构化备份的隔离环境验证；API严格全套543项、微信来源跨层8项通过。完整备份超12 MiB的分卷和真实双端使用仍待后续验收。
- [x] P5：独立审查、必要修复、完整测试、固定候选及交付回执；真机/发布按实际证据与授权单列。

### 合并后小程序交付（2026-10-31）

- [x] 合并后的 main `f68095c36ffa8d35af173fae51c1c2ccc0e22a96` 主线 CI 恢复读取并成功。
- [x] 合并后 main 候选 release package gate、首页/录入 WXML/WXSS 官方编译和模拟器首页打开通过。
- [x] 小程序体验版 `1.1.3` 上传成功，包体 `670520 bytes`，预览二维码生成成功。
- [ ] 真实手机扫码、家庭/搜索/筛选/录入主路径走查和平台正式发布决定仍待设备证据。
- [x] Android/App、APK、签名、App 安装和 App 发布从本阶段范围移除。
- [x] 微信自动预览推送成功（包体 `670520 bytes`）；真实手机业务走查仍待实际设备证据。

### 体验版上架补充（Jovi授权，2026-10-31）

- [x] 合并后 main 候选 `f68095c` 重新生成并通过 release package gate。
- [x] 微信体验版 `1.1.3` 上传成功，包体 `670520 bytes`。
- [x] 预览二维码生成成功，自动预览推送成功。
- [ ] 他人真实手机业务走查仍需体验成员权限、微信登录和实际设备证据。
- [x] 本阶段不执行 Android/App、APK、签名、App 安装或 App 发布。
