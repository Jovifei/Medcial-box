# 当前状态 · 2026-10-15

1.0.5+7为电脑验证候选：新建录入始终空白，旧草稿显式导入；拍扫错误保留固定分类，资料查询等待预算一致；Flutter照片先确认归属再复制，完成回执前不上传，丢回执同键恢复。版本由VERSION.json与lint一致性检查约束，新提交中文优先。

- 本机本批Node：mini459PASS、API279PASS/17资源SKIP、tooling113PASS/24平台SKIP；lint/typecheck通过。独占PG负载必须另看最终提交CI，不把本机跳过计为PASS。
- Flutter收口全量736PASS/19平台SKIP、analyze通过；实际Android35原生helper四项PASS（无业务身份）。4项只补文件生命周期平台层，不替代剩余平台/真机验收。普通main入口包将在本提交后重建，集成测试入口包禁止交手机；Release仍无正式签名。
- 同一网页会话已完成完整方案和源码初审，指出的照片确认/冷恢复问题已纳入修复与真实临时文件测试；冻结源码后的最终CI与独立复审仍需以具体回执为准。
- 手机已由Jovi拔出，今天只电脑测试、生成候选包；明天真机验收。两个真实家庭及资料本轮未修改。Android优化包技术构建与签名准入分开，未签名候选不能直接安装。
- 线上仍pr3-1867792；条码库20条且无外部Key；原有模型桥的合成探测通过后私有连接再次断连，稳定在线未解决，手机相机到API失败类别尚未证实。不能称拍照识别已修复或项目已上线。
- 原部署准备拒绝、旧额外status/confirm竞态仍BLOCKED，不重试或换入口。Hub revision连接拒绝，保留pending不自动重试。

计划与资源指引见[拍扫验证计划](../docs/operations/26-PLAN-拍扫识别与上线验证-20261015.md)、[条码库开通指引](../docs/operations/27-GUIDE-条码资料库私有配置.md)、[独审收口](../docs/operations/30-RECEIPT-独审收口与电脑验收-20261015.md)。6fe旧候选CI三项成功已保留，新修复必须由新SHA的最终CI/复审验收。

## 2026-10-14 主线整合记录

主线归一已完成：PR5于2026-10-14合入main `ebe3df2`（源候选`2a4f047`），PR3自动标记merged，PR4作为已包含内容关闭。E原目录已切至main并同步；4个旧远端分支已删除，远端仅main。8个冗余本地分支删除，独有历史/旧脏工作区以2个archive分支保留。

候选CI [38578731818](https://github.com/Jovifei/Medcial-box/actions/runs/38578731818) 的verify/backup-docker/flutter全部SUCCESS，主线合并树与候选树一致。当前文档提交只补充完成记录；最新Git HEAD与CI状态可在GitHub直接核验。详见[本次整合记录](../docs/operations/24-RECEIPT-main-consolidation-20261014.md)。
- 已有功能：家庭库存/批次/效期、私照草稿、计划提醒、导出；本轮整合多家庭会话、邀请落地与底部导航、升级恢复证据及资料查询修复。
- 已补齐：导航子页高亮与对比度，精简四等分 CSS；未调用用途猜测函数和 4 个旧声明式 fixture 删除。有效回归及审计证据保留。
- 仍未完成：服务器版本/迁移与客户端匹配、保数据部署、真实双账号双设备加入切家与照片识别、通知实收、正式 Android 签名/保数据安装及完整平台验收。
- 已知安全阻断：旧额外 status/confirm 在途撤权实验、保数据部署脚本准备的自动审批拒绝均保持 BLOCKED；不重试、不换入口、不删除断言。
- 本轮实际本机：mini424PASS、API269PASS/16SKIP、tooling112PASS/24SKIP，lint/typecheck/buildPASS。GitHub上述精确候选CI补齐正常合成PG/Linux恢复/Flutter检查，不替代真机或受限实验。

---

历史执行记录已移至[状态归档](archive/2026-10-14-status-history.md)。
