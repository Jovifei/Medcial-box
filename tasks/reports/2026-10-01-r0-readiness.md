# R0 就绪核对报告 · 2026-10-01（第二次核对）

对照 [双端录入体验与用药计划实施方案](../plans/2026-10-01-dual-client-experience-and-medication.md) 第四节：R0 的工作是「复核现有未提交修复，完成恢复保真、身份隔离、编辑和提醒回归」，进入 R1 的条件是「高优先级缺陷有行为测试及数据库证据」。

## 结论

**R0 可验证部分已全部完成；A06、A09 两项 Flutter 改动已落代码但本机无 Flutter SDK，未取得行为测试证据——R0 暂不判为通过，需在具备 SDK 的环境补 `flutter analyze && flutter test` 后收口。**

上一版核对（同日上午）结论为"未通过：编辑与提醒回归未完成"，本版为修复后的复核结果。

## 逐项核对

| R0 项 | 状态 | 证据 |
|---|---|---|
| 恢复保真 A01/A02 | **PASS** | `integration-pg` 19/19：导出→预览→恢复逐字段比对（说明书 6 字段、日/月/未知有效期、开封期限、阈值、归档、处置状态），handled 5 盒不计入余量；篡改处置状态恢复 409 |
| 身份隔离 A03（数据层）/A04/A12 | **PASS**（Flutter 侧 NOT_RUN） | 小程序用例：换账号草稿不可见/不可恢复、旧版草稿不迁移、存储抛错仍带 Authorization；Flutter 侧代码已改待验证 |
| 编辑回归 A05（小程序） | **PASS** | 小程序 56/56：慢加载期间保存不新增（`creates=[]`，提示"正在加载"）、加载失败仍保持 `isEdit=true` 且不落新增、加载完成后按新版本走 `updateBatch`；页面新增"加载中/失败可重试"与保存禁用 |
| 编辑回归 A06（App 盘点） | **代码已改 · NOT_RUN** | `_applySnapshot` 按批次替换版本快照（不再 `putIfAbsent` 保留旧值）、刷新后冲突项携带新版本、`saved` 项不再重复提交、`serverChanged` 提示重新核对；**缺 Flutter 编译与测试验证** |
| 数量写入 A09（App 余量） | **代码已改 · NOT_RUN** | 余量面板改为显式结果对象（取消／明确未知／明确数值），取消不产生写请求；`BatchRecord.copyWith(clearQuantity:)` 支持真正清空为 null；**缺 Flutter 验证** |
| 提醒回归 A07 | **PASS** | `integration-pg-reminders`：被移除成员与主动退出成员均不再收到排队提醒；做过反向验证（禁用修复则红灯） |
| 提醒回归 A08 | **PASS** | 新增用例：10-01 命中"30 天后到期"首次投递失败，10-03 只剩 28 天时重试被取消（`blocked/STALE_MILESTONE`），不再补发过时事件 |
| 识别回填 A14 | **PASS** | 小程序用例：识别飞行中用户清空字段，晚到响应不回填；批次被删后晚到响应不错位写入；实现含字段 touched 版本 + 请求代次 + 批次结构快照 |
| 说明书来源 A15 | **PASS** | 小程序用例：用户已手写说明书文字时，确认候选不改写 `leafletSource`；仅当内容全部来自候选时才随内容带上供应商来源 |

## 工程门禁

| 项目 | 命令 | 结果 |
|---|---|---|
| Lint | `npm run lint` | **PASS** |
| 类型检查 | `npm run typecheck` | **PASS** |
| 构建 | `npm run build` | **PASS** |
| 小程序测试 | `node --test test/*.test.mjs` | **PASS 56/56**（新增 A05×2、A14×2、A15×1） |
| API 单元 | `node --test test/*.test.mjs` | **PASS 182**（2 个 PG 套件按设计跳过） |
| 工具脚本 | `node --test scripts/*.test.mjs` | **PASS 6/6** |
| 真实 PostgreSQL | `TEST_DATABASE_URL=… npm run test:integration` | **PASS 19/19 + 4/4**（提醒套件新增 A08 用例） |
| Flutter | `flutter analyze` / `flutter test` | **NOT_RUN**：本机未安装 Flutter SDK |

## 未验证项（不冒充 PASS）

- A06、A09 的 Flutter 改动未编译、未运行；需在有 SDK 的环境执行 `flutter analyze && flutter test`，并补断言：盘点刷新后提交携带新版本、取消面板不产生写请求、留空写 null、0 写 0。
- 真实平台验收（微信模板、真机、双账号双手机、ECS 部署）未开始，属 R4/R5。
- 全部证据来自合成数据 + 一次性 PostgreSQL 17 容器（`medbox-pg-test`，隔离 schema），不代表真机与真实微信验收。

## 下一步

1. 在 Flutter 环境验证 A06/A09；通过后 R0 收口。
2. 进入 **R1 库存模型**：`ml`／`blister`、确认换算、包装与库存照片、人群／用途标签、统一库存状态、备份兼容（新增迁移，不改已执行迁移）。
