# 家庭药箱

面向一个家庭的共享药箱，用来记录药品、库存批次、有效期与存放位置，维护照护计划，并在用户确认后把资料导出给外部 AI。应用只做记录与资料整理，不诊断疾病，也不根据库存推断个人应当服用什么。

## 当前状态

截至 2026-10-07，最新最终审核候选位于 `audit/final-delivery-2026-10-07-review`，状态为 **FINAL_AUDIT / PARTIAL**。该候选整合微信原生小程序、Android Flutter、Fastify API、PostgreSQL、照片/识别、用药计划、提醒、导出/备份和本机药品资料能力；尚未合入 `main`，也未部署为正式环境。

- 数据库增量迁移已延伸到 `030_medicine_brand_and_purpose_tags.sql`；部署顺序仍是迁移 → API → 客户端。
- Android 候选版本已推进到 `1.0.3+6`；仓库默认 Release **不提供正式分发签名**。本机 loopback 试用只有在显式签名开关 + `LOCAL_APP_TRIAL=true` 下才允许沿用调试证书。
- 小程序和 Android 已对齐四个主入口、药品/批次、日期、归档/低库存/未知状态、照片草稿、用药计划与待处理语义；QA 沙盒对本地组件和照片文件能力保持显式白名单，新增能力默认 fail-closed。
- 代码/CI 通过不等于生产交付完成。真实 HTTPS、正式 Android 签名、真实微信 OAuth、模板与消息送达、两账号两设备、真实相机/扫码/OCR、系统分享及目标环境数据库+私有照片恢复仍需独立验收。
- 当前审核结论与阻断项见 `tasks/reviews/2026-10-07-final-delivery-audit.md`（本分支生成）。

## 模块

- `apps/miniprogram/`：微信原生小程序，TypeScript、WXML、WXSS。
- `apps/flutter/`：Android 客户端；生产流程走家庭 API，演示流程位于 `/demo/*`。
- `apps/api/`：Fastify 服务、会话/家庭授权、库存和计划 API、识别与导出适配器、提醒调度器。
- `packages/contracts/`：前后端共享的类型契约。
- `apps/api/db/migrations/`：PostgreSQL 增量迁移。
- `docs/`：产品边界、当前架构、操作方法与验证记录。

## 本地开发

要求 Node.js 22 或更新版：

~~~powershell
npm ci
npm run lint
npm run typecheck
npm test
npm run build
~~~

本地 API/PostgreSQL 的隔离启动、健康检查和数据保护步骤见 [docs/operations/local-development.md](docs/operations/local-development.md)。创建只用于本机回环 API 的小程序副本：

~~~powershell
$miniAppId = (Get-Content apps/miniprogram/project.config.json -Raw | ConvertFrom-Json).appid
$miniProject = node scripts/prepare-miniprogram.mjs --appid $miniAppId --api-base http://127.0.0.1:13301 --local
& "<微信开发者工具 CLI 路径>" open --project $miniProject
npm run check:miniprogram
npm test --workspace @home-medicine/miniprogram
~~~

`prepare:mini` 在被忽略的 `.local-data/mini-local-<UUID>` 下生成副本，不改源项目配置、不复制私有配置，也不把服务端 Secret 打包到客户端。该流程用于本地导入和模拟器开发；真实微信账号、合法 HTTPS 域名和手机验收仍需单独完成。

## 数据与安全边界

开发微信小程序时，先用实际 AppID 和本地回环 API 生成隔离导入包，再在微信开发者工具打开命令输出的目录：

```powershell
npm run prepare:mini -- --appid <实际AppID> --api-base http://127.0.0.1:13301 --local
```

生成包位于 `.local-data\mini-local-<UUID>`，只包含公开客户端配置，不含服务端密钥。源目录的 `project.config.json` 已包含药箱公开 AppID；生成包仍须使用与目标环境一致的公开客户端配置。AppID不是服务端密钥，也不能证明真实登录或模板已经验收。

## 当前候选阶段

当前候选只用于最终审核与修复，不代表已发布。版本、签名、API origin、微信平台配置和目标数据库迁移必须在发布前按最终审核报告逐项核对。历史报告保留对应提交的证据，但不得把旧测试计数、旧安装包或旧真机截图直接当作当前候选验收结果。

## 数据和安全边界

照片、库存与剂量备注属于需要保护的家庭健康信息。当前本地验证仅使用合成数据。未来图片使用服务端鉴权和私有存储；模型与药品查询密钥只放在后端环境；后端每次按家庭检查权限。应用内的信息仅作药箱记录和来源核对，不能从库存或通用说明推断某个人应当用药。


### 2026-10-04 本地整合补充

远端功能进展以 f5e17e5 为基线；本地中文日期滚轮、OCR 药名清洗、支(tube)单位及迁移029一并保留。先前本地真机与构建证据见 docs/operations/04-RPT-Android识药单位日期与Release验证.md；不视为本次整合后验证。真实身份、通知及正式部署仍待验收。
