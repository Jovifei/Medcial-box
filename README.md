# 家庭药箱

面向一个家庭的共享药箱：共同记录药品、批次、开封期限、剩余数量和来源资料，并导出给外部 AI。当前分支正在完善微信小程序与 Android Flutter 双端候选版本；自动化和本地 Docker 验收通过不代表真实微信账号、设备通知或生产上线已经通过。

## 目录

- `apps/miniprogram/`：微信原生小程序和 TypeScript 预览骨架。
- `apps/flutter/`：Flutter Android 客户端；连接家庭 API，演示流程独立放在 `/demo/*`。
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

## 当前候选阶段

本轮在 `codex/flutter-ui-prototype` 分支交付双端共享库存、开封后期限、库存阈值与盘点、补货、待处理、设备连接、条码候选、提醒、导出与恢复。分阶段事项和真实环境阻塞见 [`tasks/todo.md`](tasks/todo.md) 与 [`tasks/status.md`](tasks/status.md)。

没有核实正式 AppID、可用微信订阅模板和两台手机之前，不宣称真实账号登录、微信消息送达或家庭试用通过；本轮不部署 ECS。原始 MVP 阶段计划仍在 [`tasks/plans/2026-09-24-mvp-roadmap.md`](tasks/plans/2026-09-24-mvp-roadmap.md)。

手机试用准备的当前证据见 [`tasks/reports/2026-09-27-phone-trial-readiness.md`](tasks/reports/2026-09-27-phone-trial-readiness.md)。独立 HTTPS 测试部署和备份恢复步骤见 [`docs/operations/staging-deployment.md`](docs/operations/staging-deployment.md)。本地可用 `npm run test:integration`（需 `TEST_DATABASE_URL`）、`npm run check:staging` 和 `npm run prepare:mini` 检查相应配置。

拍照识别的固定技术路线、模型切换、故障排查和验收边界见 [`docs/architecture/recognition-provider-decision-2026-09-27.md`](docs/architecture/recognition-provider-decision-2026-09-27.md)。

Flutter Android 客户端的运行和验收边界见 [`apps/flutter/README.md`](apps/flutter/README.md)。字体、资料接口和开源项目来源登记在 [`docs/references/`](docs/references/)。

## 数据和安全边界

照片、库存与剂量备注属于需要保护的家庭健康信息。当前本地验证仅使用合成数据。未来图片使用服务端鉴权和私有存储；模型与药品查询密钥只放在后端环境；后端每次按家庭检查权限。应用内的信息仅作药箱记录和来源核对，不能从库存或通用说明推断某个人应当用药。
