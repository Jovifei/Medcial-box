# 当前收尾矩阵 · 2026-10-03

核对源码：`codex/flutter-ui-prototype / 517dbf2d9369d781c5b86736a0266eafb99abaf0`。本文件统一当前判断，下面列出的旧报告保留各自当时的环境与证据，不用旧统计推导当前完成。

**状态：IMPLEMENTATION_AND_VERIFICATION / PARTIAL。尚未达到 LOCAL_RC_READY、STAGING_READY 或 V1_DELIVERED。** 已关闭的代码缺陷与尚未执行的真实验收分开列出；自动化通过不等于家庭交付。

## 本轮来源与约束

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
| 根 lint/typecheck/build | 当前517dbf2精确提交CI verify PASS；云本地完整根门禁在abec40a通过，随后两批只改Flutter及证据 |
| 小程序运行时 | 195 PASS（不是官方WXML/WXSS编译或真机点击） |
| API / 工具 | 严格隔离PG参与的完整运行：API317、tooling6 PASS；独立PG汇总108项/11套 PASS，无可选PG跳过冒充严格成功 |
| Flutter | 517dbf2等价最终代码完整227 PASS，analyze无诊断；家庭新增44、独立额外边界探针9均PASS；C4新增56 PASS |
| 精确回放 | 每批独立补丁在其精确已发布父提交应用，变更文件SHA-256核对；生产/测试内容在最终报告父SHA更新后未改变 |
| 官方小程序编译 | 本云环境缺WeChat DevTools，SKIPPED；包装脚本退出0不能改记PASS。旧Windows报告的51文件仅属当时版本/环境证据 |
| Android构建 | 云本地无Android SDK，APK命令明确BLOCKED；当前517dbf2精确提交CI Flutter analyze/test/debug APK均PASS，与云本地缺SDK分别记账 |
| 正式安装/发布 | NOT_RUN。CI没有传API_BASE_URL，release配置仍引用debug签名；不能把该APK当作配置好、签名好的正式候选 |

## 未关闭的实际代码项

1. **C1计划创建重试**：当前API和双端创建入口没有计划创建操作键；小程序已复现首个请求被接受但响应丢失后，再保存会产生第二份计划。正在单独修复服务端事务回执、改变内容拒绝及两端相同意图的显式重试。后续读/通知失败不能再变成新建。
2. **C3 Flutter计划表单**：源码仍明确省略星期编辑；新建没有从库存绑定medicineId，表单只在Widget内存中。文档承诺的指定星期、药箱选择和按会话/家庭隔离的持久草稿仍需补齐；不能用227项测试数代替这三项能力。
3. **C4跨进程原始文件**：本轮只登记当前进程实际创建的原始文件。崩溃/被杀/重启遗留与旧版本未登记文件不会扫描删除。仍需精确持久所有权设计，不能用宽泛前缀清空用户文件；插件和收件人副本也不属于本应用回收范围。
4. **异常退出跨重启**：服务端撤销和安全存储删除同时失败时，同进程已阻止重新进入家庭页；若凭据跨进程仍留存，重启后的处理仍是既有错误恢复限制。真实安全存储行为尚未验收。

已确认的药品创建、照片待补、实例历史、本人档案唯一性和库存恢复修复继续保留，不再重复实现；真实药盒质量、布局、分享和多设备效果仍须下面的验收。

## C0–C7剩余矩阵

| 工作包 | 当前可确认 | 仍需完成或验收 |
|---|---|---|
| C0 工程归一 | 云端精确源码/父提交/变更清单及独立证据可回放 | 所有者工作区、生产配置和发布manifest仍需在对应环境核对 |
| C1 可靠性 | 本轮会话、提醒、历史与显式确认重试有红绿回归和相关真实PG证据 | 计划创建重试、异常持久状态及最终汇总门禁；不标整包关闭 |
| C2 简洁交互 | 当前代码已有首页直达单页添加等改动 | 当前版本320–430宽、大字体、键盘、返回/导航与真实拍扫图像验证未完整执行 |
| C3 Android双端 | 四导航、照护契约、历史纠正、最小提醒投影及点击权限有生产页面/仓库测试 | 上述计划表单缺口；真实后台/锁屏/重启/精确闹钟/拒绝权限及两端一致性 |
| C4 资料/导出恢复 | 同快照格式、进程内文件所有权和恢复身份边界有自动化证据 | 跨进程文件清理、真实识别/扫码/说明书质量、系统分享和数据库＋图片恢复 |
| C5 门禁/冻结 | 按具体提交记录CI与本地门禁，未把缺工具算PASS | 当前代码项关闭、官方小程序编译、配置正确且有正式签名的候选及manifest |
| C6 独立部署 | 保留已有部署/备份runbook | 独立HTTPS、真实服务配置、成对数据库/照片备份恢复与重启持久NOT_RUN |
| C7 家庭试用 | 保留既有试用清单 | 两真实账号、两手机、真实身份/微信模板/Android通知/相机/分享、Jovi体验确认NOT_RUN |

源码已包含药箱公开AppID，不再沿用“仍是touristappid/未确认AppID”的旧摘要。AppID存在不证明实际code2session、后端凭据、模板可用或消息送达；本轮没有读取这些私有配置。

后续顺序：关闭计划创建幂等 → 补既定Flutter表单 → 补剩余异常持久状态 → 重跑受影响门禁并冻结候选 → 在获授权的真实环境进行平台/设备/部署/恢复验收。未经真实必交项验收，不将项目或C0–C7全部勾选完成。
