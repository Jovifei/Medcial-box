# 本地 Docker 与微信登录：阶段验收

本轮顺序由 Jovi 确认：本机 Docker → 小程序真实登录 → 远端 ECS。以下只记录本机合成数据与项目专属容器，不记录密码或 AppSecret。

## 本地 Docker：PASS

- Docker Desktop Linux Engine 报告版本 `29.7.2`。启动前检查了现有容器和监听端口，没有停止或更改其他项目资源。本机 `3000` 已被占用，使用新项目名 `medbox-local-trial` 和仅回环开放的 `127.0.0.1:13301`。
- Git 忽略的 `deploy/.env.local` 已由安全随机数生成 48 位十六进制数据库密码，AppID 已配置；Jovi 已自行填入唯一的微信 AppSecret。格式验证通过，值未写入日志或报告。Compose 配置通过 `config --quiet`。
- 所需 `postgres:17-alpine` 与 `node:22-alpine` 通过固定镜像摘要下载到允许目录 `E:\Claude_allow\Download\medcial_box\crane-v0.22.1` 的 tar 归档，再导入本机 Docker。下载工具 `crane` v0.22.1 Windows 包按上游 GitHub release SHA-256 `0e073ea8192c3b8442ec8aaf44d53c1050a09084669fae3a6ceb0f2026cf8b21` 校验。
- `docker compose --env-file deploy/.env.local -p medbox-local-trial -f deploy/docker-compose.yml up -d --build --pull never` 完成。`medbox-local-trial-db-1` 和 `medbox-local-trial-api-1` 均健康；数据库内部端口 `5432/tcp` 未发布至主机，API 映射为 `127.0.0.1:13301->3000/tcp`。
- 真正的 PostgreSQL 17 数据库中 `schema_migrations` 为 5 条。`GET /api/v1/health/live` 返回 `{"status":"ok"}`；`GET /api/v1/health/ready` 返回 `{"status":"ok","database":"connected"}`。
- 仅针对本轮修改的配置生成器执行 `npm run test:tooling` 3/3 PASS 与 `npm run lint` PASS。生成的本地小程序副本在被 Git 忽略的 `.local-data/mini-local-0b105a2d-b233-486c-a9de-8bf26232da2c`，AppID 为用户提供值，API origin 为本机回环，`urlCheck=false` 仅用于开发者工具本地调试。

## 微信登录：开发者工具真实提供商 PASS，真机 NOT_RUN

- 微信开发者工具 2.02.2609231 已从腾讯官方发行地址下载到允许目录，安装包 SHA-256 与微软 winget 清单 `9f5945b190106d0a2553b1637abfd3e75b92b42c4c7d7bf4d43bdac19e060aa1` 一致；安装于 `E:\AI_Tools\Other\WeChatDevTools` 并已打开。
- IDE 的 CLI 服务端口默认关闭。未更改安全设置；Jovi 可在 GUI 中扫码，并手动打开上述本地小程序目录。
- 填入 AppSecret 后，仅重新创建 `medbox-local-trial-api-1`，数据库容器和其他项目未改。API `/ready` 仍 PASS，容器内只核对了 AppID/AppSecret 是否存在。容器到 `api.weixin.qq.com` 的 HEAD 请求已到达服务端（HTTP 405，方法不支持）；这仅证明网络可达。
- Jovi 在开发者工具导入本地项目后，API 实际收到 `POST /api/v1/auth/wechat` 并返回 200；真实 PostgreSQL 中用户数从 0 到 1、会话数从 0 到 1。此路径使用容器内的 `HttpWechatGateway` 和 Jovi 私下填写的 AppID/AppSecret，没有假网关或测试登录入口。随后无家庭请求返回 404，符合新用户需创建家庭的流程。
- Jovi 随后通过小程序创建纯测试家庭；数据库读数为 families 1、family_members 1、medicines 0。家庭创建路径在开发者工具与真实 PostgreSQL 间打通，药品录入待继续验证。
- Jovi 在手工录入时指出原页面字段过多，因此暂停长表手填验收，转为拍照优先的最少输入设计；实施和本地合成图片证据见 `tasks/reports/2026-09-27-photo-first-local.md`。
- 证据级别为 `PASS_DEVTOOLS_REAL_PROVIDER`；真机登录、双账号共享与 `.md` 分享仍为 `NOT_RUN`。家庭创建、批次录入与导出页面仍待本地交互确认。

## 下一步

在开发者工具用合成图片完成草稿核对、批次录入和 Markdown 导出，并确认页面与数据库一致。完成本地验收后，按独立测试部署计划处理 ECS；远端当前 `NOT_RUN`。
