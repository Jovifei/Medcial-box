# 家庭药箱

面向一个家庭的共享药箱，用来记录药品、库存批次、有效期与存放位置，维护照护计划，并在用户确认后把资料导出给外部 AI。应用只做记录与资料整理，不诊断疾病，也不根据库存推断个人应当用药什么。

## 当前状态

截至 2026-10-07，最终审核候选已通过 PR #1 合入 `main`。当前 main merge commit 为 `de74a585dc77ac7f113d6473901f19d5cb606f87`。该版本通过代码与自动化门禁，但仍处于 **FINAL_AUDIT / PARTIAL**，不代表正式生产上线。

- 数据库增量迁移已延伸到 `030_medicine_brand_and_purpose_tags.sql`；部署顺序仍是迁移 → API → 客户端。
- Android 候选版本已推进到 `1.0.3+6`；仓库默认 Release 不提供正式分发签名。正式发布仍需独立 keystore 与发布流程。
- 小程序和 Android 已对齐四个主入口、药品/批次、日期、归档/低库存/未知状态、照片草稿、用药计划与待处理语义；QA 沙盒对本地组件和照片文件能力保持显式白名单，新增能力默认 fail-closed。
- 代码/CI 通过不等于生产交付完成。真实 HTTPS、正式 Android 签名、真实微信 OAuth、模板与消息送达、两账号两设备、真实相机/扫码/OCR、系统分享及目标环境数据库+私有照片恢复仍需独立验收。
- 当前审核结论与阻断项见 `tasks/reviews/2026-10-07-final-delivery-audit.md`。

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

本地 API/PostgreSQL 的隔离启动、健康检查和数据保护步骤见 `docs/operations/local-development.md`。真实微信账号、合法 HTTPS 域名和手机验收仍需单独完成。

## 当前候选阶段

当前 main 版本用于后续真实环境验收，不代表已发布。版本、签名、API origin、微信平台配置和目标数据库迁移必须在发布前按最终审核报告逐项核对。历史报告保留对应提交证据，但不得把旧测试计数、旧安装包或旧真机截图直接当作当前候选验收结果。

## 数据和安全边界

照片、库存与剂量备注属于需要保护的家庭健康信息。当前自动化验证仅使用合成数据。未来图片使用服务端鉴权和私有存储；模型与药品查询密钥只放在后端环境；后端每次按家庭检查权限。应用内的信息仅作药箱记录和来源核对，不能从库存或通用说明推断某个人应当用药。
