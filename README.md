# 家庭药箱

面向一个家庭的微信药箱：共同记录家中药品、各批次数量和有效期；通过照片减少录入工作；需要时导出 Markdown 给外部 AI。当前仓库处于 **P0：项目规划与可运行骨架**，界面中的药品均为标注过的合成示例。

## 目录

- `apps/miniprogram/`：微信原生小程序和 TypeScript 预览骨架。
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

开发微信小程序时，在微信开发者工具中打开 `apps/miniprogram/`。项目配置使用 `touristappid` 作为占位值；该设置只便于查看本地骨架，正式预览、登录和真机验证要等小程序账号获批后配置实际 AppID。

## 项目阶段

- **P0**：产品／架构文档、任务台账、前端首页骨架、API／数据库开发环境。
- **P1**：微信登录、家庭邀请共享、手工药品和批次库存管理。
- **P2**：药盒拍照识别、药品资料查询、说明书来源核对。
- **P3**：Markdown 预览、复制和文件分享。
- **P4**：现有 Linux 服务器部署、备份恢复和多设备家庭试用。

机器服务通过、合成测试通过和真实微信／模型／药品数据服务验收是不同证据，分别记录在 [`tasks/todo.md`](tasks/todo.md)。

## 数据和安全边界

照片、库存与剂量备注属于需要保护的家庭健康信息。当前 P0 不收集真实数据。未来图片使用服务端鉴权和私有存储；模型与药品查询密钥只放在后端环境；后端每次按家庭检查权限。应用内的信息仅作药箱记录和来源核对，不能从库存或通用说明推断某个人应当用药。
