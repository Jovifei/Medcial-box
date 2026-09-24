# 项目阶段任务台账

状态标签：`PASS` 仅表示记录了对应验收证据；`BLOCKED` 表示存在明确外部阻塞；`NOT_RUN` 表示尚无验证证据。

阶段顺序（Jovi 已确认的交付顺序）：**P0 收口 → P1 手动药箱＋Markdown 导出 → P2 家庭共享 → P3 拍照识别 → P4 上线试用**。阶段定义与 `tasks/plans/2026-09-24-mvp-roadmap.md` 一一对应。

## P0：收口（文档纠正＋无密钥 CI） — PARTIAL / BLOCKED_RUNTIME

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

### P1 其余条目（待办）

- [ ] 实现说明书摘要与实际个人剂量分离的录入和详情页面。
- [ ] 实现 Markdown 预览、UTF-8 `.md` 本地文件、复制文本与可选的个人剂量导出。
- [ ] 自动验证导出内容与 Markdown 转义；真实环境项单独记 `PASS_CODE_ONLY` 或 NOT_RUN。

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

### P2 其余条目（待真实环境验收）

- [ ] 实现 owner 邀请（一次性文本邀请码、仅存哈希、72h 失效）、成员加入、移除后失效和一个用户只属于一个家庭（`003_family_invites.sql` + 邀请端点，随 B3）。
- [ ] 家庭库存对成员共享，个人剂量备注默认私有、主动选择后共享（后端 B1 已实现可见性语义与逐请求鉴权）；所有 API 逐次鉴权。
- [ ] 验证邀请过期／复用、跨家庭拒绝、成员撤销和并发版本冲突（B1 已覆盖版本冲突部分）。
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
