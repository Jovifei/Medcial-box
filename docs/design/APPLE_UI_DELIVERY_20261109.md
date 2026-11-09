# 小药箱：App 与微信小程序 Apple 风格交付

日期：2026-11-09（Asia/Shanghai）。本轮是现有产品的交互与界面优化，不是正式发布记录。

## 1. 已核实的源码边界

- 实时 GitHub `main`：`3a9afefe3fcae0f5a827a728c7b71faa5fec102a`。
- 基线源码树：`21a6372b420142f264e909bdc17cb2c9acda4380`。
- 用户提供的本地候选：`codex/flutter-app-parity@7ecc7b3dd30e81b1c8d6bee533e076dde3e1b07b`，树 `f33f77a7bda70f61eed49acbf093208a396464a4`。
- 本轮开始时 GitHub 对该候选返回 `No commit found for SHA`，远端也没有同名分支。两个候选提交不能由状态描述还原，不能声称已经合并。
- 版本保持 `1.2.1+19`、`candidate`，源自根目录 `VERSION.json`。本轮不产生正式签名安装包或改变生产服务。

本轮从已取得的 `main` 建立两个独立工作区：

| 分支 | 职责 | 共同基线 |
| --- | --- | --- |
| `codex/app-apple-ui-20261109` | Flutter App 交互、原生组件适配、App 测试 | `main@3a9afef` |
| `codex/miniprogram-apple-ui-20261109` | 微信小程序页面、WXSS、微信交互与测试 | `main@3a9afef` |

这是同一仓库的两个开发分支，保留完整单仓库结构。共享 API、数据契约与版本约束仍使用原主线；平台功能修改分别落入对应目录。没有为了拆分分支删除另一端代码。

App 的当前实现范围为 `apps/flutter` 中的 Android 客户端。`apps/ios/docs/README.md` 明确 iOS 采用原生独立路线，目前只有规划文档、尚未初始化工程；本轮不将 Android 的苹果风界面误称为已实现 iOS 客户端。

## 2. 当前产品实际已有的能力

以下是源码和导航核查结果，不代表本轮完成过真实账号、设备或发布验收。

| 用户任务 | 已有入口与能力 | 本轮保留原则 |
| --- | --- | --- |
| 进入自己的家庭药箱 | 微信登录、家庭创建/加入/切换；App 临时连接码与设备授权 | 保留身份、家庭隔离及会话失效处理 |
| 找药 | 名称/用途等搜索、状态筛选、排序、药品详情 | 生效条件明确、可清除，不把筛选为空误报成没有库存 |
| 录入/修改药品 | 药品基本信息、批次、库存、效期、照片与识别候选、草稿 | 不改变保存负载、人工核对与草稿保护 |
| 处理库存 | 待处理、补货、盘点、归档、最近删除、变更记录 | 保留入口和原有确认机制 |
| 记录用药与照护 | 用药计划、照护对象、计划详情/历史、提醒设置 | 记录动作不等于诊断或剂量建议；日期和状态必须准确 |
| 家庭协作 | 家庭成员、邀请、家庭设置、共享权限 | 分享仍由用户主动触发，权限以原服务返回为准 |
| 数据管理 | 清单预览/导出、备份恢复、账号和设备管理 | 不变更真实数据、存储命名空间及迁移 |

两端稳定主导航均为 **药箱 / 用药计划 / 我的**。家庭管理位于药箱顶部及“我的”中，不为了风格更换增加第四个 Tab。

## 3. 设计取舍

### 共同语言

- 沿用品牌绿 `#087F5B` 表示主操作与选中态；中性分组背景、白色内容层、清晰分隔线。
- 沿用 App `DESIGN.md` 已由用户实测确定的中文紧凑字号：大标题 28、正文 15；层级靠已有字阶、字重和分组建立，不将所有文字扩大。
- 药品状态有清晰文字标签，危险、警告、未知状态不只靠颜色区分。
- 操作命中区按 48 的实现目标处理，布局允许长文字和系统大字号换行；320 宽和 200% 文字单独核查。
- 毛玻璃只适合导航和控制层，内容本身保持清晰、稳定。没有把药品行改成玻璃卡片墙。

### 平台差异

| 项目 | App | 小程序 |
| --- | --- | --- |
| 导航与返回 | 复用 Cupertino 导航、底部栏、系统转场 | 保留微信原生导航、胶囊和返回栈 |
| 页面布局 | 延续紧凑连续列表、分组设置 | 统一旧灰绿视觉到同一语义色，保留原生页面结构 |
| 筛选 | 现有筛选弹层 + 页面可读的生效条件 | 原有折叠面板 + 页面可读的条件摘要 |
| 大字体 | 跟随 Flutter TextScaler；设置行可自适应 | 使用实际 px 最小点击区与可换行布局；不将 rpx 尺寸等同于最小触控像素 |
| 分享/提醒 | 沿用现有系统分享、设备授权与提醒能力 | 沿用微信授权、分享和订阅能力，不绘制假系统控制 |

### 官方依据

- [Apple HIG Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Apple HIG Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)
- [Apple HIG Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)
- [Apple HIG Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Apple 较大文字评估标准](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/larger-text-evaluation-criteria)

这些原则指导本轮实现；它们不是 Apple 官方认证，也不能替代本项目的真实设备可访问性检查。

## 4. 分阶段执行与证据标准

| 阶段 | 工作 | 完成依据 |
| --- | --- | --- |
| 基线核对 | GitHub 实时分支、SHA、功能入口与历史约束 | 实际 clone/refs/API 与源码；明确缺失候选 |
| 设计 | 共用语义语言、三栏信息架构、平台差异 | 交互参考、设计说明、与实现一致的页面清单 |
| App 实现 | 搜索筛选反馈、空态/错误态、设置行排版 | 针对性交互测试、analyze、实际 Widget 渲染 |
| 小程序实现 | 共享样式、筛选反馈、计划日期与窄屏布局 | 行为回归、lint/typecheck/build、源码包门禁、合成渲染 |
| 独立复核 | 数据/权限保护与路由保全 | 对最终 diff 复核；新精确小程序树审核后才能进入既有隔离 QA |
| 交付 | 两个分支、中文提交、独立 PR 与同 SHA CI | 以 GitHub 最终提交与 Actions 结果为准 |

测试区分：源码静态检查、合成业务行为、合成/Widget 渲染、微信官方编译、设备安装、真实服务、正式签名与上线。不同层级不能互相代替。

## 5. Figma 状态

已实际调用 Figma 创建文件及工作会话。随后读取设计库和画布的调用均被 Figma 服务拒绝：

> You've reached the Figma MCP tool call limit on the Starter plan. Upgrade your plan for more tool calls.

因此新建文件 `BxAJ5cmnErekGzDOc9vSju` 当前是空白文件，**不是完成设计稿**。本轮以同目录的 HTML 设计参考和真实代码继续工作。额度恢复后，按实际实现回填可编辑页面和组件；不能将 HTML 或截图冒充 Figma 节点。

## 6. 缺失本地候选的接入方法

在用户原仓库先确认 `git status --short` 干净，确认 `git rev-parse codex/flutter-app-parity` 仍是给出的 40 位 SHA，然后推送：

```sh
git push -u origin codex/flutter-app-parity
```

该候选可访问后，先对比它相对于 `3a9afef` 的两个提交并保留全部候选功能，再将最新 `main` 纳入候选并分别合入这两个 UI 分支。对于同一页面的冲突，保留候选业务能力和本轮 UI 改进，重新跑受影响的交互回归。不能用整文件“取一边”解决业务冲突，也不应强推覆盖本机候选。

正式合并/发布仍需最终精确 SHA 的 CI、真实服务、签名、保数据安装与真机验收证据。旧 Draft PR #7 继续由 Owner 处理；本轮新分支不复用它。

## 7. 本机看板报告

本轮执行环境无法读取 Windows 上的 `E:\project\codex-project-hub\integration\bound_report.py`；已尝试读取 revision，结果为文件不存在。本地看板更新没有成功。待上报状态随交付保留，接收本轮代码后由本机按其真实 revision 生成并发送正式事件；不虚构成功回执或复用旧工作区身份。

## 8. 本轮最终验证

最终测试结果、提交/树 SHA、Actions 和已知限制记录在各分支的交付回执及 PR 中。历史 902 项通过、19 项跳过只属于用户提供的 2026-11-08 台账，不作为本轮已执行测试。
