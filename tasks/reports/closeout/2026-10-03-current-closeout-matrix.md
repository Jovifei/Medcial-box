# 当前收尾矩阵 · 2026-10-03

核对源码：`codex/flutter-ui-prototype / f5e17e581df865b2fedf247d00fba1a5a6036981`。本文件统一当前判断，下面列出的旧报告保留各自当时的环境与证据，不用旧统计推导当前完成。

**状态：IMPLEMENTATION_AND_VERIFICATION / PARTIAL。尚未达到 LOCAL_RC_READY、STAGING_READY 或 V1_DELIVERED。** 已关闭的代码缺陷与尚未执行的真实验收分开列出；自动化通过不等于家庭交付。

## 本轮来源与约束

- 云端修复使用当前分支源码、隔离PG和合成适配器；后续Windows验证使用精确提交的隔离worktree，不覆盖原工作区。
- 原工作区未提交/未跟踪文件和本地工具状态未纳入业务提交或覆盖；没有输出私有环境文件或密钥。
- 只向既有功能分支普通非强制提交；未合并 main、未部署、未安装或清空用户设备、未调用真实消息发送者或传输真实家庭资料。
- 依据仍是 [v1收尾计划](../../plans/2026-10-02-project-closeout.md)。未扩入医疗建议、自动扣库存、多家庭或 iOS。

## 已发布的独立修复

| 提交 | 已验证范围 | 精确提交 CI |
|---|---|---|
| [f7d1ea3](https://github.com/Jovifei/Medcial-box/commit/f7d1ea34d853a40917e452b7b44a696f41a82fbd) | 小程序晚401、auth/me、异步缓存/照片及同令牌家庭代次 | [37099606072](https://github.com/Jovifei/Medcial-box/actions/runs/37099606072) PASS |
| [bcb7992](https://github.com/Jovifei/Medcial-box/commit/bcb7992a26307da3e6410718375a81c7fd93d310) | 提醒发送前设置/成员/租约复核，不确定结果不盲重试；增量迁移027 | [37100475431](https://github.com/Jovifei/Medcial-box/actions/runs/37100475431) PASS |
| [2e0b14a](https://github.com/Jovifei/Medcial-box/commit/2e0b14ad55d67af92b1d8df28a24fae2a381c004) | Flutter照护账户ID与成员行ID区分，查看/管理/接收权限契约 | [37100784413](https://github.com/Jovifei/Medcial-box/actions/runs/37100784413) PASS |
| [045d5c8](https://github.com/Jovifei/Medcial-box/commit/045d5c8b198a94b40ff7b3ca63bfb8f9f826fdb3) | 双端确认丢响应后显式重试原操作，确认ACK与后续刷新失败分开 | [37102314214](https://github.com/Jovifei/Medcial-box/actions/runs/37102314214) PASS |
| [293a5c7](https://github.com/Jovifei/Medcial-box/commit/293a5c7dec159b191e707c4393b15c48e61b175c) | Flutter有管理权的已服/跳过历史纠正，保留原快照与事件 | [37102554212](https://github.com/Jovifei/Medcial-box/actions/runs/37102554212) PASS |
| [abec40a](https://github.com/Jovifei/Medcial-box/commit/abec40aa13f55dbe139ebc79f61360dbffff0818) | 最小仅接收提醒投影；点击重新鉴权，不扩大完整计划可见性 | [37104271859](https://github.com/Jovifei/Medcial-box/actions/runs/37104271859) PASS |
| [e073761](https://github.com/Jovifei/Medcial-box/commit/e073761bea5a4193209c3bdfed2005df7ba41e6b) | 原始导出文件的进程内精确所有权、分享租约与复制/分享/恢复身份边界 | [37105653550](https://github.com/Jovifei/Medcial-box/actions/runs/37105653550) PASS |
| [517dbf2](https://github.com/Jovifei/Medcial-box/commit/517dbf2d9369d781c5b86736a0266eafb99abaf0) | 明确家庭失效的通知/缓存清理、清理重叠/失败恢复、同令牌竞争与退出路由 | [37105838836](https://github.com/Jovifei/Medcial-box/actions/runs/37105838836) PASS |
| [736d762](https://github.com/Jovifei/Medcial-box/commit/736d7623435e2a38e3ebb51859574d43dffa0120) | 计划创建事务回执、双端原意图显式重试、ACK/草稿清理与身份边界；迁移028 | [37107940730](https://github.com/Jovifei/Medcial-box/actions/runs/37107940730) PASS |
| [d1fa41f](https://github.com/Jovifei/Medcial-box/commit/d1fa41f14df414173b1334c13699779acd898fb5) | Flutter指定星期、库存绑定、身份隔离普通草稿与最小PUT绑定契约 | [37118979454](https://github.com/Jovifei/Medcial-box/actions/runs/37118979454) PASS |
| [61cc001](https://github.com/Jovifei/Medcial-box/commit/61cc001ed6286ed72e5120e6d98905f659a0c65b) | 持久身份代次、退出/迟到登录与已验证归属离线草稿 | [37119024852](https://github.com/Jovifei/Medcial-box/actions/runs/37119024852) PASS |
| [3ddceac](https://github.com/Jovifei/Medcial-box/commit/3ddceac42e181f391f28017abf8ccde3bedc4043) | 精确登记导出原件重启恢复、共享写入/分享租约 | [37119055523](https://github.com/Jovifei/Medcial-box/actions/runs/37119055523) PASS |
| [a30c7cb](https://github.com/Jovifei/Medcial-box/commit/a30c7cb6052d2f5d8b008ffe736c27d9ee745c0a) | 小程序保留草稿失败时保留页面/字段，可恢复重试 | [37132980139](https://github.com/Jovifei/Medcial-box/actions/runs/37132980139) PASS |
| [18d3b83](https://github.com/Jovifei/Medcial-box/commit/18d3b83595e9e0f7a8ae19b8a183450d4162e874) | 窄屏大字保留完整单位与开封状态标签 | [37133167092](https://github.com/Jovifei/Medcial-box/actions/runs/37133167092) PASS |
| [5c5d11a](https://github.com/Jovifei/Medcial-box/commit/5c5d11a23a0e722ef617901fc1bb620d2dc20fd6) | 返回时等候草稿确认、失败重试、原身份与单次离页意图 | [37133215410](https://github.com/Jovifei/Medcial-box/actions/runs/37133215410) PASS |
| [82fc15b](https://github.com/Jovifei/Medcial-box/commit/82fc15bcac626f7d7a06663aca282805ede65230) | 同身份跨页面队列串行、换身份隔离与录入入口防重复跳转 | [37133258634](https://github.com/Jovifei/Medcial-box/actions/runs/37133258634) PASS |
| [6ec8d7a](https://github.com/Jovifei/Medcial-box/commit/6ec8d7a09ed5f1591bbff392fd8acbadc7b7dc2e) | 库存/照片原始保存意图贯穿等待、请求与清理；保留计划ACK语义 | [37133305543](https://github.com/Jovifei/Medcial-box/actions/runs/37133305543) PASS |
| [083f961](https://github.com/Jovifei/Medcial-box/commit/083f961398ebdf5aed240cc998600a70820191a6) | 六个未选OCR脚本精确R8规则、中文脚本契约和优化release CI门禁 | [37136225113](https://github.com/Jovifei/Medcial-box/actions/runs/37136225113) PASS |
| [f5e17e5](https://github.com/Jovifei/Medcial-box/commit/f5e17e581df865b2fedf247d00fba1a5a6036981) | Windows完整路径/CRLF断言、精确符号链接能力报告及独立非链接保留用例 | [37136392579](https://github.com/Jovifei/Medcial-box/actions/runs/37136392579) PASS |

新增证据：[平台编译与宿主测试](17-platform-build-and-fixture-verification.md)、[计划表单](13-flutter-plan-form-parity.md)、[重启身份与离线草稿](14-restart-identity-and-offline-drafts.md)、[导出重启恢复](15-owned-export-restart-recovery.md)、[录入可靠性与实际渲染](16-entry-reliability-and-visual-verification.md)。旧报告中的“未发布/未执行CI”是冻结时事实，后续结果以本表为准。

既有证据：[计划创建幂等](12-plan-creation-idempotency.md)、[仅接收提醒](09-receive-only-android-reminders.md)、[导出生命周期](10-export-owned-file-lifecycle.md)、[家庭清理](11-family-notification-cleanup.md)、[历史纠正](flutter-history-correction-2026-10-03.md)。其余独立报告在 `tasks/reviews/2026-10-03-*.md`。

## 当前门禁能证明什么

| 门禁 | 实际结果与边界 |
|---|---|
| 根 lint/typecheck/build | 最新小程序两文件完整根门禁PASS；最新精确提交CI verify按上表记录 |
| 小程序运行时 | 230 PASS，独立聚焦10；不是官方WXML/WXSS编译或真机点击 |
| API / 工具 | 计划表单阶段严格隔离PG参与：API382、tooling6 PASS；独立PG150项/12套 PASS。后续身份/导出/C2不改Node/API/SQL，保留对应源码证据，不伪称重复本地执行 |
| Flutter | 最新Linux精确提交CI671 PASS、analyze无诊断，15项真实符号链接安全场景全部运行；C2冻结时的独立76为对应源码历史证据，不与671累加 |
| Windows宿主测试 | 精确f5e17e5：656 PASS / 0 FAIL / 15 SKIPPED，仅errno1314创建链接能力不足；其它IO错误照常失败。独立非链接保存/文件/目录断言仍运行，跳过不算通过 |
| 实际渲染 | C2快照6ec8d7a的生产页面源码生成45张图；后续仅规则/测试/CI变更，不改渲染源码，布局14项和返回15项通过；320/360/430逻辑宽、100%/200%字号。仓库CJK字体映射及300逻辑像素键盘占位，不是原生设备/输入法或WeChat截图 |
| 精确回放 | 五份C2补丁从3ddceac按顺序回放，每阶段tree及文件SHA-256一致；C2公开代码tree为31c43cd1b427437d8e85acf78a95628d42e1dd51；新增两批逐父提交核对，最新代码tree为d567d0d6de02039d40ae352e363fea78aa5215b6 |
| 官方小程序编译 | Windows精确6ec8d7a强制REQUIRE_WECHAT_COMPILER=1，25WXML+26WXSS共51 PASS；后续两批未改mini。云环境仍缺工具；WeChat JS/模拟器页面NOT_VERIFIED |
| Android构建 | 最新精确提交CI及Windows隔离worktree的debug和R8优化release编译PASS；仅技术构建门禁。最终合并release清单已有INTERNET，无需新增权限 |
| 正式安装/发布 | NOT_RUN。实际API_BASE_URL仍为空，release沿用debug签名，未安装且未做原生中文OCR；功能发布标签按双端同步策略保留，与原生包版本分别记录 |

## 已修复代码与保留边界

1. **C3计划表单**：指定星期、库存选择/medicineId、普通草稿和当前编辑权限已补齐；省略绑定保留原值，显式null解绑，已删除旧关联按明确意图处理。详见报告13。
2. **重启身份与草稿**：版本化凭据匹配持久接受代次和完整API地址；明确退出立即关闭会话，迟到响应不能复活。新格式正常恢复，只有先前服务端验证且匹配的归属可以离线编辑本机草稿，联网写入须重新验证。全部持久写入同时失败仍不能承诺跨重启退出成功，界面说明并可重试；实际Android存储待验。
3. **旧格式边界**：旧原始令牌无可信来源地址，不能自动发到当前地址验证，需重新连接。未知草稿字节保留隔离；仅服务端重新验证的相同账号/家庭/API范围可采用匹配计划草稿，旧无归属药品草稿不猜所有者、不自动展示。
4. **C2录入**：小程序存储失败不丢失离页保护；Flutter完整大字标签、失败/重复返回、同身份多个队列及异步保存原始身份均有回归。队列协调限一个Dart isolate、同一LocalAppStore实例和相等原身份范围；原身份已发出的服务端请求不能被客户端撤回。详见报告16。
5. **C4仍PARTIAL**：精确登记且内容证据一致的完整原件可恢复清理；突然中断、ready登记未完成、替换或旧未登记文件保留并报告。不会按前缀递归删除，不清理插件/收件人副本。模糊文件只阻止新导出，不阻止登录；已知活跃写入/分享的身份清理屏障继续有效。多进程导出、断电持久性和同权限恶意进程防护未获证明。

计划创建继续使用736d762的原始意图事务回执；清理私有内容后保留的操作标记不含药名/剂量/档案。用户另行确认开始新意图仍可能与先前请求重复，不能称安全重试。正式启用先应用迁移028及对应API，再升级客户端；库存绑定编辑需d1fa41f及之后的API。

药品创建、照片待补、实例历史、本人档案唯一性和库存恢复的既有修复保留，不重复实现；真实质量、多设备和平台效果仍需验收。

## C0–C7剩余矩阵

| 工作包 | 当前可确认 | 仍需完成或验收 |
|---|---|---|
| C0 工程归一 | 云端回放与隔离本机源码/锁文件核对，原工作区保留 | 正式API/签名、完整发布manifest及最终候选确认 |
| C1 可靠性 | 本轮会话、提醒、历史、创建/确认重试、重启和录入异步边界有行为及相关PG证据 | 目标平台持久状态与整体验收；不标整包关闭 |
| C2 简洁交互 | 320–430宽、100%/200%字体、模拟键盘占位及返回/草稿回归和最终源码引擎图 | 原生系统Back、实际输入法/字体、WeChat渲染与真实拍扫验收 |
| C3 Android双端 | 四导航、权限/提醒投影、历史纠正、星期/库存绑定/持久及离线草稿已实现 | 真实后台/锁屏/重启/精确闹钟/拒绝权限及两端一致性 |
| C4 资料/导出恢复 | 同快照格式、精确原件所有权、重启登记恢复和身份边界有自动化证据 | 模糊中断文件保留边界、真实识别/扫码/说明书、系统分享和数据库＋图片恢复 |
| C5 门禁/冻结 | 精确CI、官方51文件编译、Windows能力分项、R8优化release构建均有记录 | 正式API/签名候选及manifest、原生OCR/页面验证；Windows15项不冒充PASS |
| C6 独立部署 | 保留已有部署/备份runbook | 独立HTTPS、真实服务配置、成对数据库/照片备份恢复与重启持久NOT_RUN |
| C7 家庭试用 | 保留既有试用清单 | 两真实账号、两手机、真实身份/微信模板/Android通知/相机/分享、Jovi体验确认NOT_RUN |

源码已包含药箱公开AppID，不再沿用“仍是touristappid/未确认AppID”的旧摘要。AppID存在不证明实际code2session、后端凭据、模板可用或消息送达；本轮没有读取这些私有配置。

后续顺序：核对精确提交CI与候选身份 → 在目标环境构建并核对版本/API/签名及原工作区 → 官方小程序与真实设备/平台验收 → 独立部署与恢复验收。未经真实必交项验收，不将项目或C0–C7全部勾选完成。
