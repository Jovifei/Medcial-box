# 当前阶段 · 2026-10-08 两阶段验收计划

main基线f675416；本轮计划分支codex/two-stage-audit-20261008。状态PLAN_READY / INITIAL_AUDIT，完整验收未执行。三名独立子代理初审与局部实际页面/validator探针发现库存阈值保存缺字段风险（开/关均CONTRACT_FAIL，PG尚未复现）。相关真实数据路径不放行；本机独立测试继续。计划/288条来源规格映射/人工卡/缺陷证据见[two-stage-audit](plans/2026-10-08-two-stage-audit/README.md)。下列历史状态只对应其日期和SHA，不作当前PASS。

---

# 当前执行补充 · 2026-10-05 原生能力与安全写入

当前原分支 `audit/final-delivery-2026-10-04`。截至基线 `9de6d991`，照片清理归属、条码/编辑加载原家庭保护、日期精度与期限模式修复均已独立审查并提交；精确CI全绿：mini265、API389（严格PG无跳过）、tooling59、Flutter689/analyze、Debug/unsigned Release、隔离Docker恢复。

本轮新增产品照片独占创建→reserved登记→按字节写入→close→ready。独立复审逐步补出被动回页、删除确认、普通输入和批次差量的并发覆盖反例；当前第六版使用独立确认基线及最新队列/逐字段差量合并，保留晚到照片归属回执与未落盘编辑；清理不替换进行中上传对象，新批次采用稳定本地身份。当前本地mini326/API238（13 PG套件明确跳过）/tooling94（含内存QA35，零跳过）及lint/typecheck/build/源包预算通过；精确第六版另有独立326/326全mini及45/45针对性复验通过；发布后的精确CI与官方IDE产品验收仍待核实。详见[安全照片写入证据与边界](reports/closeout/24-owned-photo-write-lifecycle.md)。

本机官方IDE在9de6d991已验证批次日期/期限转换和单独原生文件探针，但家庭切换异步矩阵因副本共享同账号/AppID存储而安全停止，不能称已通过。后续使用内存隔离合成夹具；不改真实存储、账号、照片或健康数据。正式签名、平台审批/模板、真实双设备与发布仍保持未验收。

---

# 当前执行补充 · 2026-10-04 最新安全续作

当前原分支 `audit/final-delivery-2026-10-04`，已发布 `4b5b641` 门禁/安全诊断、`5b9ace6` 字体宿主fixture与许可证、`91dd6c1` 录入原家庭异步保护。本轮继续修复照片精确归属及清理失败恢复，状态仍 **PARTIAL**。

最新云端小程序250、API238（13可选PG套件跳过）、工具59及lint/typecheck/build/源包预算PASS。第一批CI验出旧字体资源回归后已修复，后续精确CI和Android构建仍跟踪，不以局部通过代表整项目交付。

详情：[照片清理归属与恢复](reports/closeout/21-photo-cleanup-ownership.md)、[录入家庭边界](reports/closeout/20-entry-household-boundary.md)、[字体fixture修复](reports/closeout/19-host-font-fixture.md)。下一步为初始照片写入前登记、余下日期模式状态同步及精确CI收口。真实设备、微信审批/模板、正式签名/API、HTTPS、双设备与最终交付仍需分别验收。

---

# 当前执行补充 · 2026-10-04 最新审计分支

状态 **IMPLEMENTATION_AND_VERIFICATION / PARTIAL**。最新实施基线 `audit/final-delivery-2026-10-04 / 0c19a16`；main 已包含旧 prototype，但最新审计工作尚未进入 main。此前下方状态均按其源码日期保留，不能直接当作当前版本。

本轮修复审计分支未触发 CI、小程序语法错误、诊断原始信息泄漏风险，并回补另一审计分支的限流/health/打包门禁。云端小程序232、API237（13 PG套件跳过）、工具58与lint/typecheck/build通过；新增限流聚焦3/3通过。精确CI、Flutter/Android/PG/Docker及真实设备/平台验收仍须分别确认。

详情及剩余交付：[最新审计与门禁修复](reports/closeout/18-latest-audit-gates.md)。下一步检查照片草稿安全清理与日期状态边界；没有正式发布。

---

# 当前状态 · 2026-10-03 云端补充收尾

- 状态：**IMPLEMENTATION_AND_VERIFICATION / PARTIAL**；当前代码核对 `f5e17e5`，既有分支 `codex/flutter-ui-prototype`
- 已发布19批独立修复与验证补充；在既有会话/提醒/历史/幂等/权限/清理边界之上，补齐Flutter计划表单、重启身份、精确导出原件恢复，以及五批单页录入可靠性修复
- 最新精确提交Linux CI的Flutter671/analyze通过，15个符号链接安全场景均实际执行；C2冻结时独立聚焦76证据保留；小程序230、工具6、lint/typecheck/build通过。API382及严格隔离PG150项/12套保留计划表单阶段证据，后续不改Node/API/SQL。逐提交CI见 [当前收尾矩阵](reports/closeout/2026-10-03-current-closeout-matrix.md)
- 当前C2已覆盖320/360/430宽、100%/200%字号及合成键盘占位；45张Flutter引擎图对应6ec8d7a的生产页面源码，后续两批未改渲染源码。原生系统Back、真实输入法、相机与WeChat页面仍待验，详见 [录入可靠性与视觉证据](reports/closeout/16-entry-reliability-and-visual-verification.md)
- C4仍PARTIAL：仅恢复清理精确登记且证据一致的完整原件；中断未登记、替换和旧模糊文件保留。旧原始令牌无可信来源记录需重新连接；未知草稿保留隔离。不能宣称跨进程、断电或所有持久写入失败场景均已关闭
- Windows本机官方WeChat编译25WXML+26WXSS通过，Flutter656 PASS / 0 FAIL / 15 SKIPPED（仅缺少创建符号链接权限errno1314）。非链接保留断言独立执行；这15个本机安全分支不称PASS
- Android缺失的三个未选OCR脚本各Options/Builder仅用六条精确规则处理，保留R8和默认规则；CI及本机debug/release编译通过。本机release仍使用既有debug签名、API为空，未安装、未验证原生中文OCR，不能称正式发布就绪。详见 [平台编译门禁](reports/closeout/17-platform-build-and-fixture-verification.md)
- WeChat JS/模拟器页面、真实账号/两手机/拍扫/模板/通知/分享/独立HTTPS/数据库图片恢复仍未验收
- 本轮仅合成数据；本机后续使用隔离worktree验证，保留原目录未提交/未跟踪文件，未安装覆盖、未合并main、未部署。下方报告保留为对应版本的历史证据，不用旧统计或旧SDK阻塞替代当前结论

- 状态：**IMPLEMENTATION_AND_VERIFICATION / PARTIAL**；源码 `codex/flutter-ui-prototype / 736d7623435e2a38e3ebb51859574d43dffa0120`。项目未达到 LOCAL_RC_READY、STAGING_READY 或 V1_DELIVERED。
- 本地已快进同步远端 10 个提交。计划创建重试使用迁移 028 持久回执；新“支”单位使用迁移 029。新环境需先应用所有待用迁移，再更新 API，最后更新客户端。
- 精确提交 GitHub Actions [run 37107940730](https://github.com/Jovifei/Medcial-box/actions/runs/37107940730) 显示 Success，包含 verify 与 flutter 作业。
- 本机小程序：运行时测试 220/220、lint、typecheck 与官方 WXML/WXSS 编译 51 个文件 PASS；DevTools CLI 接受隔离项目打开。未观察页面渲染或逐项点击。
- 本机 Android：最终源码 Debug APK 经 `adb install -r` 更新到 OnePlus GM1910，首次安装时间未变；本机合成 API 下设备连接与家庭读取通过。日期滚轮与选中值已在真机验证为中文。Release R8 已构建 PASS，但使用 debug 证书。
- 本机 Debug API 为 `127.0.0.1:13300` 的假微信/隔离 PostgreSQL 联调环境，当前进程和手机 ADB reverse 仍启用；测试家庭是合成数据。`medbox-test.joviluma.com` 当前无 DNS。真实微信 OAuth、相机照片识别准确率、通知、生产家庭数据均 `NOT_RUN`。小程序源码回归和官方编译仍 PASS；完整证据见 [Android 识药、单位、日期与 Release 报告](../docs/operations/04-RPT-Android识药单位日期与Release验证.md)。
- Docs 索引、架构/Flutter 本地构建说明与 Android 验证报告已更新；Obsidian overview/progress/decision checkpoint 及 7 份文档镜像为 `MEMORY_UPDATED`，源/目标哈希一致。
- 本轮未向微信平台上传/发布，也未操作 ECS。两账号两手机、提醒模板/送达、系统分享、HTTPS、正式签名及数据库/图片恢复均 `NOT_RUN`。
- 仍需补齐：Android 计划表单的星期选择、药箱药品关联、普通表单草稿；Flutter 跨重启安全恢复与跨进程导出文件清理。C1 计划创建幂等已在 736d762 完成。
- 下列较早云端核对条目保留为历史版本证据，不把旧统计或旧 SDK 状态当作当前本机结论。
---

# 历史状态 · 2026-10-03 原收尾修复

- 状态：**LOCAL_VERIFICATION / PARTIAL**。已按授权修复实例历史、提醒授权、数量换算、会话及失败恢复；新增单页录入、十份持久草稿、成员提醒设置和同快照多格式导出。
- 唯一目录 `E:\project\medcial_box`，分支 `codex/flutter-ui-prototype`，实施基线45bb7aa。保留所有者AGENTS、overview及本地工具状态，不纳入业务提交。
- 根lint/typecheck/test/build PASS；Mini157、API191（普通运行9套可选PG跳过）、tooling6 PASS；严格真实PG84 PASS；官方编译51文件PASS。Flutter analyze、61项测试与最终Debug APK PASS；未配置生产API及正式签名。
- 详细证据：[本次收尾修复与审核](reviews/2026-10-03-closeout-repair-and-verification.md)。严格PG是隔离schema及测试微信网关，不代表真实登录。
- 真实双账号两手机、拍扫权限/识别质量、微信消息与分享、Android系统通知、独立HTTPS及数据库图片恢复仍NOT_RUN；正式Android签名与生产API构建配置未完成。不得标记整项目完成。
- 业务修复446fa63已推送功能分支；main仍ad6b31f，未合并，未部署。初次fetch短暂失败，普通push随后成功。

---

# 历史状态 · 2026-10-02 项目收尾规划

- 状态：**CLOSEOUT_PLANNED / PARTIAL**，尚未完成真实双端家庭交付。
- 唯一剩余工作入口：[家庭药箱v1收尾执行计划](plans/2026-10-02-project-closeout.md)，顺序C0工程归一→C1可靠性→C2简洁交互→C3双端补齐→C4资料/导出→C5门禁→C6部署恢复→C7家庭试用。
- 当前主目录 `E:\project\medcial_box`，分支 `codex/flutter-ui-prototype`；编写基线7a94f50。H0/S1/S2/S3已有修复提交；S4会话/导航/草稿/导出等工作区改动待验收整合，不重新实现。
- 本轮仅核对代码/文档并创建计划、同步台账，测试/构建/真机/平台/部署全部**本轮NOT_RUN**；下方旧统计及旧阻塞是历史记录。
- 仍需完成：单页添加体验、Android既定计划/通知等功能、真实拍扫/资料和分享、独立HTTPS及恢复、双账号两手机验收。专用AppID已有配置，不能继续称未确认；SDK/CLI按当前环境检查，不沿用旧“无SDK”结论。
- 不扩入：独立搜药目录、药箱分析、就诊/健康档案、自动扣库存、多家庭、iOS与商业化。必交微信模板若受平台阻塞如实登记，不静默删范围或标完成。

---

# 历史状态 · 2026-10-01 双端录入体验与用药计划

- **2026-10-02 模拟器实跑通过**：`wechatide` CLI skill 通道首次打通（CodeBuddy 客户端已授权、工具已登录 Jovi），项目导入开发者工具后在模拟器内完成**全链路实跑**：真实 wx.login（开发网关）→ 建家庭 → 录药 → 详情 → 创建计划 → 今日安排确认 → 计划详情历史 → 版本说明；console 无错误，PG 逐条核验一致。新增 `scripts/dev-simulator-server.mjs`（真实 API + 真实 PG + 开发网关，端口 13300；本机 3000 被其他项目占用）。发现并修复 `dist/` 陈旧导致的 auth/me 404（教训：跑 dist 前先构建）。证据 14 张截图 + 报告：[模拟器实跑报告](reports/2026-10-02-simulator-run.md)。

- **2026-10-02 更新**：药箱专用 AppID 已确认（`wx1f6dd99d28aab8e5`，公开客户端标识，已填入 `project.config.json`）。服药提醒模板环境变量接线补齐（`WECHAT_DOSE_REMINDER_TEMPLATE_ID` / `WECHAT_DOSE_REMINDER_FIELD_MAP` / `WECHAT_DOSE_REMINDER_SCHEDULER_ENABLED`，含 compose 传递与 env 样例）。剩余人工步骤：① AppSecret 由所有者填入服务端 `deploy/.env.local`（不进聊天/仓库）；② mp 后台申请订阅消息模板并回填模板 ID；③ 开发者工具扫码登录后真机预览。`wechatide` CLI 仍被 `reg.exe` 黑名单阻塞。
- **本次更新（R3 + R4）**：R3 用药计划全链路完成并验证（后端详情/编辑/历史/授权接口 + 小程序今日安排、全部计划、计划详情、照护对象与共享权限页）；R4 服药提醒服务端链路完成（迁移 `018`、排队/复核/取消调度器、订阅与发送结果展示）并完成版本介绍与更新链路。**当前 PASS**：根 `lint`/`typecheck`/`build`；小程序 **96/96**；API 单元 **184**；工具 6/6；**严格真实 PostgreSQL 59/59**（19+4+6+5+6+10+9）；官方编译器门禁 **47 个文件全部通过**。详见 [R3/R4 交付与测试报告](reports/2026-10-01-r3-r4-medication-and-reminders.md)。
- 本轮修复的真实缺陷：① 今日安排客户端未排序（已按时间升序）；② 改期删除时间点会级联删掉服药历史（迁移 `017` 改为归档时间点，历史保留、未来按新时间点物化）。
- **NOT_RUN/BLOCKED**：R4 真实微信模板送达需药箱专用 AppID（`BLOCKED_PLATFORM`，计划与今日安排不受影响）；Android 双渠道通知与精确闹钟、R0 收口 A06/A09 与 A03 UI 层需 Flutter SDK；R5 双账号两手机试用需两台设备。
- **R5 准备就绪**：验收 runbook 已落地——[R5 家庭试用验收清单](reports/2026-10-01-r5-family-trial-checklist.md)（8 节 40 项：独立部署、账号与家庭、录入与库存、备份恢复、用药计划、通知与更新、双端回归、证据留存，前置人工项与阻塞项已标注）。所有可自动化部分已全部完成，剩余均为外部授权/设备依赖。

---

# 历史状态 · 2026-10-01 双端录入体验与用药计划（R0 进行中）

- 当前阶段：按 [2026-10-01 双端录入体验与用药计划实施方案](plans/2026-10-01-dual-client-experience-and-medication.md) 推进 **R0 数据修复**；优先级固定为 数据正确性 → 录入和查找 → 用药计划 → 真实通知 → 后续分析。
- R0 进度：**A01/A02/A04/A05/A07/A08/A12/A14/A15 已修复并有行为测试与真实 PG 证据**（小程序 56/56、PG 19/19 + 4/4）；**A06、A09 为 Flutter 改动，本机无 Flutter SDK 未验证**，R0 待 Flutter 环境收口后进入 R1。详见 [R0 就绪核对报告](reports/2026-10-01-r0-readiness.md)。
- 当前 PASS：根 `lint`/`typecheck`/`build`；小程序 56/56；API 单元 182 PASS；工具 6/6；**严格真实 PostgreSQL 19/19 + 提醒套件 4/4**。详见 [修复批次报告](reports/2026-10-01-s0-s1-fix-report.md)。
- 当前 NOT_RUN：Flutter `analyze`/`test`/`build apk`（本机无 Flutter SDK）、真机预览与上传（需专用 AppID 并登录开发者工具）、真实订阅消息送达、双账号双手机试用、ECS 独立部署。
- 本机**新增小程序官方编译器门禁**：`npm run check:miniprogram` 调用开发者工具自带的 `wcc`／`wcsc` 逐个编译 WXML／WXSS（当前 **39 个文件全部通过**）。微信开发者工具版本 `2.02.2609231`。
- **BLOCKED_ENV**：`wechatide` CLI 无法启动 IDE——CLI 内部调用 `reg.exe` 被本机安全策略列入程序黑名单（提示不可批准、不可绕过）。解除方式：安全中心 → 命令安全 → 程序黑名单移除 `reg.exe`；之后首次启动开发者工具还需扫码登录并允许「设备连接 CLI」授权。完成后即可用 CLI 跑编译／预览／自动化。
- R1 已启动：**R1 全部六个子项完成（R1-1 数据层、R1-2 标签、R1-3 照片与封面、R1-4 小程序同步、R1-5 备份 v2、R1-6 单位守卫）**（迁移 `013` 定点数量 + `ml`／`blister`，真实 PG 新套件 6/6，既有 19/19 + 4/4 无回归）；R1 收口提交 `827f365`。R2 主体完成：四导航、首页筛选排序/标签卡片、录入面板核查、详情标签展示、版本与更新引导（`88c533a`/`7bf83dc`/`d5eccdd`/`764d425`）；封面内嵌展示待鉴权图片方案。R3 后端全链路完成（`a5d4f81`：迁移 016 五表 + 照护对象/授权/计划/日程物化/幂等确认接口，PG 5/5）；小程序页面与通知投递待做（通知依赖专用 AppID）。
- R2–R5 未开始：页面体验（四导航与卡片筛选排序、录入核对页、药品详情、游客引导）、用药计划（照护对象与确认历史）、通知与更新、家庭试用。
- 主目录 `E:\project\medcial_box` 的原有未提交改动未触碰；本轮只在候选工作树内改动。

---

# 历史状态 · 2026-10-01 S0+S1 修复批次

- 该批次结论：**S0 与 S1 已完成并验证通过，A03 的 Flutter 部分代码已改但本机无 Flutter SDK 未运行验证**；S2/S3/S4/S5 当时未开始。
- 基线：`codex/flutter-ui-prototype / 47d36e30`。本批次修复 A01、A02、A03（数据层）、A04、A07、A12，对应 [候选修复计划](plans/2026-09-30-candidate-hardening.md) 的 S0 + S1。
- 本批次提交：`33b30a823edb322485116c219baa0d90cfc4af77`，已推送 `origin/codex/flutter-ui-prototype`（`47d36e3..33b30a8`）。
- 当前 PASS：根 `lint`/`typecheck`/`build`；小程序 51/51；API 单元 182 PASS；工具 6/6；**严格真实 PostgreSQL 19/19 + 提醒套件 3/3**。详见 [修复批次报告](reports/2026-10-01-s0-s1-fix-report.md)。
- 当前 NOT_RUN：Flutter `analyze`/`test`（本机无 Flutter SDK）、APK 构建、真机与微信开发者工具、真实消息送达、双账号双设备试用、ECS 部署。
- 剩余问题：A05/A06/A08/A09/A10/A11/A13/A14/A15（S2/S3）；S4 功能补齐（连续照片草稿、小程序 CSV/PDF、成员提醒时刻）；A03 的 UI 层（运行期 401 统一失效、断网退出导航）。
- 本轮新增：`apps/api/test/integration-pg-reminders.test.mjs`、`apps/miniprogram/services/session-scope.ts`、`apps/flutter/test/session_identity_switch_test.dart`。
- 主目录 `E:\project\medcial_box` 的原有未提交改动未触碰；本轮只改候选工作树。

---

# 历史状态 · 2026-09-30 审核

- 结论：**CHANGES_REQUIRED / PARTIAL**。审核基线 `codex/flutter-ui-prototype / 47d36e30d091d68d4b5a6d5bf3ad346ef0ab2792`。
- 审核发现 15 组问题，包含备份恢复丢失期限/说明书、已处理库存恢复为活动状态、身份切换残留数据、编辑误新增、盘点旧版本及提醒收件人复核缺失。详见 [审核报告](reviews/2026-09-30-plan-code-audit.md)。
- 该轮 PASS：根 lint/typecheck/test/build；API 178 PASS/1 可选 PG SKIPPED、Mini 47/47、tooling 6/6；Flutter analyze/test 40/40；本地候选服务健康只读检查。
- 该轮 NOT_RUN：严格真实 PostgreSQL、APK 构建、手机/微信开发者工具、供应商、真实消息及远端验收。

---

# 历史状态 · 2026-09-29

## 双端家庭药箱候选版本

- 状态：`LOCAL_CANDIDATE_READY / REAL_DEVICE_NOT_RUN / PLATFORM_BLOCKED`。
- 工作树：`C:\Users\Admin\.codex\worktrees\flutter-ui-prototype\medcial_box`；分支 `codex/flutter-ui-prototype`；基线 `63ddb85`。
- 本地 Docker 候选栈：Compose 项目 `medbox-dual-stage`，API 只绑定 `127.0.0.1:13302`；`/live`、`/ready` PASS；最终镜像启动迁移 12 条；数据库和私有图片使用独立卷，API/DB health PASS。忽略环境文件中没有微信或资料服务凭据。
- 自动验证：根 `lint/typecheck/test/build` PASS；API 179 项（178 PASS、1 项常规可选 PG 跳过）；隔离真实 PostgreSQL 17/17 PASS；小程序 47/47 PASS；Flutter analyze 无问题、40/40 PASS、Debug APK 构建及 ZIP 结构检查 PASS。
- PDF：已加入 Noto 简体中文字体子集与 OFL 许可；PDF 生成测试可输出包含中文/希腊字符的 A4 文档。APK 位于 `apps/flutter/build/app/outputs/flutter-apk/app-debug.apk`（209,219,317 bytes；SHA256 `B48146E21178D8DF83C528DADF18F65B8F83CB987BC05701F13F9FB9A1CCF4BE`）。
- 主要实现：开封后期限、原子拆分开封、阈值/补货/盘点、待处理、App 连接和独立会话撤销、条码候选与人工确认、成分已核验后的精确重复提示、JSON 预览恢复、回收站/审计、双端说明书照片管理、CSV/PDF/Markdown App 导出、一次性微信订阅与上海 09:00 提醒调度。图片接口在解析大请求体前鉴权，按用户限速、按家庭限制 64 MiB/100 张；文件实际清理后释放配额，回收站药品照片在 30 天恢复期后由服务端任务清理。

## 未完成的验收与功能

- `BLOCKED_INPUT`：尚未核实哪个 AppID 是家庭药箱专用账号，不能用车迹或其他测试账号替代；因此真实微信登录和小程序页面运行未做。
- `BLOCKED_PLATFORM`：订阅模板和类目尚未在药箱专用 AppID 下确认，未发送真实消息；客户端明确显示模板不可用。
- `NOT_RUN`：真实 Jisu 查询、真实药盒图片识别、实体设备相机/扫码/Android 通知、双微信账号家庭共享、导出文件在微信中的实际分享、ECS/HTTPS 部署。
- `INCOMPLETE`：最多 10 份连续照片草稿、小程序 CSV/PDF、家庭成员自选提醒时刻。
- `NOT_RUN`：Bash 备份与私有图片归档脚本的目标环境演练；Windows 上 WSL Bash 启动失败，未把静态验证冒充脚本 PASS。
- 设备保护：GM1910 已有同包名应用，当前 AVD 属于其他项目。本轮没有安装覆盖、清除应用数据或启动他项目模拟器。

## 下一步门禁

先由 Jovi 确认药箱专用小程序 AppID（不要在聊天发送 AppSecret），然后为开发者工具生成使用 `127.0.0.1:13302` 的本地包并做真实登录/录入；若要在手机上连入，需准备独立 HTTPS 测试域名。只有药箱 AppID 的真实模板可用后，才验收微信消息实际送达；ECS 继续保持未部署。

---

# 历史状态记录 · 2026-09-27 Flutter 交互原型

## 2026-09-28 双端真实家庭药箱（执行中）

- 基线：`codex/flutter-ui-prototype` / `63ddb85`，隔离工作树 `C:\Users\Admin\.codex\worktrees\flutter-ui-prototype\medcial_box`。
- 已完成：详细计划已落盘到 `tasks/plans/2026-09-28-dual-client-inventory.md`；三项后端纯业务规则已先红后绿验证（开封期限、最早有效期限、低库存汇总）。
- 正在实施：API/PostgreSQL 库存和家庭服务；Flutter Android 真实 API 客户端；微信小程序同一数据模型与任务流。
- 外部待核验：新 AppID 与 MateLink 账号关系、微信订阅模板/类目、资料接口密钥、微信开发者工具 UI 端口。
- 安全边界：只在本地候选环境工作，不改 ECS，不操作非 medbox 容器，不输出密钥；微信消息必须用户主动授权后发送。
- 本轮最终验收还未执行：`NOT_RUN`；任何模板/API/真机阻塞如实记为 `BLOCKED`。

## 2026-09-27 审计问题修复结果

- Flutter：备注与批次写回演示仓库；归档保留可选导出；导出 Markdown 现在随个人备注、存放位置和归档开关改变；详情页补无效 ID、空批次状态；相机权限错误改为可操作提示；OCR 无药品关键词时保持空白并提示人工核对。
- 小程序：分享邀请码统一为预览→确认→接受；批次数量和有效期使用严格校验；邀请码刷新保留当前有效码；编辑药品时识别等待资料加载完成；显示名保存改走 POST 兼容入口，避开 wx.request 的 PATCH 运行时问题。
- 验证：根 lint/typecheck/build 通过；API 合成测试 127 通过、1 个可选真实 PostgreSQL 测试跳过；tooling 5/5 通过；Flutter analyze 通过、Widget/解析器/仓库测试 15 项通过、Debug APK 构建通过；最新 APK 已保留数据安装到 `GM1910`，启动进程和欢迎页语义节点 PASS；本地 Docker API/DB 重建后 `/ready` PASS，兼容入口无令牌返回预期 401；`git diff --check` 通过。
- 仍未完成：微信开发者工具页面点击、真实小程序相机/相册权限、双账号家庭共享和远端 ECS 验收。开发者工具 CLI 仍受 `IDE service port disabled` 阻塞。

- 分支：`codex/flutter-ui-prototype`，基于 `7d8afdb`，独立工作树 `C:\Users\Admin\.codex\worktrees\flutter-ui-prototype\medcial_box`。
- Flutter：3.47.5 stable；Android SDK 已存在，通过 `E:\AI_Tools\Other\AndroidSDK` Junction 统一访问；Android 设备 `GM1910` 已连接。
- 原型范围：欢迎页、家庭选择、创建／加入底部面板、药箱首页、搜索、药品详情、批次状态、个人备注、Markdown 导出选项；库存使用合成数据。
- 功能新增：`image_picker` 相机／相册入口、Android CAMERA 权限、中文 ML Kit 文字识别、识别草稿人工核对页、手动录入真正写入演示药箱。
- 当前证据：`flutter analyze` 无问题；Widget／解析器／仓库测试 15/15 通过；Debug APK 构建成功；最新 APK 已保留数据安装并启动到 `GM1910`；相机权限弹窗、系统相机、拍照返回识别草稿和手动录入保存均已有设备证据。
- 真正微信登录、API 联调、药品资料查询和生产发布不在本轮范围；本轮相机识别使用本地 ML Kit，结果必须人工核对。
- 小程序同步：首页新增 Flutter 同款三选一录入底部面板；拍照／相册入口带 `capture` 来源进入录入页，继续使用现有鉴权识别 API 和人工核对保存。最新本地导入包：`.local-data\mini-local-0e6110b2-a8a7-40ce-ab52-fbd42d79fdb6`。

---

# 2026-09-27 登录与家庭试用闭环（本轮执行）

- 后端已实现 `GET /api/v1/auth/me`、`POST /api/v1/auth/logout`、`PATCH /api/v1/users/me` 和邀请码预览；会话只按令牌哈希撤销，昵称不超过 40 个 Unicode 字符，预览不消费邀请码。
- 登录、邀请码预览／接受增加进程级按客户端地址的频率限制；服务端不记录令牌、邀请码、微信 code 或密钥。
- 小程序新增登录欢迎页和创建／加入家庭选择页；无令牌或会话过期进入登录页；无家庭不再直接跳创建页；登录失败不再回退到合成库存。
- 家庭管理页增加显示名保存和退出登录；管理员文案统一，邀请链接可在登录后保留邀请码。
- 当前证据：API 合成测试 127 通过、1 个真实 PostgreSQL 集成测试按常规 `npm test` 规则跳过；使用本地 Docker PostgreSQL 单独强制运行时 14/14 通过；工具测试 3/3 通过；全仓 lint/typecheck/build 通过。小程序真实开发者工具页面与双账号真机仍 `NOT_RUN`。
- 本地 Docker：`medbox-local-trial` API/DB healthy，`/live` 与 `/ready` HTTP 200；最新 API 镜像已包含本轮接口。
- 开发者工具导入包：`C:\Users\Admin\.codex\worktrees\phone-trial-readiness\medcial_box\.local-data\mini-local-9a27b898-eac3-46ec-bc13-9a7ffe25d0d4`。
- 审核修复：代理限流键、失效会话邀请码保留、预览 401 跳转、注销失败清理、异常邀请码编码和重复加入按钮已修复并重新通过检查。
- 下一步：在开发者工具编译并点击验证，再用两名真实微信用户验收共享流程；之后才进入 ECS 只读部署核查。

---

# 当前阶段状态

> 2026-09-27 录入体验更新：拍照主入口、常用项和收起的选填资料已实现；只填名称即可保存未知数量／有效期。后端 Ollama 适配器在本机 RTX 4070 SUPER 上用两张合成图分别识别药盒正面与有效期侧面，热态约 4–6 秒，草稿不会自动入库。独立审查发现的数量截断和无效日期问题已修复并通过专项测试。开发者工具选择图片、核对与保存仍待用户交互验证；真实药盒准确率和 ECS 识别仍为 `NOT_RUN`。云模型不会在本地故障时自动接收照片。本机 Ollama 当前监听 `:::11434` 且有 Windows Public 入站允许规则，真实照片前须收紧；未改系统网络配置。详见 `tasks/reports/2026-09-27-photo-first-local.md`。

> 当前交互阻塞：微信开发者工具 CLI 返回 `IDE service port disabled`，当前桌面控制接口也未暴露 Windows 原生窗口；需要用户在开发者工具“设置 → 安全设置”打开服务端口，才能继续自动化打开/编译和页面验证。后端、数据库、真实微信登录和本地模型均不受此阻塞影响。

> 2026-09-27 设备识别问题已定位：请求到达 API，但 Ollama 0.34.2 的 `qwen3.5:4b` 视觉 runner 在图像编码阶段 CUDA 内存分配失败并返回 500，页面原先只显示短 Toast。已切换本地默认模型为已验证的 `qwen3.5:0.8b`，上下文降为 2048；同时增加持久识别状态面板、失败原因与手工录入提示，并加强图片完整性校验。API 已重建且 `/ready` PASS。最新小程序文件已同步到 `.local-data/mini-local-0b105a2d-b233-486c-a9de-8bf26232da2c`，待重新编译后复测。

> 最新设备复测：开发者工具再次发起 `/api/v1/recognitions/medicine`，HTTP 200，响应约 4.9 秒；Ollama `qwen3.5:0.8b` 显示 100% GPU。数据库 medicines/batches 为 0，说明识别只产生草稿，尚未误入库。页面核对、保存和 Markdown 仍待下一步。

> 2026-09-27 本地优先更新：Docker Desktop Linux Engine 可用，`medbox-local-trial` 独立容器项目已启动，API 与 PostgreSQL 17 均健康。回环 `127.0.0.1:13301` 的 `/live`、`/ready` PASS，迁移数 5；数据库无公网端口。微信开发者工具已安装，Jovi 已在本地忽略文件填入 AppSecret；开发者工具触发的真实 `wx.login` → 后端 code 交换返回 200，数据库新增用户和会话各 1，标记 `PASS_DEVTOOLS_REAL_PROVIDER`。真机与远端 ECS 部署仍为 `NOT_RUN`。详见 `tasks/reports/2026-09-27-local-docker-login.md`。

> 2026-09-27 最新状态：手机试用准备本地部分 `PASS`；测试服务器和真实微信试用 `NOT_RUN`。下方为此前实施快照，历史测试数不代表本轮总数。

- 工作分支：`codex/phone-trial-readiness`，隔离工作树 `C:\Users\Admin\.codex\worktrees\phone-trial-readiness\medcial_box`；主目录未改动，本轮未提交或推送。
- 本地 PASS：导出竞态、原生动作锁与临时文件清理（21 项页面逻辑测试）；PostgreSQL 17.11 实库迁移、共享、并发及 API 冒烟；dump/restore 后 API 读取；全仓 lint/typecheck/test/build。`npm test` 在真实数据库环境下 API 124/124、工具 3/3，0 跳过。
- 代码／配置已备：PostgreSQL 17 CI 服务和必跑集成测试、隔离 Compose、回环 API、HTTPS 代理模板、非敏感小程序项目生成、备份与恢复脚本。远端 CI 和 Docker 脚本实际运行尚无证据。
- BLOCKED_INPUT：ECS、IP、AppID 与 `medbox-test.joviluma.com` 已提供；SSH 连接方式未提供。截图中的 A 记录位于阿里云 DNS 页面，而权威 NS 是 Cloudflare；公网 DNS 当前查不到该记录。网站备案、TLS 证书和服务端 AppSecret 也待确认。真实部署和双账号真机路径未执行。
- 本机限制：Docker Desktop 引擎无法启动；不以原生 PostgreSQL 测试代替 Compose 运行证据。
- 下一步：取得目标信息后先只读核查主机／证书／端口与现有代理，再执行独立测试部署、备份恢复演练、开发者工具与两台手机验收。P3 拍照识别仍未实现。
- 详细证据：`tasks/reports/2026-09-27-phone-trial-readiness.md`；执行说明：`docs/operations/staging-deployment.md`。

## 历史状态快照（2026-09-26）

- 当时阶段：P0 收口（PARTIAL / BLOCKED_RUNTIME）＋ P1 手动药箱与 Markdown 导出（PASS_CODE_ONLY，B1/B2 完成）＋ P2 家庭共享（PASS_CODE_ONLY / BLOCKED_RUNTIME，B3 代码与合成测试完成，待真实两账号验收）
- 交付顺序：P0 收口 → P1 手动药箱＋Markdown 导出 → P2 家庭共享 → P3 拍照识别 → P4 上线试用（见 `tasks/plans/2026-09-24-mvp-roadmap.md`）
- 完成证据：
  - `npm run lint` PASS（`--max-warnings=0`）。
  - `npm run typecheck` PASS。
  - `npm test` PASS（全仓 90 项 = 89 通过 + 1 跳过：P0 基线 7 + B1 新增 50 + B2 新增 7 + B3 新增 13 + D2/D3 决策落地新增 6 + 审核修复轮一新增 5 + 审核修复轮二新增 2；跳过项为真实 PostgreSQL 集成测试，设置 `TEST_DATABASE_URL` 后自动执行；其余全部为合成注入测试）。
  - 第二轮审核修复（2026-09-26，基线 cca45f0）：①Compose 移除 initdb.d 迁移挂载，迁移统一由 API 迁移器执行；②迁移 `005_add_created_at_columns.sql` 补齐 medicines/medicine_batches/dosage_notes 的 created_at；③批次端点增/改/删改为单连接事务并递增药品聚合版本（旧页面整体保存撞 409，不再静默删批次）；④导出预览页请求序号 + 选项快照使旧响应失效，复制/分享前按当前选项重新生成；⑤退出/移除与转让共用家庭行锁并在事务内复核角色，防止单 owner 被并发删除；⑥`db.ts` 抽出 `createDatabaseAdapter`（生产与集成测试共用），集成测试改用不撞 user_id 约束的数据证明单 owner 索引。
  - `npm run build` PASS（含小程序 `tsc --noEmit`）。
  - `docker-compose --env-file deploy/.env.example -f deploy/docker-compose.yml config --quiet` PASS（本机未安装 compose 插件，仅独立版 docker-compose v5.4.0）。
  - 无密钥 CI 已就绪：`.github/workflows/ci.yml`（Node 22，npm ci → lint → typecheck → test → build，零 Secrets）。
  - B1 后端核心：`002_core_inventory.sql` 迁移（含仅存令牌哈希的 sessions 表）；微信登录 `WechatGateway` 可注入（测试用假网关，无公开测试登录后门）；Bearer 认证 preHandler；家庭/药品/批次/个人剂量备注 CRUD（PUT 版本不符 409、跨家庭一律 404 不泄露存在性）；有效期纯函数（月末/跨年/年月精度/提前 30 天临期）。
  - B2 导出与小程序：`POST /api/v1/exports/markdown`（四分区、D1 存放位置、D4 归档排除、说明书核验区分、个人剂量权限、Markdown 转义）；小程序统一网络层/登录服务与五个页面（首页、创建家庭、药品录入/编辑、药品详情、批次编辑、导出预览：复制文本与写本地 .md + `wx.shareFileMessage` 回退复制）。小程序仅 typecheck 通过，未做开发者工具编译预览。
  - B3 家庭共享：`003_family_invites.sql`（一次性邀请凭据仅存 sha256、72h、原子消费防复用）；owner 生成邀请码（403 OWNER_ONLY 门槛）、明文接受（404 无效 / 410 过期与已用 / 409 已有家庭）、owner 移除成员（自移除与移除 owner 403；被移除者原令牌后续请求 404 FAMILY_NOT_FOUND 即时失效）；小程序 `pages/invite`（owner 生成/复制、转发卡片携带 code 自动填充、成员身份展示、移除/转让/退出）。
- 2026-09-24 审核修复轮（第二轮独立审核意见，全部落地）：①`Database.withTransaction` 单连接事务接口（server.ts 绑定 PoolClient；假池同步实现并记录 BEGIN/COMMIT），建家庭/接受邀请/转让/药品创建/药品编辑全部迁移至该接口；②药品编辑在事务内同步批次增删改（批次携带 id/version 乐观锁），修复"提示已保存但批次未生效"；③药品创建与初始批次同事务，杜绝半成品；④迁移 `004_family_single_owner.sql` 单 owner 部分唯一索引 + 转让事务内 `FOR UPDATE` 锁家庭行、重验双方角色、先降级后升级；⑤有效期按家庭时区 Asia/Shanghai 计算（`zonedDateParts`），新增上海本地午夜边界测试；⑥成员身份展示（昵称/稳定标签 + isSelf）与 owner 移除按钮；⑦新增 `integration-pg.test.mjs` 真实库集成测试（迁移、单 owner 约束、并发转让串行化；无 TEST_DATABASE_URL 自动跳过）。
- BLOCKED：Docker CLI 使用的 Docker Desktop Linux engine named pipe 未运行；本机没有 PostgreSQL／`psql`；未发现微信开发者工具。
- NOT_RUN：真实 PostgreSQL readiness 与迁移执行、微信开发者工具编译与页面预览、正式 AppID 真实登录、`.md` 真机分享、真实两账号邀请/共享/移除验证（需合法 HTTPS 测试环境，没有实测不标完整 PASS）、外部模型与药品查询 API、生产部署。
- 当前基线：Git 已初始化；D2/D3 决策与审核修复轮改动随本轮由主理人提交并推送。npm 锁文件已生成，依赖包缓存位于允许的 `E:\Claude_allow\Download\medcial_box\npm-cache`。
- 允许范围：当前本地项目文件、合成数据、本地依赖缓存目录 `E:\Claude_allow\Download\medcial_box`。
- 不包括：真实微信账号、真实用户照片／健康信息、真实线上 API 密钥、生产网站或服务器变更、推送／发布。
- 下一步：真实环境补证（Docker 引擎恢复后设 `TEST_DATABASE_URL` 跑 `integration-pg.test.mjs`；装微信开发者工具用 `touristappid` 预览；AppID 批复后真机验收），随后评估 P3 拍照识别排期。


### 2026-10-04 本地整合补充

远端功能进展以 f5e17e5 为基线；本地中文日期滚轮、OCR 药名清洗、支(tube)单位及迁移029一并保留。先前本地真机与构建证据见 docs/operations/04-RPT-Android识药单位日期与Release验证.md；不视为本次整合后验证。真实身份、通知及正式部署仍待验收。
