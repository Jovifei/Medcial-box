# 本地开发与数据保护

## 运行环境

- Node.js 22 或更新版、npm workspaces、微信开发者工具（打开 `apps/miniprogram/`）。
- Docker Desktop 使用 Linux 容器，`docker compose` 可访问 Docker 引擎。
- 首次安装依赖：`npm ci --cache E:\Claude_allow\Download\medcial_box\npm-cache`。
- API 和 PostgreSQL 本地启动：

  ```powershell
  Copy-Item deploy/.env.example .env
  docker-compose --env-file .env -f deploy/docker-compose.yml up --build
  ```

  本机只有独立版 `docker-compose`（v5.4.0），未安装 `docker compose` 插件；文档与脚本统一使用 `docker-compose`。

`.env.example` 中口令只用于开发。服务器部署必须在主机或密钥管理系统配置口令、微信 AppSecret、模型 API key 和药品数据 API key；不能提交到仓库或编译进小程序。

## 健康检查

- `GET http://127.0.0.1:3000/api/v1/health/live`：存活检查。
- `GET http://127.0.0.1:3000/api/v1/health/ready`：PostgreSQL 连接和查询检查。
- 仅存活检查返回 200 不代表数据库、微信登录或任何外部识别服务就绪。

## 迁移与备份

- 新建本地 volume 时，PostgreSQL 运行 bootstrap；API 启动时运行完整迁移。运行迁移：`npm run db:migrate --workspace @home-medicine/api`（须先设置 `DATABASE_URL`）。迁移必须向前兼容且新增文件，不编辑已应用文件。迁移文件名使用零填充数字前缀（如 `002_add_family.sql`）；执行顺序按数字前缀排序、不依赖字典序，已由迁移 runner 与单元测试固定。
- P0 只创建迁移台账，不录入真实药品。
- 成员、批次与个人剂量备注的数据表和接口已实现（迁移 001–004，含单 owner 约束）；本地与开发环境只录入合成数据，不保存真实家庭信息。数据删除、家庭解散与保留策略在 P4 上线准备时定稿。
- 上线前先验证数据库定期备份与恢复。图片数据位于独立私有文件目录，需要与 PostgreSQL 备份保持可关联并单独备份。恢复练习仅在明确隔离的环境执行。

## 微信账号和服务端发布

本地 `project.config.json` 使用 `touristappid` 占位。通过账号审核后，由项目所有者在受控本地配置实际 AppID 和后端 AppSecret，检查 HTTPS request/upload/download 域名白名单，再验证微信登录和真机拍照。不要修改线上网站反向代理、DNS、服务器或证书来完成本地 P0。

`wx.shareFileMessage` 需要本地或临时文件路径。开发者工具预览不算最终分享验收；P3 必须在真实微信客户端验证 `.md` 文件，并保留复制文本功能。

服务器部署须绑定已批准的小程序 HTTPS 域名、单独 PostgreSQL 凭证和访问日志策略。Compose 当前只用于回环地址开发；生产发布另建经审阅的配置，不复用默认口令，不公开数据库端口。
