# 双端 Apple UI 改动独立源码复查

日期：2026-11-09（Asia/Shanghai）  
审核者：`/root/figma_design`（未修改两个实现工作树）  
基线：`main@3a9afef`  
范围：`/workspace/scratch/26bc2b1ecc02/medcial-app`、`/workspace/scratch/26bc2b1ecc02/medcial-mini` 相对基线的 UI 工作树差异；两代理尚在执行测试时读取，并在修订后定向复核三项发现。

## 结论

未发现本轮引入的主导航、已注册页面或低频功能入口删除；未发现新绑定事件没有实现。初审发现两项小程序 P2 问题，以及一项 App 本轮可一并修复的既有文字对比度遗漏，均已通知实现代理并在最新源码中确认修正；本 review 无待处理阻塞项。

本审核是**源码与状态逻辑复查**，不是实际视觉验收。没有借助未生成的截图断言页面美观、像素准确或无溢出。实现代理的单测、Widget 渲染、真机结果必须分别报告。

## 发现

### MINI-01 · P2：把“未归档”写成“在用”，含义超出了数据

- 文件：`apps/miniprogram/pages/index/index.wxml`，审核时第 5、39、73、76 行。
- 数据依据：`apps/miniprogram/pages/index/index.ts` 第 520–532、555 行。
- 条件：`cabinetCount` 只按 `!item.isArchived` 计数，全部状态同样仅排除归档；已过期、已用完、待核对仍可进入这一集合。
- 影响：新增的“X 种在用药品”“全部在用”“查看全部在用药品”“在用药品”把归档状态解释成正在使用/服用，和现有数据不一致。该误导在含过期、耗尽药品的正常药箱中即可出现。
- 建议：改为“药箱记录”“未归档药品”或与范围明确一致的“全部药品”；不需要更改过滤规则。
- 最终状态：**已修正（源码复核）**。最新 `index.wxml` 第 5、42、74、77 行分别为“X 种药品”“全部未归档”“查看全部未归档药品”“药箱记录”，数据过滤规则保持不变。

### MINI-02 · P2：详情操作栏依赖导航恰好 48px，高字号时可能叠压

- 文件：`apps/miniprogram/pages/medicine-detail/medicine-detail.wxss` 审核时第 398 行；`components/business-nav/business-nav.wxss` 第 24–25、35、41、66–67 行；`medicine-detail.wxml` 第 195–196 行。
- 条件：详情操作栏固定在 `bottom: calc(48px + safe-area)`；业务导航只有 `min-height:48px`，文字和 padding 可以把实际高度撑大。导航 z-index 90，高于详情操作栏 89。
- 影响：在窄屏且文字放大的情况下，“用药计划”可自然换行，导航实际高度超过 48px；同一固定偏移不能再把操作栏完整放在其上方。属于源码可确定的尺寸依赖风险；本轮无浏览器截图，不声称已在设备上复现。
- 建议：不要使用一个最小高度推算另一个固定栏的偏移。现有 `business-nav` 已支持 `embedded`：可将详情动作与 embedded 导航放入同一底部布局并自然堆叠，或使用经过实测的动态高度；同时保留足够内容底部留白。
- 最终状态：**已修正（源码复核）**。最新 `medicine-detail.wxml` 第 195–198 行将动作栏与 `embedded="{{true}}"` 的业务导航放在同一 `detail-footer`；`medicine-detail.wxss` 第 398–402 行使用固定外层、静态动作栏和随文字尺寸变化的底部留白，消除了用导航最小高度推算偏移的依赖。无设备截图，仍不声明所有字号场景已视觉验收。

### APP-01 · P2（继承遗漏，非新增业务回归）：11pt 效期摘要继续使用高亮橙/红

- 文件：`apps/flutter/lib/features/home/production_shell.dart` 审核时第 1015–1020 行。
- 条件：药品行摘要使用 `AppType.caption1`（11）和 `CupertinoColors.systemOrange` / systemRed；列表浅色表面为 `secondarySystemBackground`。
- 影响：最早效期这一关键小字在浅色表面对比偏低。按源代码的 RGB 以标准 sRGB 相对亮度计算，`#FF9500` 对 `#F2F2F7` 约 1.97:1，`#FF3B30` 约 3.18:1。不能因为旁边状态胶囊可读，就认定日期本身可读。
- 建议：本轮已新增 `AppSemanticColors.warningLabel` / `dangerLabel` 且胶囊已使用，可在摘要上复用。上述深橙/深红与同一表面对比分别约 6.10:1 / 5.89:1。
- 归因：基线已经存在该配色，本轮重排保留了它；不是新引入的逻辑缺陷，不应扩展为全项目主题翻修。
- 最终状态：**已修正（源码复核）**。最新 `production_shell.dart` 第 1020–1025 行已在小字摘要使用 `AppSemanticColors.dangerLabel` / `warningLabel`，与状态胶囊一致。

## 已确认保留/改善的行为

### App

- `ProductionShell` 仍为药箱/用药计划/我的三项；`app.dart` 路由注册语义未被本轮修改。后续该文件有格式调整及系统字号与用户偏好的组合修复，后者由 root 和 App 代理另行验证，不混为本次只读 review 的测试结果。
- 家庭入口由标题栏跳转到“我的”家庭分组；新增滚回顶部逻辑考虑了 `disableAnimations`，并检查 mounted / scrollController.hasClients。
- “我的”保留照护对象、补货、盘点与频率、通知、导出、备份、最近删除、审计、设备授权、账号、字体、版本等入口，并新增可直接发现的归档入口。
- 归档页改用 `AppleScreen`，该骨架仍内嵌 Material/Scaffold，保留已有 Material 控件环境。
- `AppleListRow` 主文字在 Expanded 内，字幕与补充说明按内容增高；尾部按钮在窄屏/大字号时下移，行本身有 48 最小高度。检查到的用途没有把互相冲突的行点击和尾部按钮动作叠在一起。
- `selected` 透传 Semantics；筛选仍使用真实现有状态值，归档仍进入独立页。没有以“视觉简化”为由删除条件。
- 筛选/搜索摘要、结果数、清除动作和加载失败重试均接真实 state / repository。
- 日期未知从默认“有效”分离为“日期待补充/效期待核对”，没有把未知数量当作 0。
- 计划初次加载失败不再显示成功型空安排；有缓存时明确提示正在显示上次读取的安排。
- `PrimaryButton` 不再在子 Text 强制白字，从而让主题/禁用态解析前景色；没有新增点击 API。

### 小程序

- 实际对比 `app.json`：26 个页面注册顺序、3 个 tab 的路由/标签与基线完全一致；只修改窗口/tab 颜色。
- 对两个变更模板作事件名核对：药箱 17 个绑定、用药计划 12 个绑定均能在对应 TypeScript 中找到实现；新添的关闭筛选、清空搜索及回到今天有真实 handler。
- 重置筛选保留搜索词；空结果的“一次恢复”动作同时清空搜索和条件，两种意图分开。
- `cabinetCount` 清理覆盖身份切换/缓存清空路径，没有把上一家庭计数留在新家庭标题。
- `onReturnToday` 回到上海日历当天；`refresh` 更新 `isToday`。空态根据选定日期描述，并在已有计划时引导查看全部计划，不再错误声称从未创建计划。
- 日期记录写入继续使用既有 loadedDate / identity / sequence 守卫，未放松旧响应和跨日写入防护。
- 首页连续列表、状态文字、灰色未知状态、原生分享和原生主 tab 保留；不增加仿制 iOS 状态栏。
- 多个交互区改用最小高度与自然换行，尤其计划操作、菜单行、照片和详情操作；新 theme 仍只有浅色 token，不能把参考稿的深色切换宣传成小程序全局深色已实现。

## 验证范围与最终稿区分

- 本次只进行只读 diff / 定向源码检查和上述事件/页面映射核对，没有替实现代理重复执行完整测试。
- 设计参考 `apple-ui-reference.html` 是提案与交互说明，不是这两个客户端的生产截图；其中演示日期/深色/按钮等能力需按各端实际落地分别说明。
- `reference-verification.json` 的 11 项检查仅覆盖参考 HTML 的本地状态和模板，不覆盖 Flutter / 微信业务行为。
- Figma 画布为空的配额门槛、HTML 视觉 NOT_RUN 状态均继续保留。

## 设计交付路径

目录：`/workspace/scratch/26bc2b1ecc02/design-work/`

- `apple-ui-reference.html`
- `APPLE_UI_DESIGN_20261109.md`
- `reference-verification.json`
- `verify-reference.cjs`
- `INDEPENDENT_REVIEW_20261109.md`（本文）

以上文档由 root 集成到 Git 对应设计/交付目录；本代理未修改两个实现工作树，也未推送分支。
