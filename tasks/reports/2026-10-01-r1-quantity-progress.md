# R1 库存模型 · 数据层进展报告（2026-10-01）

对照 [双端录入体验与用药计划实施方案](../plans/2026-10-01-dual-client-experience-and-medication.md) 第三节第 1 条与第四节 R1：新增 `ml`／`blister` 单位、数据库改为定点数量、服务端定点运算。本报告只覆盖**已完成的后端数据层**，R1 尚未整体完成。

## 已完成：R1-1 定点数量与单位（后端）

### 迁移 013（新增，不改已执行迁移）

| 改动 | 细节 |
|---|---|
| 单位枚举扩展 | `medicine_batches.unit`、`restock_items.unit`、`medicines.low_stock_threshold_unit` 三处约束加入 `ml` 与 `blister` |
| 数量列定点化 | `medicine_batches.quantity`、`confirmed_units_per_package`、`medicines.low_stock_threshold_quantity`、`stocktake_items.expected_quantity`／`observed_quantity`、`restock_items.desired_quantity` 由 `integer` 改为 `numeric(14,3)`，既有整数数据无损转换 |
| 精度约束 | 新增跨列 CHECK：只有 `ml` 允许小数，计件单位必须 `= trunc(quantity)` |

### 服务端

| 文件 | 改动 |
|---|---|
| `packages/contracts/src/index.ts` | `QuantityUnit` 拆为 `CountQuantityUnit`（含 `blister`）＋ `MeasuredQuantityUnit`（`ml`） |
| `apps/api/src/domain/decimal.ts`（新增） | `decimalOrNull`／`toMilli`／`fromMilli`：numeric 经 pg 返回字符串的统一归一与毫单位定点运算 |
| `apps/api/src/inputs.ts` | 新增 `quantityOrNull`（按单位校验：ml ≤3 位小数、计件单位整数）、`positiveQuantityOrNull`、`stocktakeQuantityOrNull`；阈值／补充数量／拆分校验全部切换 |
| `apps/api/src/repositories/batches.ts`、`medicines.ts` | 行类型放宽为 `number \| string \| null`，summary 输出统一经 `decimalOrNull` |
| `apps/api/src/routes/inventory.ts`、`batches.ts` | 盘点项、补货项、回收站、拆分比较全部归一；回收站 UNION 空值类型改 `numeric` |
| `apps/api/src/services/markdown-export.ts` | 单位标签补 `blister: 板`、`ml: 毫升` |

### 验证

| 项目 | 结果 |
|---|---|
| 新增真实 PG 套件 `integration-pg-quantity.test.mjs` | **6/6**：迁移列精度与约束、12.5ml 与 0.001ml 往返、计件小数被拒（400）、ml 四位小数被拒、0 与未知可区分、盘点保留小数、备份往返保留 7.5／12.5／200.5 |
| 既有 PG 套件回归 | `integration-pg` **19/19**、`integration-pg-reminders` **4/4** |
| 根门禁 | lint / typecheck / build PASS；小程序 56/56；API 单元 182 PASS；工具 6/6 |

改造中发现的连带修正：审计事件 `changes` 里的 numeric 以字符串保存（触发器既有行为），测试改为显式归一后比较。

## 已完成：R1-2 人群／用途标签（后端）

### 迁移 014（新增）

| 改动 | 细节 |
|---|---|
| 标签列 | `medicines.population_tags text[]`、`purpose_tags text[]`（默认空数组 = 未标注）；`tag_source`（`manual`／`catalog`／`imported`），默认 `manual` |
| 元素白名单 | `population_tags <@ ARRAY['adult','child']`、`purpose_tags <@ ARRAY['fever','cough','throat','nasal','gastro','pain','topical','allergy','other']`，数据库兜底 |
| 筛选索引 | 两列各建 GIN 索引，供药箱多选筛选使用 |

### 服务端

- contracts：新增 `PopulationTag`、`PurposeTag`、`TagSource`；`CreateMedicineInput` 与 `MedicationSummary` 增加标签字段（向后兼容，旧客户端忽略即可）。
- inputs：新增 `tagList` 校验（白名单、去重、非数组报错）；空数组语义为"未标注"。
- 仓储：`insertMedicine`／`updateMedicine` 读写标签列；summary 输出 `populationTags`／`purposeTags`／`tagSource`。
- 旧 `purposeCategory` 自由文本完全保留，与标签并存，不被覆盖。

### 验证

新增真实 PG 套件 `integration-pg-tags.test.mjs` **5/5**（迁移列与白名单、标签去重与多选往返、清空为未标注、旧自由文本存活、非法/非数组 400、`@>` 包含语义筛选）。既有套件无回归：数量 6/6、提醒 4/4、主套件 19/19。API 单元 182 PASS（含两处参数索引断言更新）。

## R1 尚未完成（下一步）

| 子项 | 内容 |
|---|---|
| R1-2 标签 | 人群（成人／儿童／未标注，可多选）与用途（发热、咳嗽、咽喉、鼻部、胃肠、疼痛、外用、过敏及其他）数据结构与 API；旧用途字段兼容读取，自由文本不丢失 |
| R1-3 照片 | 包装图片用途与药盒封面引用；保存失败需明确告知，不能让人误以为已保存 |
| R1-4 双端同步 | Flutter 与小程序的数量模型、阈值、盘点、拆分、补货、导出（CSV/PDF/Markdown）全部支持 ml 小数与两个新单位 |
| R1-5 备份版本 | JSON 备份 `schemaVersion` 升级并兼容旧版；旧客户端读到新单位时提示更新，禁止静默转成"其他" |
| R1-6 单位切换守卫 | 单位切换不自动解释旧数字、保存前要求确认；未确认换算时展示分组余量（如"2 板＋3 片"）不强行相加 |

R1 的验收标准是"双端同一样例结果一致"，因此 R1-4 不可跳过；Flutter 侧仍需 SDK 环境才能取得证据。
