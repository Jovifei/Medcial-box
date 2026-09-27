# 2026-09-27 Flutter 交互原型（本轮）

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
