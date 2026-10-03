# 当前收尾矩阵 · 2026-10-03

核对源码：`codex/flutter-ui-prototype / 736d7623435e2a38e3ebb51859574d43dffa0120`。原云端核对表中的 517dbf2 统计保留为对应版本证据；本文以本段补充和修订项反映当前 HEAD。

**状态：IMPLEMENTATION_AND_VERIFICATION / PARTIAL。尚未达到 LOCAL_RC_READY、STAGING_READY 或 V1_DELIVERED。** 已关闭的代码缺陷与尚未执行的真实验收分开列出；自动化通过不等于家庭交付。

## 当前 HEAD 与本机补充核验

- 2026-10-04 本机未提交复核：Flutter 补齐“凝胶”药名抽取、选项式库存单位和中文日期滚轮；共享 API/小程序单位契约新增 `tube`，迁移 `029_tube_quantity_unit.sql`。当前实现与验证见[Android 新报告](../../../docs/operations/04-RPT-Android识药单位日期与Release验证.md)。这不是 GitHub 已发布提交。
- Release R8 现已在本机构建成功，APK 编译时传入 `API_BASE_URL=https://medbox-test.joviluma.com`。该域名仍未解析，Release 仅为 debug 证书构建，未安装为发布包；生产 API 与正式签名仍未验收。
- GM1910 上最终 Debug APK 使用保留数据方式更新，首次安装时间不变；本机合成 OAuth 网关、隔离家庭读取及中文日期选择通过。真实微信用户和原始药盒照片的识别准确率仍 `NOT_RUN`。

### 2026-10-03 已提交基线

- 本地工作区已从 `b90bc1d` 快进到 `736d762`；该提交的 GitHub Actions [run 37107940730](https://github.com/Jovifei/Medcial-box/actions/runs/37107940730) 页面状态为 Success，`verify` 与 `flutter` 作业均成功。
- 计划创建幂等修复已合入：迁移 `028_medication_plan_create_receipts.sql` 保存用户/家庭/请求键、规范化载荷哈希和原始响应；相同键同内容回放原响应，不同内容冲突。后续数据库增量还包含 `029_tube_quantity_unit.sql`；部署顺序为应用待用迁移 → API → 客户端。
- 本机 Windows 小程序验收：运行时测试 220/220、lint、typecheck、官方 WXML/WXSS 编译 51 文件均 PASS；隔离项目由 DevTools CLI 接受打开。页面人工点击未验证。
- 本机 API 容器内部 readiness HTTP 200，但 Windows 对映射端口 127.0.0.1:13301 收到空 HTTP 响应；因此登录/家庭/API 页面联调 NOT_RUN。完整记录见 [本地验证报告](../../../docs/operations/02-RPT-本地微信小程序导入与编译验证.md)。
- 本地验证未向微信平台上传或发布；真实账号/两台手机、通知送达、系统分享、正式签名、HTTPS 部署和数据库/图片恢复保持 NOT_RUN。
- 本机 Android 已在 OnePlus GM1910 安装并启动当前源码 Debug APK，首次安装时间未变；这只证明保留数据安装和进程启动。Flutter 本机测试 259 PASS/9 Windows 环境失败；Release R8 因 ML Kit 缺类未生成 APK。完整记录见 [Android 实体机报告](../../../docs/operations/03-RPT-Android实体机安装与启动验证.md)。

以下历史逐项证据仍按其精确来源提交与测试环境解读；本机 220 项小程序测试和 51 个文件的官方编译为 Windows 工作区新证据。

## 前序云端审查来源与约束（517dbf2）

- 只使用 GitHub 当前分支的云端源码副本、隔离 PostgreSQL schema、合成 HTTP/通知/分享/存储测试适配器；没有访问或覆盖所有者 Windows 工作区。
- 原主工作区的未跟踪 AGENTS、overview 和工具状态未读写、未加入提交。本文不把云端副本称为原工作区。
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

对应证据：[仅接收提醒](09-receive-only-android-reminders.md)、[导出生命周期](10-export-owned-file-lifecycle.md)、[家庭清理](11-family-notification-cleanup.md)、[历史纠正](flutter-history-correction-2026-10-03.md)。其余独立报告在 `tasks/reviews/2026-10-03-*.md`。

## 当前门禁能证明什么

| 门禁 | 实际结果与边界 |
|---|---|
| 根 lint/typecheck/build | `736d762` 的 GitHub Actions run 37107940730 为 Success；本轮本机仅执行小程序范围检查 | 未在本机重跑全仓门禁 |
| 小程序运行时 | 本机 Windows 220/220 PASS；官方 WXML/WXSS 编译 51 文件 PASS；隔离项目 DevTools CLI open 成功 | 页面人工点击、微信账号与 API 主机连通仍未验收 |
| API / 工具 | 517dbf2 之前的严格隔离 PostgreSQL 与工具证据保留为该版本结果；736d762 精确提交 CI 成功 | 本轮未重跑完整 API/严格 PG 套件 |
| Flutter | GitHub Actions `736d762` 作业 Success；本机 analyze PASS；当前全量测试 266 PASS/9 环境失败 | 8 个导出临时文件测试被 Windows symlink 权限 1314 阻断，1 个锁文件版本断言受 CRLF 影响 |
| 精确回放 | 每批独立补丁在其精确已发布父提交应用，变更文件SHA-256核对；生产/测试内容在最终报告父SHA更新后未改变 |
| 官方小程序编译 | 本机 Windows `npm run check:miniprogram` 调用 `wcc`/`wcsc` 编译 51 文件 PASS | 不证明页面交互或真机运行 |
| Android构建 | Release `minifyReleaseWithR8` PASS；本机 Debug 使用 API_BASE_URL 与回环转发 | Release 使用 debug 证书；正式签名、可达的生产 HTTPS 与真实微信 OAuth 仍未验收 |
| 正式安装/发布 | GM1910 上保留数据更新 Debug APK，首次安装时间不变；API 合成连接和中文日期滚轮 PASS | Release APK 未安装；相机/原始药盒照片准确率、生产 API、真实家庭与通知保持 NOT_RUN |

## 未关闭的实际代码项

1. **C1 跨重启恢复**：计划创建的幂等回执、原请求显式重试已在 `736d762` 完成；通用 Flutter 表单草稿、旧请求孤儿标记恢复与安全核对仍需补齐。不得自动重放或以改载荷复用旧键。
2. **C3 Flutter计划表单**：源码仍明确省略星期编辑；新建没有从库存绑定medicineId，表单只在Widget内存中。文档承诺的指定星期、药箱选择和按会话/家庭隔离的持久草稿仍需补齐；不能用227项测试数代替这三项能力。
3. **C4跨进程原始文件**：本轮只登记当前进程实际创建的原始文件。崩溃/被杀/重启遗留与旧版本未登记文件不会扫描删除。仍需精确持久所有权设计，不能用宽泛前缀清空用户文件；插件和收件人副本也不属于本应用回收范围。
4. **异常退出跨重启**：服务端撤销和安全存储删除同时失败时，同进程已阻止重新进入家庭页；若凭据跨进程仍留存，重启后的处理仍是既有错误恢复限制。真实安全存储行为尚未验收。

已确认的药品创建、照片待补、实例历史、本人档案唯一性和库存恢复修复继续保留，不再重复实现；真实药盒质量、布局、分享和多设备效果仍须下面的验收。

## C0–C7剩余矩阵

| 工作包 | 当前可确认 | 仍需完成或验收 |
|---|---|---|
| C0 工程归一 | 云端精确源码/父提交/变更清单及独立证据可回放 | 所有者工作区、生产配置和发布manifest仍需在对应环境核对 |
| C1 可靠性 | 会话、提醒、历史/确认重试与计划创建回执有精确提交证据 | 通用表单草稿/孤儿恢复、异常持久状态及最终汇总门禁；不标整包关闭 |
| C2 简洁交互 | 当前代码已有首页直达单页添加等改动 | 当前版本320–430宽、大字体、键盘、返回/导航与真实拍扫图像验证未完整执行 |
| C3 Android双端 | 四导航、照护契约、历史纠正、最小提醒投影及点击权限有生产页面/仓库测试 | 上述计划表单缺口；真实后台/锁屏/重启/精确闹钟/拒绝权限及两端一致性 |
| C4 资料/导出恢复 | 同快照格式、进程内文件所有权和恢复身份边界有自动化证据 | 跨进程文件清理、真实识别/扫码/说明书质量、系统分享和数据库＋图片恢复 |
| C5 门禁/冻结 | 按具体提交记录CI与本地门禁，未把缺工具算PASS | 当前代码项关闭、官方小程序编译、配置正确且有正式签名的候选及manifest |
| C6 独立部署 | 保留已有部署/备份runbook | 独立HTTPS、真实服务配置、成对数据库/照片备份恢复与重启持久NOT_RUN |
| C7 家庭试用 | 保留既有试用清单 | 两真实账号、两手机、真实身份/微信模板/Android通知/相机/分享、Jovi体验确认NOT_RUN |

源码已包含药箱公开AppID，不再沿用“仍是touristappid/未确认AppID”的旧摘要。AppID存在不证明实际code2session、后端凭据、模板可用或消息送达；本轮没有读取这些私有配置。

后续顺序：补既定Flutter表单与安全跨重启恢复 → 补剩余跨进程文件清理 → 重跑受影响门禁并冻结候选 → 在获授权的真实环境进行平台/设备/部署/恢复验收。未经真实必交项验收，不将项目或C0–C7全部勾选完成。
