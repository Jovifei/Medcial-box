# 家庭药箱

面向一个家庭的共享药箱，用来记录药品、库存批次、有效期与存放位置，维护照护计划，并在用户确认后把资料导出给外部 AI。应用只做记录与资料整理，不诊断疾病，也不根据库存推断个人应当服用什么。

## 当前状态

当前源码基线为 `codex/flutter-ui-prototype` / `736d762`（2026-10-03），状态仍为 **IMPLEMENTATION_AND_VERIFICATION / PARTIAL**。代码已经覆盖微信原生小程序、Android Flutter、Fastify API 与 PostgreSQL；远端提交的 GitHub CI 已通过。代码与自动化通过不等于真实账号、手机、消息送达或生产上线验收。

- 计划创建已加入幂等回执和两端显式重试（迁移 `028_medication_plan_create_receipts.sql`）。本地新增“支”单位使用迁移 `029_tube_quantity_unit.sql`；正式部署先应用待用迁移（包括 `028`、`029`），再部署 API，最后更新客户端。
- 当前仍需补齐 Android 计划表单的星期选择、药箱药品关联、普通表单草稿，以及跨进程导出文件清理和异常退出后的身份恢复。
- 真实微信账号、双账号双手机、真实通知与文件分享、HTTPS 部署、签名发布及数据库/图片恢复仍待验收。
- 2026-10-03 本机小程序编译与导入记录：[本地验证报告](docs/operations/02-RPT-本地微信小程序导入与编译验证.md)。导入和编译通过；本次 API 主机端口没有正常应答，完整页面/API 联调未通过。
- 2026-10-04 Android 本机复核：[识药、库存单位、日期与 Release 报告](docs/operations/04-RPT-Android识药单位日期与Release验证.md)。Release R8 构建已通过；Debug 使用本机合成 API 联调。正式 HTTPS 域名仍未解析，真实微信/生产登录和相机识别质量保持 `NOT_RUN`。
- 逐项证据与剩余门槛见[收尾矩阵](tasks/reports/closeout/2026-10-03-current-closeout-matrix.md)。

## 模块

- `apps/miniprogram/`：微信原生小程序，TypeScript、WXML、WXSS。
- `apps/flutter/`：Android 客户端；生产流程走家庭 API，演示流程位于 `/demo/*`。
- `apps/api/`：Fastify 服务、会话/家庭授权、库存和计划 API、识别与导出适配器、提醒调度器。
- `packages/contracts/`：前后端共享的类型契约。
- `apps/api/db/migrations/`：PostgreSQL 增量迁移。
- `docs/`：产品边界、当前架构、操作方法与验证记录。

## 本地开发

要求 Node.js 22 或更新版。安装依赖时将 npm 缓存放在项目专属下载目录：

~~~powershell
npm ci --cache E:\Claude_allow\Download\medcial_box\npm-cache
npm run lint
npm run typecheck
npm test
npm run build
~~~

本地 API/PostgreSQL 的隔离启动、健康检查和数据保护步骤见 [docs/operations/local-development.md](docs/operations/local-development.md)。创建只用于本机回环 API 的小程序副本：

~~~powershell
$miniAppId = (Get-Content apps/miniprogram/project.config.json -Raw | ConvertFrom-Json).appid
$miniProject = node scripts/prepare-miniprogram.mjs --appid $miniAppId --api-base http://127.0.0.1:13301 --local
& "E:\AI_Tools\Other\WeChatDevTools\cli.bat" open --project $miniProject
npm run check:miniprogram
npm test --workspace @home-medicine/miniprogram
~~~

`prepare:mini` 在被忽略的 `.local-data/mini-local-<UUID>` 下生成副本，不改源项目配置、不复制私有配置，也不把服务端 Secret 打包到客户端。该流程用于本地导入和模拟器开发；真实微信账号、合法 HTTPS 域名和手机验收仍需单独完成。

## 数据与安全边界

照片、家庭库存和剂量备注属于需要保护的家庭健康信息。本地试验只用合成数据。服务端按当前会话和家庭成员关系校验权限；家庭 ID 不能代替授权。微信 AppSecret、模型与药品数据服务密钥只保存在服务端私有配置。识别结果先进入待确认草稿，用户确认前不写入库存。
