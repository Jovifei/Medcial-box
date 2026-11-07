# 1.0.6 家庭试用工程准入：独立复审、许可与实际实施（2026-10-24）

> 本阶段承接同一 Draft PR #6，执行的是 GitHub 源码候选和合成测试，不触碰现役 API `10f284b`、真实家庭数据或签名密钥。本文件记录设计与实现，不代替最终固定 SHA 的 CI / 官方平台回执。

## 0. 起点和用户授权

- 真实失败基线 `70adf838f53cc0fc756c506920b68e9d1524f3fc`：PG 并行退出与 Flutter 合法无活动家庭红，候选交付跳过。
- 先单独提交红测 `eb5c07fdf4a7cb20ef3356fddcd5b1e085baa484`（保存重试/备份本次 401/切家导航失败），其后修复业务实现；保留现有测试条件、PG 真并发、登录竞态和隔离保护。
- 原本地 `E:\project\medcial_box` 为 `main@bd769f0` 且有未提交补丁和备份，不改不覆盖。云端通过 GitHub 原分支非强推追加提交。

## 1. 已实施的 P1–P3 修复

1. **药品编辑 + photo_pending**：API PUT 返回与提交索引一一对应的 `batchSaveReceipts`，含持久 ID、版本；小程序在上传照片前安全落盘，照片关联随 ID 重新绑定。旧 API 无回执时只推断唯一新增批次，多个新批次回落服务端权威快照并拒绝猜测照片归属。服务端写入不会因后续照片失败再次被当作新增批次。
2. **Android 家庭未选**：`hasFamily=true,family=null` 合法进入家庭选择；同一经验证用户保留输入草稿，清空上一家庭投影、提醒与缓存；跨用户/未知身份不允许据此保留私有草稿；身份代次和晚到响应测试保留。
3. **小程序备份**：创建/预览/恢复请求自身 401 立即识别失效回执，清空旧家庭预览/文件 JSON/确认载荷，busy 立刻释放；旧账号异步回执不能清理新账号。
4. **SESSION_SCOPE_CHANGED**：首页、详情、待办、补货、盘点在 `reLaunch` 前同步清除已显示的上一个家庭数据，导航失败也无旧数据留屏。
5. **PG 并行退出**：在退出事务读取回退家庭前先对同一用户全部会话行加 `FOR UPDATE` 串行锁；任何回退会话必须指向提交时有效成员关系。

## 2. 自主选择并已实际实施的下一完整阶段：家庭试用离线准入回执

目标：把“全部 CI 通过的源码候选”和“可以微信/真机/生产发布”严格分离，避免使用旧 SHA/旧截图/未签名包错误验收。新增：

- `scripts/candidate-readiness.mjs`：读取已有候选 manifest 和 CI receipt；强制同一 40 位 SHA、完整哈希、版本 1.0.6、公共 AppID/HTTPS 来源、原样 3 项 CI 前置成功和 `UNSIGNED_CI_RECEIPT_NOT_A_SIGNATURE`；拒绝把微信编译/双家庭真机/Android 安装/现役 API 部署/正式发布冒充 PASS。
- `scripts/candidate-readiness.test.mjs`：有效输出、异 SHA、失败 job、错误域名/版本、伪造签名/部署门禁、不可覆盖既有回执及符号链接输入拒绝等回归。
- 在 `.github/workflows/ci.yml` 的 `candidate-delivery` 成功路径生成 `release-readiness.json`，随候选源码和 CI receipt 交付；任何验证失败会使该 job 红，不走部署分支。

回执在本地仅能确认内容与结构，**不能脱离 GitHub 独立验证 CI 是否真实成功**；因此报告固定为 `ENGINEERING_CANDIDATE_ONLY`、`releaseAllowed=false`。它不是数字签名、发布许可证或人工微信验收。

## 3. 开源实现与许可证调查

- Grocy（https://github.com/grocy/grocy）：MIT；借鉴“库存/批次/过期/清单”理念，不拷贝源代码、图标或素材。
- Homebox（https://github.com/hay-kot/homebox）：AGPL-3.0；只研究“面向家庭的资产组织和角色使用流程”，不引入其代码或 AGPL 文件以避免混合许可义务。
- 本阶段新增源码和测试自主编写，未加入第三方依赖，不新增微信原生权限、远程 API 路由或数据库迁移。第三方既有依赖许可全面扫描不在本次断言范围内；正式发行前仍须检查完整依赖清单及通知文件。

## 4. 分层验收状态（必须由同 SHA CI 和真实回执更新）

| 层级 | 门禁 | 本文状态 |
| --- | --- | --- |
| API + Node + 真 PG + 小程序 QA + Flutter | 同 SHA verify / backup-docker / flutter | 以 GitHub 最新 CI 实际结论为准 |
| 离线候选 + 工程准入回执 | candidate-delivery 生成源码 manifest、ci-receipt、release-readiness.json | 以同 SHA job+产物为准 |
| 微信开发者工具官方编译/上传、两个真实家庭真机 | 手机/平台人工证据 | NOT_RUN |
| Android 有发行签名的安装/真实设备测试 | 签名与人工验收 | NOT_RUN |
| 现役 API 发布和现存家庭数据迁移 | 本轮未授权 | NOT_PERFORMED（仍钉 `10f284b`） |
| main 合并及微信正式发布 | 单独明确授权 | NOT_AUTHORIZED |

## 5. 候选接收原则

先从 PR #6 固定最终提交 40 位 SHA，再在**全新**验收 worktree 中执行 `npm ci`、`npm run lint`、`npm run typecheck`、`npm test`、`npm run build` 和完整 Flutter 构建。用 CI 相同配置构建 `candidate-bundle` 并执行 `verify`，核对 `manifest.json` 中 sourceSha、sourceTree、miniTree、packageSha256；再对照 GitHub 同 SHA 的 4 个 job 和 artifact digest。原脏树不清理、不强推、不合 main；微信/Android/真实家庭数据需另行授权和证据。
