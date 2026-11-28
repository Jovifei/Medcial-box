# T2 合成测试验证回执与真机就绪清单（2026-11-16）

- 依据：小药箱最终方案 v1.0（Jovifei/Medcial-box draft PR #15 head `033dc254`，`docs/product/execution-plan-ux-m1-m5-20261116.md`）§3「合成测试与真实设备流程互补」；工作总群 #238 修改版派单。
- 本轮范围：T2 合成测试部分（失败态、边界字号、重复提交）+ T2 硬门槛核查 + 真机四步验收就绪材料。真机四步（邀请、录入与找药、识别失败回退手填、导出与撤权）**未执行**，等账号/环境获准。

## 1. 合成测试执行回执（2026-11-16 实跑）

| 端 | 命令 | 结果 |
| --- | --- | --- |
| 微信小程序 1.2.1 @ `codex/app-ui-integration-20261109`（含 T1 提交 `2ded241`） | `npm test`（`node --test test/*.test.mjs`） | **755 pass / 0 fail / 0 skip**，11.8s |
| Flutter App build 20 @ 同分支 | `E:\AI_Tools\Other\Flutter\bin\flutter test` | **910 pass / 0 fail / 19 skip**，约 2.2 分钟 |

19 项 skip 为既有条件跳过（平台相关），与本轮改动无关；两端均无新增失败。

### 三维度覆盖对应（方案 §3）

- **失败态**：`cabinet_loading_state_test.dart`（App 三态区分）、`home-loading-state.test.mjs`、`entry-session-late-failure.test.mjs`、`medicine_entry_capture_errors_test.dart`、`photo-failure-category.test.mjs` 等，全部通过。
- **边界字号**：`system_font_scale_test.dart`（系统 200% 保持、大档 240%）、`apple_ui_interaction_test.dart`（48 命中区）、`medicine_entry_layout_test.dart` 等，全部通过。
- **重复提交**：`plan-create-idempotency.test.mjs`（丢失 ACK 显式重试不重复建、表单变更不静默重复提交、并发保存合并为一次 dispatch 等）、`medicine_entry_save_intent_test.dart`、`dose_confirmation_retry_test.dart`（两端）、`plan_creation_intent_widget_test.dart` 等，全部通过。

## 2. T2 硬门槛核查（版本 / 账号环境 / 阻断）

1. **测的是哪一版**：已固定（T1）——小程序 1.2.1 源码 `5a19400`（包 SHA `6cbd1b20…`）；Android 1.2.1/build 20 源码 `2f88956`、装机 APK SHA `27a40df2…`。真机两台设备各自装包版本在四步验收首步现场复核。
2. **账号/环境获准**：**未获准，阻塞中**——待业主确认（见 §4 请示项）。
3. **无已知越权或数据损坏阻断**：合成侧证据支持——
   - 越权/错家庭：`medicine-entry-owner-boundary`、`multi-family-navigation`、`session-boundary`、`unselected_family_auth_test`、`care_permission_contract` 等守卫测试全绿。
   - 数据损坏：唯一源码级已知缺口为小程序 M1「刷新失败清空展示列表」（`showUnavailable` 置空 `allItems`）。本轮实查确认其只影响页面内存态（`setData`），load 失败路径无任何 `wx.removeStorageSync`/本地库存清除动作，服务端库存不受影响；**定性为展示层体验缺口（T3 候选修复项），不构成数据损坏阻断**。
   - 重复写入：幂等/保存意图测试全绿（见 §1）。

## 3. 真机四步验收就绪清单（材料准备，开跑待批）

- **设备**：双机（现有 Android build 20 测试机 + 第二台设备，型号待业主指定）。
- **账号**：双微信账号（业主确认哪两个；当前仅主账号在用，第二账号未建）。
- **测试家庭**：新建测试家庭（名称建议「药箱测试家庭」，仅含两测试账号）。
- **虚构药品数据**（全部虚构，不含真实药品/批号/照片）：
  - A「测试药品甲」：数量 24、效期已知、规格已知——用于正常录入与找药；
  - B「测试药品乙」：数量未知（库存待核对）、效期未知——用于 M3 不确定信息；
  - C「测试药品丙」：仅手填路径（不提供照片/条码）——用于识别失败回退。
- **四步流程与取证**（每步截图预算内、文字回执）：
  1. **邀请**：账号一建家庭 → 生成邀请码 → 账号二扫码/输码加入 → 双端家庭成员列表一致。
  2. **录入与找药**：账号一录入 A/B/C → 双端搜索、筛选、排序结果一致 → M3 状态表达核对。
  3. **识别失败回退**：对 C 走拍照/扫码识别失败路径 → 手填补录成功 → 草稿与证据链不残留（回收/清理验证）。
  4. **导出与撤权**：账号二导出清单（仅测试家庭数据）→ 账号一撤权账号二 → 账号二复查读取/修改/再次导出均被拒、无越权缓存展示 → 账号一数据完整无损。
- **M1–M5 实况核对**：四步流程中顺带按 T1 映射表逐项勾选「已具备/缺失/未验」的实况结果。
- **阻断判据**：任一越权、错家庭、丢数据、重复写入出现即停止，当轮上报，不受「前两处」限制。

## 4. 请示项（均为业主决定，未确认不执行）

1. **T2 账号/环境**：双机第二台设备与第二个微信账号是否指定？测试家庭是否按 §3 建立？
2. **分享对象**：初轮导出仅限获准测试对象——按 §3 双账号互为测试对象是否可行？
3. （T4 启动前四项：参与人、两个微信账号、测试家庭、1.2.1 体验资格——另批，不在本轮请示范围，仅列示。）

## 5. 边界

- 本轮只读源码 + 跑既有测试 + 写文档，未改业务代码、未用真实药品/家庭数据、未合并 main、未发布、未改生产配置。
- 执行环境：`E:\project\medcial_box` @ `codex/app-ui-integration-20261109`。
