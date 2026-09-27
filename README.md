# 家庭药箱

面向一个家庭的微信药箱：共同记录家中药品、各批次数量和有效期；需要时导出 Markdown 给外部 AI。手动药箱、共享、导出和拍照识别草稿链路已实现；真实药盒准确率、双手机试用和 ECS 部署仍待验收。服务不可用时首页显示可恢复的错误状态，不把合成数据冒充真实库存。

## 目录

- `apps/miniprogram/`：微信原生小程序和 TypeScript 预览骨架。
- `apps/flutter/`：独立 Flutter 交互原型，当前只使用本地合成数据。
- `apps/api/`：Fastify API、PostgreSQL 访问和有校验的数据库迁移。
- `packages/contracts/`：前后端共享的基础数据契约。
- `docs/`：产品需求、架构、开源调研和本地运维说明。
- `tasks/`：分阶段任务、当前状态和执行计划。
- `deploy/`：Docker Compose 开发环境和无密钥环境变量示例。
- `tests/`：不含个人数据的合成测试样例。

## 本地开发

要求 Node.js 22 或更新版。依赖下载缓存放在允许的项目专属位置；`node_modules` 是本机忽略文件：

```powershell
npm ci --cache E:\Claude_allow\Download\medcial_box\npm-cache
npm run lint
npm run typecheck
npm test
npm run build
```

启动本地 API 和 PostgreSQL：

```powershell
Copy-Item deploy/.env.example .env
docker-compose --env-file .env -f deploy/docker-compose.yml up --build
```

> 本机 Docker CLI 未安装 `docker compose` 插件，统一使用独立版 `docker-compose`；装有插件的环境可等价替换为 `docker compose`。

存活检查：`http://127.0.0.1:3000/api/v1/health/live`；数据库就绪检查：`http://127.0.0.1:3000/api/v1/health/ready`。本地密码仅用于开发；共享部署必须设置私有环境变量，并把服务放在 HTTPS 反向代理之后。Compose 将端口绑定到本机回环地址，不会直接暴露到公网。

开发微信小程序时，先用实际 AppID 和本地回环 API 生成隔离导入包，再在微信开发者工具打开命令输出的目录：

```powershell
npm run prepare:mini -- --appid <实际AppID> --api-base http://127.0.0.1:13301 --local
```

生成包位于 `.local-data\mini-local-<UUID>`，只包含公开客户端配置，不含服务端密钥。源目录 `apps/miniprogram/` 仍使用 `touristappid` 占位值，避免把本地或生产 AppID 写入源码。

## 项目阶段

- **P0**：产品／架构文档、任务台账、前端首页骨架、API／数据库开发环境。
- **P1**：手动药品／批次库存、微信登录和 Markdown 导出，先解决向外部 AI 提供真实库存的需求。
- **P2**：家庭邀请共享、成员权限与并发编辑。
- **P3**：药盒拍照识别、药品资料查询和说明书来源核对。当前已完成本地 Ollama 草稿链路；云端和真实药盒继续按证据推进。
- **P4**：现有 Linux 服务器部署、备份恢复和多设备家庭试用。

下一步实现顺序与验收见 [`tasks/plans/2026-09-24-mvp-roadmap.md`](tasks/plans/2026-09-24-mvp-roadmap.md)。机器服务、合成测试、真实微信和药品数据服务各自记录证据，不能互相代替。

手机试用准备的当前证据见 [`tasks/reports/2026-09-27-phone-trial-readiness.md`](tasks/reports/2026-09-27-phone-trial-readiness.md)。独立 HTTPS 测试部署和备份恢复步骤见 [`docs/operations/staging-deployment.md`](docs/operations/staging-deployment.md)。本地可用 `npm run test:integration`（需 `TEST_DATABASE_URL`）、`npm run check:staging` 和 `npm run prepare:mini` 检查相应配置。

拍照识别的固定技术路线、模型切换、故障排查和验收边界见 [`docs/architecture/recognition-provider-decision-2026-09-27.md`](docs/architecture/recognition-provider-decision-2026-09-27.md)。

Flutter 交互原型的运行说明见 [`apps/flutter/README.md`](apps/flutter/README.md)。它不替换微信小程序，先用于验证页面跳转、底部面板、确认弹窗和药品详情动画。

## 数据和安全边界

照片、库存与剂量备注属于需要保护的家庭健康信息。当前本地验证仅使用合成数据。未来图片使用服务端鉴权和私有存储；模型与药品查询密钥只放在后端环境；后端每次按家庭检查权限。应用内的信息仅作药箱记录和来源核对，不能从库存或通用说明推断某个人应当用药。
