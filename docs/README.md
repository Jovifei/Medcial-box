# 项目文档入口

本文档指向家庭药箱的当前实现说明与操作资料。产品边界和验收状态以仓库代码、当前状态台账和带版本的验证报告为准。

**历史文档说明**：2026-11-07 经 Jovi 确认，已删除工作树中的历史回执/计划/报告（原 `docs/operations/archive/` 45 篇、`tasks/plans/`、`tasks/archive/`、`tasks/reports/`），原文均可在 git 历史（提交 `3096197` 及之前）检索；各端单平台归档保留在 `apps/<端>/docs/archive/`。

## 多端目录划分（2026-11-07）

项目按端并行开发：小程序（已完成）、网页端、App（安卓 = Flutter，iOS = 原生独立）。目录划分原则：

**共用（放仓库根，跨端共享，不做平台副本）**

- `docs/product/`：产品需求与边界。
- `docs/architecture/`：总体架构与跨端技术决策。
- `docs/operations/`：API/部署/数据保护与现行回执。
- `docs/references/`、`docs/design/`：外部来源登记与跨端设计稿。
- `packages/contracts/`：前后端共享类型契约；`apps/api/`、`deploy/`、`scripts/`、`data/`：共享后端与工具链。

**各端专用（代码与文档均在各端目录内，每端一个 `docs/`）**

| 端 | 代码 | 专用文档 |
| --- | --- | --- |
| 微信小程序 | `apps/miniprogram/` | [apps/miniprogram/docs/](../apps/miniprogram/docs/README.md)：微信后台 SOP、小程序发布验收 |
| App（安卓） | `apps/flutter/` | [apps/flutter/docs/](../apps/flutter/docs/README.md)：签名、真机、Release 验证 |
| App（iOS） | `apps/ios/`（未开工） | [apps/ios/docs/](../apps/ios/docs/README.md)：原生独立路线占位 |
| 网页端 | `apps/web/`（未开工） | [apps/web/docs/](../apps/web/docs/README.md)：技术栈待拍板 |

单平台的现行文档与归档随其端目录存放。

## 本地工作区与交付约定

两个工作区属于同一个 Git 仓库，各自检出完整源码并绑定自己的集成分支。源文件和文档以仓库内路径确定归属。用 `git worktree list` 查看实际检出路径和分支。

| 接收线 | Windows 入口 | 集成起点 |
| --- | --- | --- |
| 微信小程序 | `E:\project\medcial_box-miniprogram` | 已核对的远端小程序提交。该入口指向 Codex 管理的实际检出。 |
| Android App | `E:\project\medcial_box` | 本地 Flutter 功能候选，再合入已核对的远端 App UI。 |

接收顺序为小程序、本地 App 集成。共用 API、契约、版本和跨端设计集中管理。各端的操作说明、验收回执和预览归入各自的 `docs/`，从「各端专用」表的文档索引进入。

以根 `VERSION.json` 为版本基准。每个候选记录完整提交、源码树、同提交 CI、包摘要、API 地址和迁移清单。分别记录自动化、设备验收和平台发布。小程序按微信后台和他人真机门槛取证，App 按正式签名、保数据安装和真机门槛取证。

## 现行文档索引

- [当前状态](../tasks/status.md)与[最新交付回执](operations/69-RECEIPT-App苹果风改版与功能对齐第一批-20261107.md)：最新入口。
- [双端 Apple 风 UI 交付](design/APPLE_UI_DELIVERY_20261109.md) 记录共同设计、平台差异和接收边界。
- [本地接收台账](../tasks/todo.md) 记录各分支的提交与验证状态。
- [项目 README](../README.md)：模块、当前门槛和常用开发命令。
- [产品需求](product/requirements.md)：首版用户目标和健康信息边界。
- [技术架构与运行边界](architecture/overview.md)：微信小程序、Flutter、API、数据库和重试/提醒/导出责任。
- [MVP 设计历史](architecture/mvp-design-2026-09-24.md)：早期 MVP 的设计依据，不代表当前实现状态。
- [识别服务路线](architecture/recognition-provider-decision-2026-09-27.md)：识别适配器与故障边界。
- [本地开发与数据保护](operations/local-development.md)：本地 API/PostgreSQL、小程序隔离副本和密钥边界。
- [独立测试环境部署](operations/staging-deployment.md)：HTTPS 测试服务、部署前检查与恢复演练。服务器操作需按该文档的外部准备门槛执行。
- [域名DNS与国内部署决策](operations/17-ARC-域名DNS与国内部署决策.md)：国内用户路线、当前Cloudflare权威DNS、历史阿里云迁移方案与尚未执行的边界；域名操作前先读此记录。
- [本机条码资料库](operations/12-SOP-本机药品条码资料库.md)与[条码资料库私有配置](operations/27-GUIDE-条码资料库私有配置.md)：查询来源、人工审核导入和本机启动。
- [微信后台设置与真实验收清单](../apps/miniprogram/docs/16-SOP-微信后台设置与真实验收清单.md)：main合并后隐私/UGC/版本配置边界与真实平台验收；小程序专用文档目录。
- [外部接口与开源来源](references/)：来源登记和依赖核查。

自动化通过、容器健康或 IDE 导入仅证明对应层级。真实身份、手机、模板消息、系统分享、正式签名、HTTPS 和恢复演练分别记录，不相互替代。
