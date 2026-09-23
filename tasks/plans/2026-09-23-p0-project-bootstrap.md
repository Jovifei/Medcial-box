# P0：家庭药箱项目初始化与骨架

## 目标

在 `E:\project\medcial_box` 完成文档、任务跟踪、微信 TypeScript 首页与 Fastify／PostgreSQL 开发骨架。只运行本地／合成验证；不连接线上网站、真实微信账号、实际药品记录、AI key 或药品数据服务。

## 环境依据

- 初始化前目标目录为空且没有 Git 仓库或已有项目文件。
- Windows／PowerShell；Node.js 24.18.0、npm 11.16.0、Docker CLI 29.7.2、Docker Compose 5.4.0 可执行。
- Docker CLI 指向 Docker Desktop Linux named pipe，但引擎没有运行；本机未检出 PostgreSQL 服务、`psql`、开发者工具 CLI 或工具常见安装位置。
- 本地依赖下载缓存边界为 `E:\Claude_allow\Download\medcial_box\npm-cache`。
- npm 首次 native Biome binary 下载约 76 MB，Windows 上无法可靠运行；首轮 lint 改用 TypeScript ESLint 与 JSON 语法检查，并从依赖和测试链路移除该工具。

## 实施增量

1. 先建立 `tasks/todo.md`、`tasks/status.md`、`tasks/lessons.md`，列出 P0–P4、当前阻塞与验收规则。
2. 完成产品需求、架构、开源参考和开发运维文档，注明证据来源及尚未接通的数据服务。
3. 创建原生小程序 app manifest、占位 AppID、中文首页和仅含合成数据的示例库存。
4. 创建共享类型包、Fastify API、live／ready 路由、PostgreSQL pool 和事务式 SHA-256 校验迁移 runner。
5. 配置 unit tests、ESLint、全工作区 TypeScript 检查、Dockerfile 和 Compose 服务；生成 lockfile 时把 npm cache 放进允许路径。
6. 执行 `npm run lint`、`npm run typecheck`、`npm test`、`npm run build`；若本地 Docker 引擎依然不可用，不拉取镜像、不写入系统缓存，并准确标记数据库／容器验证为 `BLOCKED`。
7. 复查新增文件、gitignore、敏感字符串和 Compose 端口绑定；更新本任务状态并提供下一步。

## 验收与状态含义

- 静态 PASS：代码／配置检查在本地完成。
- API 单测 PASS：注入合成数据库依赖验证 health route；不证明 PostgreSQL 真实连接。
- Docker／数据库启动 PASS：只有 API 和 PostgreSQL 容器实际运行且两个 HTTP 检查通过时才记录。
- 微信工具预览 PASS：只有开发者工具实际加载项目后才记录；占位 AppID 不等于账号批准。
- 生产／真实服务状态：本阶段均为 `NOT_RUN`。

## 回退范围

目标目录从空目录起始；本增量只添加明确位于上述项目路径内的新文件。如某一步失败，保留证据、修复本增量自己的文件，不清理或覆盖目录外内容。
