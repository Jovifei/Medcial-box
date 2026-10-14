# 上线前 API 模块与有界压力矩阵

代码起点：main `2cf4e3e`，2026-10-14。清单依据 `apps/api/src/app.ts` 的16个路由注册模块及现有测试文件；列出测试不等于本轮已执行。新增文件为 `apps/api/test/integration-pg-release-load.test.mjs`，无新support、生产代码或依赖。

| 路由模块 | 主要功能 | 现有测试入口（apps/api/test） | 新有界负载覆盖 |
|---|---|---|---|
| health | live/ready | health.test.mjs | 不计入业务压力，已有门禁 |
| pilot-readiness | 交付证据读取 | scripts的family-pilot/release/upgrade门禁 | 不伪造发布证据 |
| auth | 微信会话、设备配对、昵称 | auth、device-links、device-sessions、integration-pg | stub微信登录、稳定会话 |
| families | 创建、当前家庭、列表及显式切换 | families、multi-family-context-contract | 创建及当前读取，无并发切家庭 |
| invitations | 邀请预览、加入、退出 | invitations、integration-pg、multi-family-context-contract | 不并发改变成员关系 |
| medicines | CRUD、阈值、归档 | medicines、phase1-narrow-update、integration-pg、integration-pg-tags | 创建、读回、窄阈值写入及非目标字段保真 |
| batches | 数量、期限、拆包/开封 | batches、integration-pg-quantity、medicine-inventory-rules | 独立批次数量写入、旧版本409及读回 |
| dosage-notes | 私人/家庭备注 | notes、integration-pg | 现有用例；不声称新增全覆盖 |
| exports | 同快照Markdown/CSV/PDF | exports、export-snapshot、integration-pg-exports | 同快照Markdown/CSV内容、跨家庭拒绝；PDF另测 |
| recognitions | 包装/说明书识别 | recognitions、phase1-recognition-boundaries | 合成图像封套+stub返回待确认；不测真实模型 |
| inventory | 设置、盘点、补货、回收站及审计 | inventory-routes、inventory-lifecycle-inputs、integration-pg | 设置写后读、药品回收站正常恢复；盘点/补货另测 |
| medicine-catalog | 家庭/本机/外部资料候选 | medicine-catalog、medicine-catalog-routes、integration-pg-local-catalog | 本机stub候选请求；真实商品提供者另验 |
| reminders | 订阅、设置、发送状态 | reminder-routes、subscribe-messages、integration-pg-reminders、integration-pg-reminder-boundaries | 不发送消息，不改变旧受限实验 |
| leaflet-photos | 私照上传、读取、删除、封面 | leaflet-photo-routes、private-photo-store、integration-pg-photos | 此负载不上传/读取私照；既有合成照片测试另跑 |
| medication-plans | 私人照护、计划、历史与安排 | integration-pg-plans、integration-pg-plan-create-retries、integration-pg-plans-lifecycle、plan-update-medicine | 私人计划创建、持久回执重试、列表及详情读取；不status/confirm/rebind/撤权 |
| backups | JSON备份、预览、管理员导入 | backups、integration-pg；独立hosted backup-docker | JSON导出及有效预览；真实dump/照片成对恢复另验 |

## 有界负载设计

- 仅显式 `TEST_DATABASE_URL`；没有时本地SKIP，`REQUIRE_POSTGRES_TESTS=1`缺资源则FAIL，不回退到DATABASE_URL或Owner配置。
- 复用 `isolatedPostgres`，随机独占schema及生产Database事务适配器；只清理由本次成功创建的schema。普通CI已有专用合成PG服务。不得把真实Owner库地址注入该测试。
- 8个合成身份分别固定其家庭/会话；并发层级1、4、8，各2轮，共26个正常业务循环。并发表示同时进行的业务worker数，不是所有worker同时进入某个特定路由的请求数。
- 每次请求15秒边界，PG语句/锁10秒，整项180秒上限；每轮等待所有worker结算后清理。仅使用Fastify inject，不监听网络端口。
- 请求超时只结束等待，不取消底层inject；finally另行等待所有真实请求结算后再关闭app和独占schema。180秒为测试预算，不是强制终止或生产容量保证。
- 验证实际PG持久化：批次数量修改不清期限/批号/位置，旧版本拒绝；计划相同请求键重试无重复；跨家庭读取和共享快照拒绝；回收站恢复保留内容；最终药品ID集合与计划数量一致。
- 输出每层请求数、总耗时、p95/max耗时。没有SLO或吞吐准入阈值，不将此测试解释成真实生产容量、TLS性能、真实OCR/GPU吞吐或手机响应速度。
- 不调用旧额外status/confirm撤权实验，不迁入该driver，不更改已有case、断言或安全guard。鉴权失败路径在固定成员关系下验证。

## 当前实际结果与剩余门槛

新增文件语法检查通过；无PG环境运行结果为1 SKIP、0 PASS。设置REQUIRE_POSTGRES_TESTS=1但不提供PG时，实际退出1、1 FAIL/0 SKIP，原因明确TEST_DATABASE_URL必需；这是预期资源门禁失败，不是产品回归失败。这只验证缺资源诚实跳过及严格模式不漏跑，不能说压力通过。独占PG真实运行等待当前候选普通hosted CI。

每模块现有用例、新增负载、外部资源、真机结果必须分层。拍照/扫码实际失败仍需端到端定位：原生权限/媒体读取、API版本及HTTPS、真实条码提供者配置、识别桥与模型调用、等待/错误提示、可编辑草稿、确认保存及照片归属。现有两家庭及数据不清理；原部署准备拒绝、旧额外实验BLOCKED仍有效。

提交使用中文主题并绑定产品版本、源码SHA、API镜像、生成小程序包及手机实际版本；测试文件不替代发布回执。本子任务不提交。
