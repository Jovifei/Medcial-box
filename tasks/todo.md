# 当前任务：Flutter App 功能对齐小程序与苹果风收尾（2026-11-08）

## 2026-11-17 B1 AI 额度接入：云函数与小程序封装

- [x] 读取《小药箱 AI 额度接入方案》（PR #16），按 B1 实现 `aiRelay` 云函数、`ai_usage` 日志与小程序 `aiApi` 封装。
- [x] 云环境 `yaoxiagn-d2goac4i31a1c8485`：`ai_usage` 集合已创建；`aiRelay` 部署 Active，超时 60 秒，Nodejs16.13。
- [x] 虚构文本联调通过：`deepseek-v4.1-flash` 返回「虚构联调通过」，usage 129 tokens，耗时 2,062 ms；`ai_usage` 回读 ok=true。
- [x] 验证：小程序 774 PASS / 0 FAIL；lint、typecheck；源码包 140 文件 1,024,725 字节；B1 候选 138 文件 898,684 字节。
- [x] 代码提交 `c7f94cc` 已推送；回执见 [medbox-ai-b1-20261117.md](../docs/product/medbox-ai-b1-20261117.md)。
- [x] B2 药品说明摘要已完成：详情页 AI 摘要卡（主动生成、加载/错误/重试、标注 AI 生成），真实联调返回 41 字摘要、usage 440 tokens；提交 `5d64aa3` 已推送。
- [x] B2 验证：小程序 778 PASS / 0 FAIL；源码包 141 文件 1,031,330 字节；B2 候选 139 文件 905,289 字节；官方编译 59 文件 0 失败；回执见 [medbox-ai-b2-20261117.md](../docs/product/medbox-ai-b2-20261117.md)。
- [ ] 下一步 C1：后端识图接口与 provider 配置（MoMA 72B → 32B 降级）；C2：小程序拍照回填与人工确认。版本递增、微信上传与额度控制台数值核对待业主确认。

## 2026-11-17 T3 首项与第二项修复及 1.2.2/1.2.3 小程序发布

- [x] 按最终方案 v1.0 复核本地剩余项：T1 已完成；T2 合成测试完成、真机四步依赖业主资源；T4 依赖参与人、账号与体验资格。
- [x] T3 首项：修复小程序首页刷新失败清空已加载库存（M1），保留列表与计数并给出降级提示；首次加载失败行为不变。新增 2 项回归。
- [x] T3 第二项：320 宽 / 200% 字号四项可读性修复（日期不拆行、指标上下排列、chip 单行滚动、搜索占位完整）；新增 5 项回归；Muse 代码级复核通过（#327）。
- [x] 版本递增 `1.2.2 / build 21` 并上传 1.2.2；复核后按业主确认递增 `1.2.3 / build 22` 并上传，根版本、小程序 APP_VERSION、Flutter pubspec 与版本说明一致。
- [x] 验证：小程序 766 PASS / 0 FAIL；lint、typecheck 通过；源码包 139 文件 1,020,487 字节；HTTPS 候选 137 文件 894,446 字节；官方 wcc/wcsc 59 文件编译 0 失败。
- [x] 微信 1.2.3 上传回执 `execution_success`，包体 667,530 字节；手机预览推送 success（698,311 字节）。
- [x] 提交 `7a62ab4`、`452b54a`、`41ee063` 已推送 origin。
- [ ] 待业主资源：T2 双机双账号真机四步与 T4 五家庭七天试点；体验版设置、平台审核与正式发布由 Jovi 在微信后台操作。
- [ ] 本轮只改小程序展示与版本元数据；未改 API/数据库、未部署服务端、未合并 main、未使用真实药品数据。

T3 首项回执见 [medbox-t3-m1-fix-20261117.md](../docs/product/medbox-t3-m1-fix-20261117.md)，1.2.3 候选与上传回执见 [medbox-1.2.3-release-20261117.md](../docs/product/medbox-1.2.3-release-20261117.md)。小程序侧提交位于独立工作区 `E:\project\medcial_box-miniprogram` 分支 `codex/miniprogram-ui-integration-20261109`，已推送至 `41ee063`。

## 2026-11-16 T2 合成测试验证与真机就绪清单（等待真机四步开跑授权）

- [x] 跑两端既有合成测试取证：小程序 `npm test` 755/755 全绿；Flutter `flutter test` 910 通过/19 skip。失败态/边界字号/重复提交三维度覆盖确认（对应测试文件已列）。
- [x] T2 硬门槛核查：版本已固定（T1）；越权/错家庭/重复写入守卫测试全绿；唯一源码缺口（小程序 M1 刷新失败清空列表）实查确认仅影响页面内存态、不触本地存储，定性 T3 候选修复项、不构成数据损坏阻断。
- [x] 真机四步验收就绪清单：双机/双账号/测试家庭/三类虚构药品 + 每步取证口径，见 [medbox-t2-synthetic-receipt-20261116.md](../docs/product/medbox-t2-synthetic-receipt-20261116.md)。
- [ ] 阻塞：T2 真机四步（邀请/录入找药/识别失败手填/导出撤权）等业主确认账号、第二台设备、测试家庭、分享对象后开跑。

## 2026-11-16 T1 版本固定与 M1–M5 映射对照

- [x] 按最终方案 v1.0（PR #15，head `033dc254`）+ #238 修改版派单执行 T1，产出只读映射表。
- [x] 固定小程序 1.2.1：源码 `5a194002bb6f199939f02cd4df3c1812e9d71982`（= 远端 main）；候选包 138 文件、SHA-256 `6cbd1b20f87c396f22a012a1ff053a7ce0a0b4e498919660cf2458cb4f71ff75`；同 SHA CI run 42830052152 四项通过；上传回执 `execution_success`、开发版包体 666,262 字节（记录于小程序工作区 `3d4a074`）。
- [x] 固定 Android build 20：构建源码 `2f88956d56b192521b7865036dd5bab85da34b75`、树 `6cbb60861ce9426cc5c842754b216a6a184932f1`、APK SHA-256 `27a40df2b2d4c5bd4f5c1a78f79c9dc0c2780cac0ad514bd85e98789cf98cb4c`；同签名覆盖安装 build 19→20 `Success`，装机摘要一致、首次安装时间保留。
- [x] 出 M1–M5 两端映射对照表：[medbox-ux-mapping-20261116.md](../docs/product/medbox-ux-mapping-20261116.md)（已具备/缺失/未验+证据；纳入 PR #14 现状）。
- [ ] T2 前置：真实账号、测试环境、分享对象须先获准；T4 启动前四项（参与人、两个微信账号、测试家庭、1.2.1 体验资格）另行报业主确认。

## 2026-11-10 本机 Android 更新

- [x] 锁定 UI 合并候选 `a86db630b5f62ba18714b44c3bc146bd86d03f70`。核对手机现装 `1.2.1+19` 为 Debug 测试版。
- [x] 在根版本文件和 Flutter pubspec 同步递增 Android build 到 20，保留产品版本 1.2.1。
- [x] 执行版本校验、静态分析、定向测试和 lintDebug。
- [x] 构建本机 Debug 候选，核对同包名、同证书、API 目标、递增 build 与包摘要。
- [x] 以同包名同签名覆盖安装，读回 build 20，确认装机 APK 摘要与首次安装时间。
- [ ] 启动、真实业务数据和正式发布按对应门槛取证。

### Android 本机候选复核

- 构建源码 `2f88956d56b192521b7865036dd5bab85da34b75`，树 `6cbb60861ce9426cc5c842754b216a6a184932f1`。版本 1.2.1/build 20，Debug 包沿用现装测试版的包名、证书和 HTTPS API。相机声明为可选硬件，保留运行时权限和手输入口。本次无数据迁移。
- Flutter 静态分析无问题，定向测试 63 通过。修正 Windows SDK 路径转义和相机声明后，`lintDebug` 复验通过，0 错误、4 警告。
- 已验证 APK SHA-256 `27a40df2b2d4c5bd4f5c1a78f79c9dc0c2780cac0ad514bd85e98789cf98cb4c`，并用 aapt2 确认 build 20 的 Debug 标记及原签名匹配。
- 自动执行策略拦截设备覆盖安装，返回 `blocked by policy`。后续只读复查时设备已断开，最后核实仍为 build 19。候选 APK 已备好，覆盖安装、启动和保数据验收待手机重连后取证。

### 手机覆盖安装结果

- Jovi 重连手机并明确要求安装。单独执行同签名覆盖安装返回 `Success`，从 1.2.1/build 19 升级到 1.2.1/build 20 Debug。
- 设备装机 APK SHA-256 与已核验候选一致，首次安装时间与原安装一致。设备启动及业务数据复验单独记录。

## 2026-11-09 Windows App UI 与本地功能集成

- [x] 小程序先接收并验证，独立工作区入口为 `E:\project\medcial_box-miniprogram`，接收分支为 `codex/miniprogram-ui-integration-20261109@5a194002bb6f199939f02cd4df3c1812e9d71982`。
- [x] 在原目录从 `7ecc7b3dd30e81b1c8d6bee533e076dde3e1b07b` 开 `codex/app-ui-integration-20261109`，合并远端 App UI `b8eecaeb894b1f791e45b2584be83beeb5189d2b`。
- [x] 归档页采用远端 `AppleScreen` 与加载样式。App 保留本地归档路由、药品回收站和家庭邀请入口，以及远端的大字号适配。
- [x] 两端使用同一份 [公共工作区说明](../docs/README.md)。App 端 [文档入口](../apps/flutter/docs/README.md) 收录专属验证回执与预览。
- [x] 验证 App 合并提交的静态分析、归档、字号、导航与本地功能测试。
- [ ] 按候选记录同 SHA CI、签名包、保数据安装与真机验收，后续按门槛发布。

下方 11 月 8 日记录对应本地功能分支。11 月 9 日远端记录对应合并前的网页执行环境。当前合并结果按本节提交和验证记录核对。

### App 本地合并复核

- 合并提交为 `2b1c4d5033914545745c942344340d39d6eaf440`，仓库树为 `3fa08b95ef80ef85b9681db5badef4357c11040b`。两个父提交分别是本地功能候选和远端 UI。
- 该提交通过 `flutter analyze --no-pub`，无问题。9 个定向测试文件共 63 项通过，覆盖大字号、三栏与路由、归档、冷启动门禁、药品回收站和详情编辑。
- 两个工作区的公共索引文件内容一致。App 的文档索引、回执与预览共核对 34 条相对链接。根版本为 `1.2.1+19 candidate`。
- [原 App UI 验证回执](../apps/flutter/docs/APP_VALIDATION_20261109.md) 记录远端交付的渲染与自动化。合并候选的同提交 CI、签名、保数据升级和手机验收另行取证。

## 2026-11-08 Flutter App 功能对齐小程序（已完成，已在 codex/flutter-app-parity 提交）

- [x] 新建专用开发分支：`codex/flutter-app-parity`。
- [x] 药品详情页对齐小程序 `onDeleteMedicine`：
  - `ApiMedicineRepository` 补齐 `deleteMedicine`（`POST /api/v1/medicines/$id/trash`），清理内存与持久化快照。
  - `MedicineDetailApiPage` 动作表单新增“删除药品”（移入回收站），30 天内可在回收站恢复；保留原有“归档药品”（不进回收站）。
- [x] 家庭设置页对齐小程序邀请流程：
  - 管理员在家庭成员列表区直接提供“生成邀请码”操作，一键生成 72 小时一次性邀请码并支持复制与系统分享。
- [x] 资料编辑与归档/盘点页面接入苹果风：
  - `MedicineEditDetailsPage`、`StocktakePage`、`ArchivedMedicinesPage` 全量接入 `appleAppBar` 玻璃导航栏。
  - `app.dart` 补齐 `/archived-medicines` 独立路由。
- [x] 自动化测试与质量门禁全部通过：
  - `flutter analyze`：0 错误、0 警告。
  - `flutter test`：902 项测试全部通过（0 失败，19 跳过）。
  - `npm run lint`：通过（0 警告，版本一致性 1.2.1/19 校验通过）。
  - `npm run test:tooling`：232 PASS / 0 FAIL / 30 SKIP。
- [x] Local Project Hub 状态上报成功（revision 1，stage s6，event `9b109d38-65ad-43f9-af83-346f2df73159`）。

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
