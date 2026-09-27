# 项目阶段任务台账

## 2026-09-27 Flutter 交互原型（执行中）

- [x] 创建 `codex/flutter-ui-prototype` 分支和独立工作树
- [x] 安装 Flutter 3.47.5 stable，配置 Android SDK 访问路径
- [x] 完成 Material 3 主题、路由转场、底部面板、弹窗和共享元素动画
- [x] 完成欢迎页、家庭选择、药箱首页、药品详情和导出预览
- [x] 接入本地合成仓库和可替换 `AuthRepository`／`MedicineRepository` 接口
- [x] 接入 `image_picker` 相机／相册权限和中文 ML Kit 识别草稿
- [x] 完成手动药品录入、识别失败补填、人工核对后保存
- [x] `flutter analyze`、Widget／解析器测试 7/7、Debug APK 构建通过
- [x] APK 安装到 `GM1910`，验证相机权限、系统相机、拍照返回、识别草稿和手动保存
- [ ] 记录用户视觉反馈并进行第二轮调整

### 微信小程序同步

- [x] 首页录入入口改为拍照／相册／手动三选一底部面板
- [x] 录入页按来源调用微信相机或相册，识别结果仍人工核对后保存
- [x] 生成最新本地小程序导入包：`.local-data\mini-local-6bcee87d-c197-4852-b0ee-51fcb96da762`
- [ ] 在微信开发者工具和真机验证相机授权、图片识别和保存流程

### Flutter 验收证据

- Widget／解析器测试：7/7 PASS
- APK：`apps/flutter/build/app/outputs/flutter-apk/app-debug.apk`
- 已验证截图：`E:\Claude_allow\Download\medcial_box\flutter-ui-prototype-welcome.png`、`flutter-ui-prototype-choice2.png`、`flutter-ui-prototype-after-create.png`、`flutter-ui-prototype-manual.png`
- 识别证据截图：`flutter-ui-prototype-camera-permission.png`、`flutter-ui-prototype-recognition-final.png`
- 边界：库存仍使用合成数据；未接微信登录、真实 API 和远端服务；ML Kit 识别结果必须人工核对。

## 2026-09-27 下一阶段：登录与家庭试用闭环（执行中）

- [x] 登录欢迎页：明确微信登录、会话恢复、过期重试、退出登录（代码完成；真机仍待验收）
- [x] 首次进入：创建家庭／加入家庭选择，分享邀请码跨登录保留（代码完成；真机仍待验收）
- [x] 家庭管理：家庭入口、邀请预览、成员显示名、管理员文案与错误状态（代码与 API 测试完成）
- [ ] 录入闭环：拍照草稿核对保存、失败恢复、同名药批次提示、导出真流程
- [x] API：`auth/me`、`auth/logout`、`users/me`、邀请预览及契约／迁移／测试
- [x] 工程验证：lint、typecheck、test、build、PostgreSQL 集成测试（本地真实 PG 14/14；常规 `npm test` 保留 1 项跳过）
- [x] 文档收口：状态、识别路线、开发者工具导入目录及本轮证据

### 本轮验收记录

- 状态：IN_PROGRESS
- 代码路径：`C:\Users\Admin\.codex\worktrees\phone-trial-readiness\medcial_box`
- 约束：不修改 `E:\project\medcial_box` 主目录；不写入或输出真实密钥；真实双账号／真机／远端部署待独立环境验证。
- 本地 Docker：`medbox-local-trial` API/DB healthy，`/live` 与 `/ready` HTTP 200。
- 小程序导入包：`.local-data\mini-local-9a27b898-eac3-46ec-bc13-9a7ffe25d0d4`（AppID 与回环 API 已生成，包内无服务端密钥）。

### 本轮审核与遗留验收

- [x] 后端接口响应与小程序契约只读联调审核；已修复代理限流键、失效会话邀请码丢失、异常编码、注销失败页面状态和重复加入按钮。
- [ ] **NOT_RUN** 微信开发者工具编译及页面点击验证（需要工具 GUI／服务端口可用）。
- [ ] **NOT_RUN** 两个真实微信账号、两台手机的创建／邀请／共享／移除／导出验收。
- [ ] **NOT_RUN** ECS HTTPS 部署、备份恢复和真实域名验证。

## 2026-09-27 录入体验纠正 — IN_PROGRESS

Jovi 在本地试用指出录入字段过多。改为拍照识别优先、常用项点选、仅名称最少手填，选填资料收起。本地优先使用已安装的 Ollama 图像模型，无额外模型 API Key；云端适配器保留为可选。详见 `tasks/plans/2026-09-27-photo-first-entry.md`；真实药盒验收单独记证据。

- [x] 快速录入与分层表单代码完成：只填药名可保存未知数量／日期；非法小数、尾缀和不存在日期有专项测试，开发者工具交互待确认。
- [x] 图片识别只返回草稿并要求核对后保存；本地 Ollama 与云端百炼可切换，服务不可用时仍可录入。合成后端与本地模型测试 PASS，开发者工具交互待验。
- [x] 用开发者工具选择合成药盒图片并取得识别草稿：最新请求 HTTP 200、约 4.9 秒；数据库 medicines/batches 仍为 0，确认草稿未自动入库。仍待页面核对后保存与 Markdown 验证。
- [ ] **BLOCKED_LOCAL_UI** 微信开发者工具 CLI 报 `IDE service port disabled`；需要在工具“设置 → 安全设置”手动开启服务端口后，才能由 CLI 继续打开/编译项目。当前后端与模型测试不受影响。
- [x] 修复识别无结果体验：设备日志确认请求返回 503；页面增加持久状态面板，API 增加 JPEG/PNG 完整性检查，避免损坏图片触发 Ollama 崩溃。待开发者工具重新编译复测。
- [ ] 真实家庭照片前收紧本机 Ollama `11434` 入站访问；当前仅使用合成图片。
- [ ] 本地服务、开发者工具验证通过后再进入 ECS 测试部署。

## 2026-09-27 本地 Docker 与微信登录 — IN_PROGRESS

执行顺序及验收边界见 `tasks/plans/2026-09-27-local-docker-login.md`。Jovi 已确认先本地，真实登录通过后再远端部署。

- [x] 使用独立 Compose 项目与回环端口运行本机 API、PostgreSQL：两个容器健康，迁移 5 条，`/live` 与 `/ready` PASS。
- [x] 本地 AppSecret 已配置且容器已重建；开发者工具真实 `wx.login` → 后端 code 交换返回 200，用户与会话各 1。真机登录 `NOT_RUN`。
- [ ] 在开发者工具用合成数据完成家庭创建、药品批次录入与 Markdown 导出。
- [ ] 记录本地、微信与远端独立证据；远端部署暂不执行。

本轮局部证据见 `tasks/reports/2026-09-27-local-docker-login.md`。微信开发者工具已安装并打开，真实扫码／登录仍待操作。

## 2026-09-27 手机试用准备 — LOCAL_PASS / REAL_DEVICE_NOT_RUN

- [x] 关闭导出选项竞态，新增实际页面逻辑回归验证（21/21 PASS；微信真机 NOT_RUN）。
- [x] 统一药品／批次加锁顺序，验证真实数据库并发（PostgreSQL 17 集成测试 PASS）。
- [x] 重建隔离集成测试与 PostgreSQL CI 必跑检查（本地 14/14 PASS；远端 CI NOT_RUN）。
- [x] 准备 HTTPS 测试部署、私有凭据注入、小程序配置和备份恢复（配置及本地原生 PG dump/restore PASS；容器脚本实跑 NOT_RUN）。
- [ ] **BLOCKED_INPUT** 取得 SSH 登录入口；在 Cloudflare 权威 DNS 完成测试 A 记录并核对备案／TLS 后，部署 HTTPS 测试环境并做双账号真机验收。ECS IP、AppID 和候选域名已存于本机配置。
- [x] 完成本地检查和独立复核，登记证据与未完成项。

### 本轮复核与证据

- `npm run lint`、`npm run typecheck`、`npm run build` PASS；真实 PostgreSQL 环境下 `npm test`：API 124/124、工具 3/3，0 跳过。
- 原生 PostgreSQL 17.11 隔离数据库：迁移、API CRUD、权限、并发、备份与恢复后读取 PASS。数据库测试使用随机 schema，没有清空共享业务表。
- 测试环境 Compose 静态配置 PASS；本机 Docker Desktop 引擎启动失败，实际容器部署与脚本演练 NOT_RUN。
- 微信开发者工具、真实 AppID 登录、`.md` 真机分享、两账号家庭试用、远端 CI 均 NOT_RUN。详细命令、结果和边界见 `tasks/reports/2026-09-27-phone-trial-readiness.md`。

详见 `tasks/plans/2026-09-26-phone-trial-readiness.md`。本轮以该工作包作为当前进度入口，以下保留历史阶段记录。

状态标签：`PASS` 仅表示记录了对应验收证据；`BLOCKED` 表示存在明确外部阻塞；`NOT_RUN` 表示尚无验证证据。下方 P0–P4 是阶段历史台账；其中 P0/P1/P2 的旧测试数与运行状态以本页顶部最新复核为准。

阶段顺序（Jovi 已确认的交付顺序）：**P0 收口 → P1 手动药箱＋Markdown 导出 → P2 家庭共享 → P3 拍照识别 → P4 上线试用**。阶段定义与 `tasks/plans/2026-09-24-mvp-roadmap.md` 一一对应。

## P0：收口（文档纠正＋无密钥 CI） — PARTIAL / BLOCKED_RUNTIME

> 全仓当前测试证据：**88 项 = 87 通过 + 1 跳过**（跳过项为真实 PostgreSQL 集成测试，设 `TEST_DATABASE_URL` 自动执行；详见各阶段复核与变更记录）。

- [x] 固化产品需求、接口边界和架构决策。
- [x] 记录开源参考项目、许可证和可借鉴范围。
- [x] 建立跨阶段任务台账、状态记录与复核区。
- [x] 创建原生微信小程序 TypeScript 首页骨架和开发者工具配置示例。
- [x] 创建 Fastify TypeScript API、存活及数据库就绪检查。
- [x] 配置 PostgreSQL 迁移入口、Docker Compose、健康检查和环境变量示例。
- [x] 提供 lint、typecheck、test、build 脚本和合成样例（P0 基线 7/7 测试通过：4 项健康路由 + 3 项迁移排序）。
- [x] 静态复查确认项目源码、合成样例与模板配置无真实密钥、实际个人健康信息或复制的第三方源代码。
- [x] 新增无密钥 CI（`.github/workflows/ci.yml`：Node 22，`npm ci` → lint → typecheck → test → build），不引用任何 Secrets。
- [x] 台账与 Git 现状、测试数量、新阶段顺序对齐（本轮重写本文件与 `tasks/status.md`）。
- [ ] **BLOCKED_RUNTIME** 本机启动 API 与 PostgreSQL，验证数据库真实就绪（Docker Desktop Linux 引擎未运行；本机无 PostgreSQL；本机仅有独立版 `docker-compose`，无 compose 插件）。
- [ ] **BLOCKED_RUNTIME** 使用微信开发者工具预览小程序（工具未安装／未检出；`touristappid` 可用于本地预览，正式登录仍需实际 AppID）。

### P0 复核

- 状态：PARTIAL / BLOCKED_RUNTIME
- PASS 证据：`npm run lint` PASS；`npm run typecheck` PASS；`npm test` PASS（P0 基线 7/7；B1 轮后全仓 57/57，见 P1 复核）；`npm run build` PASS；`docker-compose --env-file deploy/.env.example -f deploy/docker-compose.yml config --quiet` PASS；API 健康路由通过合成数据库依赖下的回环端口 HTTP 测试；CI 工作流为纯静态检查无任何密钥引用。
- BLOCKED 证据：`docker info` 报 Docker Desktop Linux engine named pipe 不存在；Windows 未发现 PostgreSQL 服务／`psql`；未发现微信开发者工具 CLI 或常见安装位置。
- NOT_RUN：容器内 PostgreSQL 查询、微信 IDE 编译预览、真实微信登录、视觉识别、药品数据查询、生产部署。
- 已知限制：项目已初始化 Git；真实微信 AppID、模型密钥和药品数据 API 密钥均未配置。
- 下一步：Docker 引擎、开发者工具可用后补齐 P0 运行证据（`docker-compose --env-file .env -f deploy/docker-compose.yml up --build`）；期间继续推进 P1。

## P1：手动药箱＋Markdown 导出 — IN_PROGRESS / PASS_CODE_ONLY

### B1：后端核心（本轮完成，代码与合成测试证据）

- [x] 新增迁移 `apps/api/db/migrations/002_core_inventory.sql`：users、families、family_members（user_id 唯一 = 一账号一家庭）、sessions（仅存令牌 sha256 哈希 + 过期时间）、medicines、medicine_batches（冗余 family_id）、dosage_notes；全部含 family_id 绑定、创建/修改人与整数 version。
- [x] `POST /api/v1/auth/wechat`：`WechatGateway` 可注入（`HttpWechatGateway` 走环境变量 AppID/AppSecret，缺省启动可运行；测试注入 `FakeWechatGateway`）；`crypto.randomBytes` 随机令牌，仅存 sha256 哈希；无公开测试登录后门。
- [x] 认证 preHandler：解析 `Authorization: Bearer`，校验会话有效性与家庭成员关系并注入 `request.auth`；401（UNAUTHORIZED/SESSION_EXPIRED）、404 FAMILY_NOT_FOUND（无家庭）、404 NOT_FOUND（含跨家庭，不泄露存在性）语义实现。
- [x] `POST /api/v1/families`（事务内建家庭 + owner 成员；已在家庭 409 ALREADY_IN_FAMILY）、`GET /api/v1/families/current`。
- [x] 药品/批次/个人剂量备注 CRUD：列表、详情、新建、编辑（预期 version，不符 409 VERSION_CONFLICT）、归档/删除；quantity null=未知、0=耗尽；盒→片换算数仅接受正整数（经确认才填写）；有效期 value+precision 成对校验（YYYY-MM-DD / YYYY-MM / 未知）。
- [x] 有效期纯函数模块 `apps/api/src/domain/expiry.ts`：月末/跨年边界、年月精度（过月才 expired、当月 due_this_month）、day 精度默认提前 30 天临期（第 30/31 天边界）。
- [x] contracts 扩展 `packages/contracts/src/index.ts`：API 请求/响应类型、领域类型（ExpiryState/ExpiryStateInfo/ApiErrorCode 等），向后兼容追加。
- [x] 合成测试（node:test + Fastify inject + 假网关/假池，不依赖真实数据库）50 项，覆盖：无家庭会话 404、跨家庭 404、409 冲突与重试成功、有效期算法（月末/跨年/年月/30 天边界）、同药多批次、数量未知与零、假网关登录成功/失败/502、令牌只存哈希、备注可见性。

### B1 复核

- 状态：PASS_CODE_ONLY（真实环境验收未做）
- PASS 证据（2026-09-24 B1 轮）：`npm run lint` PASS；`npm run typecheck` PASS；`npm test` PASS（全仓 57/57 = P0 基线 7 + B1 新增 50）；`npm run build` PASS。全部测试为合成注入（假数据库池 + 假微信网关），未使用真实 PostgreSQL 或真实微信凭据。
- NOT_RUN / 待 P1 后续批次：真实 PostgreSQL 迁移与读写验证（BLOCKED_RUNTIME）；`POST /api/v1/exports/markdown` 与 Markdown 转义（B2）；小程序首页/录入/详情/导出预览页面（B2）；真实微信登录与 `.md` 真机分享（需 AppID/HTTPS，NOT_RUN）。

### B2：导出 + 小程序（本轮完成，代码与合成测试证据）

- [x] Markdown 渲染器 `apps/api/src/services/markdown-export.ts`（纯函数）：分区在用库存／已过期／已耗尽／日期待补充（D4：归档仅显式请求时以"（已归档）"分区输出）；数量未知/零显式标注；有效期保留原文精度（仅到月不伪造日期）；存放位置默认包含、可关闭（D1）；仅 user_confirmed/matched 说明书摘要作为已核对资料输出，unverified 仅标注"未核验"；`includePersonalDosage` 默认 false，开启后仅含当前用户有权查看的备注并标注归属；免责声明一行；全部用户输入 Markdown 转义（`|` `*` `#` 反引号 `>` `]` `[` 与换行）。
- [x] `POST /api/v1/exports/markdown`：复用 B1 会话/家庭校验与仓储，返回 `{ markdown, generatedAt }`；401/404 语义与 B1 一致。
- [x] 导出合成测试 7 项：字段完整性、四分区正确性、转义（含 `|`/`*`/`#`/换行的药名）、includePersonalDosage 开/关（他人备注不进导出，SQL 谓词断言）、归档排除与显式包含、存放位置开关、无家庭/无令牌 404/401。
- [x] 小程序：`services/api.ts`（Bearer 注入、统一错误 shape 解析、401 清令牌）、`services/auth.ts`（wx.login → code 换会话）、`pages/index` 改造（真实数据+状态徽标+临期/过期计数+本机搜索筛选+服务不可用时合成示例兜底并标注"合成"）、新增 `family-create`、`medicine-edit`（资料+批次表单：数量未知开关、单位/精度选择、409 冲突提示）、`medicine-detail`（批次/说明书核验状态/个人剂量备注增删）、`batch-edit`、`export-preview`（选项开关→预览→复制文本→写本地 .md→`wx.shareFileMessage`，失败回退复制）；`app.json` 注册全部页面；`app.wxss` 共享样式；界面文案简体中文。
- [x] 小程序 lint（`--max-warnings=0`，含 services）与 `tsc --noEmit`（typecheck/build）通过。

### B2 复核

- 状态：PASS_CODE_ONLY（真实环境验收未做）
- PASS 证据（2026-09-24 B2 轮）：`npm run lint` PASS；`npm run typecheck` PASS；`npm test` PASS（全仓 64/64 = B1 后 57 + B2 新增 7）；`npm run build` PASS（含小程序 tsc --noEmit）。
- NOT_RUN：微信开发者工具编译与页面预览（工具未检出，页面代码以 typecheck 通过为准，不标设备 PASS）；真实导出 `.md` 真机分享；`POST /api/v1/exports/markdown` 真实 PostgreSQL 数据验证。

### P1 其余条目（待真实环境验收，代码已完成）

- [x] 说明书摘要与实际个人剂量分离的录入和详情页面（B1/B2 完成）。
- [x] Markdown 预览、UTF-8 `.md` 本地文件、复制文本与可选的个人剂量导出（B2 完成）。
- [x] 导出内容与 Markdown 转义自动验证（B2 完成 7 项；QA 回归修复 2 处恒真断言后强化）。
- [ ] **BLOCKED_RUNTIME** 真实 PostgreSQL 迁移与读写验证（迁移 001–004 已就绪；设 `TEST_DATABASE_URL` 后 `apps/api/test/integration-pg.test.mjs` 自动执行）。
- [ ] **NOT_RUN** 真实微信登录与 `.md` 真机分享（需 AppID/HTTPS）。

## P2：家庭共享 — PASS_CODE_ONLY / BLOCKED_RUNTIME（代码与合成测试完成）

### B3：家庭共享（本轮完成，代码与合成测试证据）

- [x] 新增迁移 `apps/api/db/migrations/003_family_invites.sql`：family_invites 表（明文邀请码只出现一次、库存 sha256 哈希、72h 失效、used_at/used_by 一次性消费、created_by 限 owner）。剂量备注"全家可见"自 002 起由 `dosage_notes.visibility` 承载，003 无需 ALTER（从设计文档安排）。
- [x] `POST /api/v1/families/invitations`：仅 owner（403 OWNER_ONLY）；返回明文凭据一次，服务端只留哈希与过期时间。
- [x] `POST /api/v1/families/invitations/accept`：明文哈希比对；无效 404、过期 410 INVITATION_EXPIRED、已用 410 INVITATION_USED（原子 UPDATE rowCount 判定防复用，接受事务内建成员关系+消费邀请，失败回滚）；已有家庭 409 ALREADY_IN_FAMILY，不自动搬移/合并药品。
- [x] `DELETE /api/v1/families/members/{id}`：仅 owner；不能移除自己（D3）与 owner；移除后成员关系消失，被移除者原令牌后续请求在认证 preHandler 查不到成员关系 → 404 FAMILY_NOT_FOUND（从设计文档 §5，会话不撤销）。
- [x] 剂量备注可见性（B1 已实现，本轮补测试）：创建/编辑 visibility 默认 private；未共享对他人不可见（编辑 404），共享只读；导出按查看者权限过滤。
- [x] 小程序 `pages/invite`：owner 生成/复制一次性邀请码；无家庭用户粘贴加入；已加入成员显示"邀请由 owner 管理、换家庭需先被移除"提示；首页增加"家庭共享"入口；`app.json` 注册。
- [x] 合成测试新增 13 项（全仓 77/77）：邀请仅 owner、只存哈希、~72h 过期、接受成功为 member、复用 410、过期 410、无效 404/空码 400、已有家庭 409 且不消费邀请、接受后可读库存、owner 移除后原令牌即时 404、成员列表更新、非 owner 403/自移除与 owner 移除 403/404、备注可见性与导出权限。

### B3 复核

- 状态：PASS_CODE_ONLY（真实环境验收未做）
- PASS 证据（2026-09-24 B3 轮）：`npm run lint` PASS；`npm run typecheck` PASS；`npm test` PASS（全仓 77/77 = B2 后 64 + B3 新增 13）；`npm run build` PASS（含小程序 tsc --noEmit）。
- NOT_RUN：真实两账号邀请/共享/移除验证（需合法 HTTPS 测试环境，无实测不标完整 PASS）；微信开发者工具编译预览。

### P2 其余条目（代码已完成，仅待真实环境验收）

- [x] owner 邀请（一次性凭据、仅存哈希、72h 失效）、成员加入、移除后失效、一账号一家庭（B3 完成）。
- [x] 家庭成员管理 UI：成员身份展示（昵称/稳定标签 + "我"标注）、owner 移除按钮、转让所有权入口（审核修复轮 #6 完成）。
- [x] 邀请过期／复用、跨家庭拒绝、成员撤销即时失效和并发版本冲突的自动验证（B1/B3 + 审核修复轮完成）。
- [ ] **NOT_RUN** HTTPS 测试环境就绪后由两个真实微信用户验收邀请和同步；没有该证据不标完整 PASS。

## P3：拍照识别与药品资料补齐 — NOT_STARTED

- [ ] 实现私有照片上传、识别草稿、用户确认后入库和草稿过期清理。
- [ ] 通过适配器接入百炼视觉模型与药品资料查询，按批准文号、厂家和规格核对。
- [ ] 无匹配、规格冲突或接口失败时保留手工录入及说明书补拍路径。
- [ ] 合成场景验证模糊照片、字段缺失、无匹配、服务失败；实际药盒与提供商另记真实证据。

## P4：部署与家庭试用 — NOT_STARTED

- [ ] 只读核实目标 Linux 服务器、现有 HTTPS 入口、资源和备份位置。
- [ ] 部署独立容器、照片私有持久卷，并配置域名白名单、HTTPS 和服务端密钥；生产环境不得使用开发默认口令。
- [ ] 验证数据库和照片备份恢复、成员退出与数据删除路径。
- [ ] 至少两台手机完成家庭录入、修改、查看和导出验收。
- [ ] 记录试用问题与修复证据；发布状态独立评定。

## 首版之后的候选功能 — BACKLOG

- [ ] 低库存阈值、临期／过期的微信订阅提醒和批量盘点。
- [ ] 条码辅助检索、服药计划／确认记录、可撤销的库存扣减。
- [ ] 评估应用内 AI 问药；未验证外部清单使用价值与医疗边界前不实施。

## 变更复核记录

- 初始基线：空工作区；无既有源文件；尚无 Git 元数据。
- 2026-09-24（Git 初始化）：`git init -b main`，首个提交 `5c3adf2`（45 个文件，P0 全部文档与代码），推送远端 `Jovifei/Medcial-box` 并经 `ls-remote` 验证；`.workbuddy/` 已在 ignore 内，未入库。
- 2026-09-24（审核修复轮）：按独立审核意见修复 6 处问题——①README/operations/status 的 Compose 命令统一改为独立版 `docker-compose`；②`.gitignore` 与根 `.dockerignore` 补 `.workbuddy/`；③requirements.md 验收指标去重；④迁移排序改为数字前缀（`orderMigrations`）并新增 3 项单元测试；⑤本地 API 默认绑定 `127.0.0.1`（Compose 内 `API_HOST=0.0.0.0`）；⑥`/ready` 失败增加服务端日志。另：移除无效的 `deploy/.dockerignore`；小程序示例数据改显式类型注解；lessons.md 补记 Biome 与 compose 插件两条经验。`lint`／`typecheck`／`test`（7 tests）／`build` 复跑通过，compose 配置解析通过。
- 2026-09-24（路线复核）：P0 仍只含骨架；Jovi 选择先交付手动录入和 Markdown 导出，后做家庭共享与拍照识别。阶段任务与 `tasks/plans/2026-09-24-mvp-roadmap.md` 对齐；真实数据库、微信工具及外部服务状态保持独立。
- 2026-09-24（P0 收口 + B1 后端核心）：按新阶段顺序重写本台账（P0 收口 → P1 → P2 → P3 → P4）。P0 新增无密钥 CI `.github/workflows/ci.yml`（Node 22：npm ci → lint → typecheck → test → build，零 Secrets）。B1 落地：`002_core_inventory.sql`（users/families/family_members/sessions 仅存哈希/medicines/medicine_batches/dosage_notes）；contracts 追加 API/领域类型；`WechatGateway` 可注入登录（随机令牌、仅存 sha256、无测试后门）；Bearer 认证 preHandler（会话 + 成员关系注入 `request.auth`）；家庭/药品/批次/备注 CRUD（PUT 预期 version 不符 409，跨家庭一律 404）；`domain/expiry.ts` 有效期纯函数；合成测试新增 50 项。全仓 `lint`／`typecheck`／`test`（57/57）／`build` 通过。真实 PostgreSQL 与微信工具验收保持 BLOCKED_RUNTIME，未以合成结果虚标。本轮未执行 git commit/push（由主理人统一处理）。
- 2026-09-24（B2 导出 + 小程序）：新增 `services/markdown-export.ts` 渲染器（四分区 + D1 存放位置 + D4 归档排除 + 说明书核验区分 + 个人剂量权限 + Markdown 转义）与 `POST /api/v1/exports/markdown`；新增导出合成测试 7 项（全仓 64/64）。小程序新增统一网络层 `services/api.ts`、登录 `services/auth.ts` 与五个页面（首页改造、创建家庭、药品录入/编辑、药品详情、批次编辑、导出预览），`app.json`/`app.ts`/`app.wxss`/typings 同步；miniprogram lint 脚本纳入 services。小程序仅通过 `tsc --noEmit` 验证（无开发者工具，不标编译/真机 PASS）。全仓四项门禁复跑通过；未执行 git commit/push。
- 2026-09-24（B3 P2 家庭共享）：新增 `003_family_invites.sql`（一次性邀请凭据：sha256 哈希、72h、used_at/used_by 原子消费）；contracts 追加 INVITATION_EXPIRED/INVITATION_USED 与邀请请求/响应类型；新增 `repositories/invites.ts`（含单条原子 UPDATE 防复用）与 `routes/invitations.ts`（owner 生成、明文接受 404/410/409 语义、owner 移除成员且自移除/owner 移除 403）；剂量备注"全家可见"沿用 002 的 visibility 列（未加 shared_with_family，从设计文档安排）；小程序新增 `pages/invite` 与首页入口。合成测试新增 13 项（全仓 77/77）。真实两账号共享验证保持 NOT_RUN（需 HTTPS 测试环境）。全仓四项门禁复跑通过；未执行 git commit/push。
- 2026-09-24（D2/D3 决策落地）：邀请升级为"转发卡片（onShareAppMessage 携带 code，家人点卡片自动填充）+ 文本码兜底"；新增 POST /api/v1/families/leave（成员自助退出，owner 需先转让）与 POST /api/v1/families/members/{id}/transfer-ownership（事务内角色互换）；邀请页补成员列表、转让与退出入口；测试 77→83（+6：退出即时失效、owner 退出限制 ×2、转让成功后原 owner 可退出、非 owner 转让 403、自转让/404）。lint/typecheck/build 全绿。
- 2026-09-24（审核修复轮二）：第二轮独立审核 6 项代码问题全部落地——①新增 `Database.withTransaction` 单连接事务接口，建家庭/接受邀请/转让/药品创建/药品编辑全部迁移，消除 pool.query 手工 BEGIN/COMMIT 的跨连接风险；②药品编辑在事务内按 id/version 同步批次增删改，修复"提示已保存但批次未生效"（+2 测试：同步成功、批次版本过期 409 整体回滚）；③药品创建与初始批次同事务（+1 事务顺序断言）；④迁移 `004_family_single_owner.sql` 单 owner 部分唯一索引 + 转让 FOR UPDATE 锁家庭行、事务内重验双方角色、先降级后升级；⑤有效期按 Asia/Shanghai 计算（`zonedDateParts`，+1 上海本地午夜边界测试）；⑥成员身份展示（昵称/稳定标签 + isSelf）与 owner 移除按钮；⑦新增 `integration-pg.test.mjs` 真实库集成测试（无 TEST_DATABASE_URL 自动跳过）。测试 83→88。文档漂移清理：本台账 P1/P2"其余条目"去重、roadmap 当前基线更新、operations 过期表述更正、lessons.md 补事务与时区两条。
- 2026-09-26（审核修复轮三，基线 cca45f0）：第二轮复审 6 项遗留问题全部落地——①Compose 移除 `/docker-entrypoint-initdb.d` 迁移挂载，迁移统一由 API 迁移器执行（修复全新环境启动失败）；②迁移 `005_add_created_at_columns.sql` 补齐三表 created_at（修复列表/详情/导出查询列不存在）；③批次端点增/改/删单连接事务 + 递增药品聚合版本（修复旧页面整体保存静默删除他人新增批次，+2 测试）；④导出预览页请求序号 + 选项快照 + 复制/分享前按当前选项重新生成（修复旧响应覆盖与旧内容复制/分享）；⑤退出/移除与转让共用家庭行锁、事务内复核角色、删除带角色条件（修复单 owner 被并发删除）；⑥集成测试改用 `createDatabaseAdapter`（生产同款事务适配器）并以"普通成员升级撞索引"证明单 owner 约束（消除 user_id 约束假阳性）。测试 88→90（89 通过 + 1 跳过）。
