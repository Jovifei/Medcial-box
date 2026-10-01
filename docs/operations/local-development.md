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

  本机当前 `docker compose` 与 `docker-compose` 均报告 v5.4.0；旧命令仍可使用。

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

`project.config.json` 已填入药箱专用 AppID（`wx1f6dd99d28aab8e5`，公开客户端标识）。后端登录交换还需要服务端 AppSecret：由项目所有者在 `deploy/.env.local`（Git 忽略）的 `WECHAT_APP_SECRET` 填写，不出现在命令行、聊天记录或小程序包。HTTPS request/upload/download 域名白名单在真机联调前核对；本地开发者工具调试回环 API 时关闭域名校验即可。

`wx.shareFileMessage` 需要本地或临时文件路径。开发者工具预览不算最终分享验收；P3 必须在真实微信客户端验证 `.md` 文件，并保留复制文本功能。

## 已隔离的本机 Docker 登录试验

本机已有其他项目容器时，使用独立项目名和未占用的回环端口。将私有 `deploy/.env.local` 放在 Git 忽略范围内：`POSTGRES_PASSWORD` 是本项目数据库密码，`WECHAT_APP_ID` 是小程序公开标识（药箱专用 `wx1f6dd99d28aab8e5`），`WECHAT_APP_SECRET` 是唯一的微信服务端密钥；后者只由所有者在本机文件内填写，不出现在命令行或小程序包。服药提醒模板（R4）在 mp 后台「功能 → 订阅消息」申请后，把模板 ID 填入 `WECHAT_DOSE_REMINDER_TEMPLATE_ID`，并把 `WECHAT_DOSE_REMINDER_SCHEDULER_ENABLED=true` 打开；模板未配置时服药提醒如实不可用，计划与今日安排不受影响。

```powershell
docker compose --env-file deploy/.env.local -p medbox-local-trial -f deploy/docker-compose.yml config --quiet
docker compose --env-file deploy/.env.local -p medbox-local-trial -f deploy/docker-compose.yml up -d --build --pull never
```

小程序本地调试副本可用 `npm run prepare:mini -- --appid <实际AppID> --api-base http://127.0.0.1:13301 --local` 生成到 `.local-data/mini-local-<UUID>`，源配置不变。`--local` 仅允许回环 HTTP origin，并将开发者工具域名校验设为关闭；真实设备和远端验收仍使用 HTTPS 和合法域名。开发者工具的 CLI 服务端口若默认关闭，可直接在 GUI 扫码并打开生成目录，无需改变该安全设置。

拍照识别本地优先使用已在 Windows 安装的 Ollama 模型。私有 `deploy/.env.local` 中设置 `MEDICINE_RECOGNITION_PROVIDER=ollama`、`OLLAMA_BASE_URL=http://host.docker.internal:11434`、`OLLAMA_MODEL=qwen3.5:0.8b`；Docker Desktop API 可通过该主机名访问本机服务。识别接口只返回待人工核对的草稿。不要把 `11434` 公开到网络；此地址不适用于远端 ECS。百炼适配器仅在服务端显式选择 `dashscope` 且配置独立密钥时使用。

服务器部署须绑定已批准的小程序 HTTPS 域名、单独 PostgreSQL 凭证和访问日志策略。Compose 当前只用于回环地址开发；生产发布另建经审阅的配置，不复用默认口令，不公开数据库端口。
