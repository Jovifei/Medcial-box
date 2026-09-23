# 项目阶段任务台账

状态标签：`PASS` 仅表示记录了对应验收证据；`BLOCKED` 表示存在明确外部阻塞；`NOT_RUN` 表示尚无验证证据。

## P0：项目规划与可运行骨架 — PARTIAL / BLOCKED_RUNTIME

- [x] 固化产品需求、接口边界和架构决策。
- [x] 记录开源参考项目、许可证和可借鉴范围。
- [x] 建立跨阶段任务台账、状态记录与复核区。
- [x] 创建原生微信小程序 TypeScript 首页骨架和开发者工具配置示例。
- [x] 创建 Fastify TypeScript API、存活及数据库就绪检查。
- [x] 配置 PostgreSQL 迁移入口、Docker Compose、健康检查和环境变量示例。
- [x] 提供 lint、typecheck、test、build 脚本和合成样例。
- [ ] **BLOCKED** 本机启动 API 与 PostgreSQL，验证数据库真实就绪（Docker Desktop Linux 引擎未运行；本机无 PostgreSQL）。
- [x] 静态复查确认项目源码、合成样例与模板配置无真实密钥、实际个人健康信息或复制的第三方源代码。
- [ ] **BLOCKED** 使用微信开发者工具预览小程序（工具未安装／未检出，账号仍待批）。

### P0 复核

- 状态：PARTIAL / BLOCKED_RUNTIME
- PASS 证据：`npm run lint`、`npm run typecheck`、`npm test`（4/4）、`npm run build`、Docker Compose 配置解析；API 健康路由还通过了回环端口 HTTP 测试。
- BLOCKED 证据：`docker info` 报 Docker Desktop Linux engine named pipe 不存在；Windows 未发现 PostgreSQL 服务／`psql`；未发现微信开发者工具 CLI 或常见安装位置。
- NOT_RUN：容器内 PostgreSQL 查询、微信 IDE 编译预览、真实微信登录、视觉识别、药品数据查询、生产部署。
- 已知限制：目标目录没有 Git 仓库；真实微信 AppID、模型密钥和药品数据 API 密钥均未配置。
- 下一步：在 Docker Desktop Linux 引擎可用后运行本地 Compose，再用真实小程序账号在开发者工具里编译预览；之后开始 P1。

## P1：共享药箱 — NOT_STARTED

- [ ] 实现微信登录和后端自定义登录态，密钥仅存服务端。
- [ ] 实现家庭创建、邀请加入和家庭成员管理。
- [ ] 实现药品资料、库存批次和并发版本校验。
- [ ] 实现手工编辑、搜索、用途分类、数量未知／零和日期精度规则。
- [ ] 实现说明书用法与家人实际剂量分离记录。
- [ ] 自动验证跨家庭拒绝访问、无效邀请、重复提交和并发冲突。
- [ ] 两个真实微信用户验收邀请、共享和修改冲突。依赖已审核 AppID 与 HTTPS 域名，允许在 P4 部署后完成；无实测证据前，P1 不标完整验收。

## P2：拍照与药品资料补齐 — NOT_STARTED

- [ ] 实现照片私有上传、识别任务、结构化候选和用户确认草稿。
- [ ] 通过适配器接入视觉模型与药品查询 API。
- [ ] 实现批准文号／厂家／规格匹配、来源显示、手工补充及失败重试。
- [ ] 测试模糊照片、无匹配、冲突和模型缺字段场景。
- [ ] 用实际药盒单独记录真实服务的准确、缺失、错误与人工修正证据。

## P3：Markdown 导出 — NOT_STARTED

- [ ] 实现药箱 Markdown 生成与预览。
- [ ] 实现可选的个人剂量导出、文件分享和复制。
- [ ] 验证 UTF-8、字段完整、过期／未知库存标记和特殊字符转义。
- [ ] 在微信真机验证 `.md` 文件分享与复制文本；接口使用本地／临时文件路径，开发者工具预览不算实测。

## P4：部署与家庭试用 — NOT_STARTED

- [ ] 只读核实目标 Linux 服务器、现有 HTTPS 入口、资源和备份位置。
- [ ] 部署独立容器并配置域名白名单、HTTPS 和服务端密钥。
- [ ] 验证数据库和照片备份恢复。
- [ ] 至少两台手机完成家庭录入、修改、查看和导出验收。
- [ ] 记录试用问题与修复证据；发布状态独立评定。

## 变更复核记录

- 初始基线：空工作区；无既有源文件；尚无 Git 元数据。
- 2026-09-24（Git 初始化）：`git init -b main`，首个提交 `5c3adf2`（45 个文件，P0 全部文档与代码），推送远端 `Jovifei/Medcial-box` 并经 `ls-remote` 验证；`.workbuddy/` 已在 ignore 内，未入库。
- 2026-09-24（审核修复轮）：按独立审核意见修复 6 处问题——①README/operations/status 的 Compose 命令统一改为独立版 `docker-compose`；②`.gitignore` 与根 `.dockerignore` 补 `.workbuddy/`；③requirements.md 验收指标去重；④迁移排序改为数字前缀（`orderMigrations`）并新增 3 项单元测试；⑤本地 API 默认绑定 `127.0.0.1`（Compose 内 `API_HOST=0.0.0.0`）；⑥`/ready` 失败增加服务端日志。另：移除无效的 `deploy/.dockerignore`；小程序示例数据改显式类型注解；lessons.md 补记 Biome 与 compose 插件两条经验。`lint`／`typecheck`／`test`（7 tests）／`build` 复跑通过，compose 配置解析通过。
