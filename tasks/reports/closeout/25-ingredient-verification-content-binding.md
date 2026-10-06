# Flutter 成分核验内容绑定验证（2026-10-06）

## 结论与范围

- 基线：`016bdb4e3d33ae85818cb4d8ad71b050fd8e3e1f`，最初工作树干净。
- **发布前本地自动化验证通过。** 已取得真实基线 RED、候选 36 项专项 GREEN、Flutter analyze 零问题及全量 710 项通过。
- 仅改动 Flutter 药品录入页、两份相关测试、本报告与实施经验，共 5 文件。不改 R6 小程序照片 QA 包、AppID、现有本机试用或历史药品记录；本报告不代表部署或真实设备验收。

## 缺陷与修复

旧实现把 `ingredientsVerified` 作为独立布尔值，手动改写、清空和联网候选补入成分时均不失效。在未修复的 016bdb4 隔离副本中，真实生产页面经过“核验 A → 清空 → 候选 B → 保存”后，实际发出的 B payload 为 `reviewStatus: user_confirmed`。测试期待 `unverified` 而失败，证实原缺陷，非测试环境失败。

确认现在绑定到与保存共用解析器得到的具体成分列表：

- 用户输入与程序写入均经 controller listener 使原确认失效；清空再改回 A 不自动恢复确认。
- 空列表不能获得确认；仅分隔符、首尾空格及光标变化且实际提交列表不变时保留确认。
- 不推断药名、剂量、成分顺序或不同文本在医学上等价。新成分必须由用户明确重新确认。
- 新草稿持久化内容绑定。尚未冻结提交的旧草稿若只有布尔标记，保留字段但要求重新核对。
- 联网查询在同意查询、响应和候选选择返回后检查原草稿、成分修订号、身份、页面及保存状态，阻止旧响应修改后续草稿或正在保存的表单；保留显式 mounted 检查供生命周期与 analyzer 验证。

### 不确定旧请求的保留边界

已有 `attemptedPayload` 时，原 idempotency key、成分和 `reviewStatus` 原样重试，因为服务端可能已接受原提交。此次不改写冻结请求，也不追溯降级历史记录。“旧草稿需重新核对”仅适用于尚未冻结的新提交；专门测试证明旧冻结负载不变。

原保存意图测试的三处设置顺序改为先填写成分、再明确确认。原先先对空字段设置 `true` 再填入成分，与新的内容绑定不变量冲突；所有保存快照、payload、reviewStatus 和 GET 次数断言均保留，没有削弱。

### 动态验证中补齐的同流程框架问题

首次专项为 34 通过 / 2 失败，全量为 708 通过 / 2 失败。两条失败均在草稿选择列表触发 Flutter 的真实框架断言：ListTile 与 Material 之间存在有色 DecoratedBox，会遮挡背景或点击反馈。只在本页草稿列表外补透明 Material，没有改共享组件、删除断言或吞掉异常；同两用例重跑通过。首次 analyze 的 4 项异步 context 提示及 1 项测试 null-aware 语法提示也已直接修正。

## 已通过的覆盖

新增 21 个 Widget 场景：A 清空后填候选 B 的实际提交、手工改写、改回 A 后重新确认、不变内容/光标、候选不覆盖已确认字段、候选后的明确确认、两种空内容、三种草稿绑定恢复、持久草稿切换、异步响应跨草稿/编辑周期、剂量/顺序/列表变化、候选面板打开后的身份/成分变化、保存中的晚到响应，以及旧冻结请求原样重试。

测试通过 MockClient 检查生产页面真正发出的 `activeIngredients`、`leaflet.reviewStatus` 及重复成分 GET，不只检查复选框外观。使用合成资料，没有真实医疗记录、登录或照片上传。

## 本轮最终结果

| 检查 | 2026-10-06 实际结果 |
| --- | --- |
| 基线成分 RED | 已复现：期望 unverified，实际 user_confirmed |
| 成分专项 + 原保存意图 | 36 PASS / 0 FAIL |
| Flutter analyze --no-pub | PASS，No issues found |
| Flutter test --no-pub 全量 | 710 PASS / 0 FAIL / 0 SKIP |
| npm run lint / typecheck / build | 全部 PASS |
| npm test：小程序 | 326 PASS / 0 FAIL / 0 SKIP |
| npm test：API | 238 PASS / 0 FAIL / 13 SKIP |
| npm test：tooling | 94 PASS / 0 FAIL / 0 SKIP |
| npm run check:miniprogram:package | PASS（116 文件 / 593570 字节） |
| git diff --check | PASS |
| Android 构建、真机、真实微信、部署 | NOT_RUN |

API 的 13 项跳过均为 `TEST_DATABASE_URL` 未配置时的可选真实 PostgreSQL 集成组，未记为通过。精确提交的远端 CI 另行核实，未引用基线远端绿灯替代本轮验证。

## 可复现工具与验证命令

验证工具为官方 Flutter **3.47.6** / Dart **3.13.5**。Linux x64 SDK SHA-256：`f1631b9c2c8b3529323db412b0d1beacf4a748f8783b0d7cf599a8fd5f461675`；来源为[官方版本清单](https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json)。

在 `apps/flutter` 下使用相同工具版本和独立依赖缓存：

```sh
flutter pub get
flutter test --no-pub --reporter expanded test/medicine_entry_ingredient_verification_test.dart test/medicine_entry_save_intent_test.dart
flutter analyze --no-pub
flutter test --no-pub --reporter expanded
```

基线 RED 使用未修复的 `016bdb4` 源码加同一首个专项场景，按名称 `verified A cleared then candidate B saves B as unverified` 单独运行。最终专项保留该场景的请求内容断言。

## 交付边界

独立只读复核已检查代码、测试断言、实际执行日志及内容哈希，未发现阻断；该复核没有另行重跑 Flutter。远端 CI、Android 构建、真实服务、手机、数据库集成及部署应分别核实，不能把本文的本地自动化结果扩大解释为这些阶段已通过。
