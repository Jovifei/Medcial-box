# 服药确认：不确定结果的明确重试边界

日期：2026-10-03。基线：`2e0b14ad55d67af92b1d8df28a24fae2a381c004`，分支 `codex/flutter-ui-prototype`。本补丁只修复两端服药确认的操作键、身份/日期和确认回执边界；不改变后端权限、排程、临床规则或库存。

## 缺陷与修复

- 旧小程序和 Flutter 每次点击生成新的时间戳键。服务端已接受但响应丢失后，再次点击会追加重复历史事件。
- 同一未确定操作在同一会话内保留原键，只有用户明确点击才重试；页面加载、刷新和重挂载不重放写请求。
- 原操作结果未确定时，禁止改成相反动作。先明确重试原键，得到确认后才能新建纠正操作，避免延迟的原写入反过来覆盖纠正。
- 已确定后的新动作/纠正均生成新键，A→B→A 不复用旧操作。小程序保留原有纠正确认弹窗，取消不写入。
- 小程序用“重试上次记录”明确显示原动作重试入口，不确定期间隐藏纠正控件。弹窗前上锁；双击和页面重挂载共享在途锁。登录、身份、日期、列表变化后拒绝旧点击；旧页面写入确认后会使新页面的旧读取失效并刷新。
- Flutter 新增 `DoseConfirmationOperations`，按 ApiClient 的 `identityEpoch` 隔离，只保存实例 ID、日期、动作与键等操作元数据。支持同一会话的页面重挂载和明确重试。
- `ApiPlanRepository.confirmDose` 新增可选 `onConfirmed(status)`，在成功 POST 的有效状态返回后、通知/日程刷新前调用。后续同步失败不会把已知成功误认为不确定写入。
- 两端使用服务端回执的当前状态。原动作是服用、另一位已授权用户随后纠正为跳过时，幂等重放显示跳过，不重新断言原动作。
- Flutter 在异步令牌读取完成后、发送已认证请求前重新检查身份代次，阻止旧页面请求借新会话发出。匿名登录/设备连接请求保持原语义。
- 修复 PlansPage 原有的异步 Future 作为 setState 回调返回值问题；日程读取具有身份/序列保护。

## 可复验验证

使用合成实例、内存 HTTP/页面运行时替身，无真实家庭记录或真实外部消息。RED 在独立目录保留新增回归测试与共享 helper（测试导入所需脚手架），将被测小程序 TS/WXML、Flutter PlansPage、ApiPlanRepository 和 ApiClient 全部恢复为精确基线字节；新 helper 的独立单元测试通过不表示原页面通过。GREEN 使用最终候选生产文件。

| 门禁 | 结果 |
| --- | --- |
| 新小程序运行时套件 | 14/14 PASS；精确基线页面运行同套件时 14 FAIL、0 PASS |
| 新 Flutter 套件 | 12/12 PASS；精确基线运行同套件时 10 FAIL、2 PASS；异步令牌边界也单独先 RED 再 GREEN |
| 完整小程序测试 | 195/195 PASS |
| 完整 API 普通测试 | 206 PASS、10 可选 PG 套件 SKIPPED |
| 工具测试 | 6/6 PASS |
| 根 lint / typecheck / build | PASS |
| Flutter analyze | PASS，无诊断 |
| 完整 Flutter 测试（含已合入照护修复） | 88/88 PASS |

命令：`node --test apps/miniprogram/test/dose-confirmation-retry.test.mjs`；Flutter 目录 `flutter test test/dose_confirmation_retry_test.dart`、`flutter analyze`、`flutter test`；根目录 `npm run lint`、`npm run typecheck`、`npm test`、`npm run build`。Flutter 3.47.6 / Dart 3.13.5；使用仓库既有字体资源。

覆盖：接受后丢响应、延迟提交、原键明确重试、禁止不确定相反动作、新纠正、新实例、新日期、双击、弹窗取消、身份/日期在弹窗与登录等待中变化、页面重挂载、旧页完成刷新新页、已确认写入后的读取/通知失败、重放返回另一位用户纠正后的当前状态、旧日程回调和令牌等待期间换身份。

## 契约与剩余边界

- 键仅保存在内存，跨页面重挂载保留，进程终止/重新启动后不保留；重开页面先读服务端，不自动重试。此补丁不承诺跨进程重启的未完成写入恢复。
- 当前 ProductionShell 共享一个 ApiPlanRepository。若未来多个独立 repository 共享同一 ApiClient，新增页面必须订阅共享操作变化并自行作废/刷新旧读取，不能仅依赖另一个 repository 的通知。
- API 重放按实例+键查找并返回当前状态；同一键不能用于不同动作。本补丁未改变这一后端契约。
- Flutter 历史纠正界面属于独立后续补丁；可复用共享操作 helper 与 `onConfirmed`，必须保持不确定原操作先解决、确认回执后才允许新纠正。
- 本补丁无服务端 SQL/API 变更，未重复执行真实 PG；未运行官方微信编译器、Android APK 构建或真实设备/账号/通知验收；未发布、推送或部署。完整 v1 收尾仍不能据此标记完成。

## 独立集成复核

在精确当前分支的完整 Git 检出上重放本补丁后，另行通过根 lint/typecheck/build、全部小程序 195/195、严格真实 PostgreSQL 环境下 API 307/307、工具 6/6，均无跳过；Flutter analyze 无诊断、完整测试 88/88。数据库仍为独立合成数据环境，没有真实服药记录或外部通知。以上补足前述工作副本的可选 PG 跳过，不将未运行的官方微信编译器、APK 或真机验收计为通过。
