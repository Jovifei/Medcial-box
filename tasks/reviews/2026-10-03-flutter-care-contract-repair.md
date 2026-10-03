# Flutter 照护授权契约增量修复

日期：2026-10-03。既有分支 `codex/flutter-ui-prototype`，精确来源提交 `f7d1ea34d853a40917e452b7b44a696f41a82fbd`。本补丁只涉及 Flutter 照护权限页、计划仓库、家庭成员模型及针对性测试。未改 API、数据库、提醒 worker 或小程序。

## 已确认缺口与修复

- `createCareGrant` 接受提醒参数却不发送，导致启用无效，管理权限更新也会由服务端默认值清掉既有提醒选择。现在每次明确发送 `canView`、`canManage`、`receiveDoseReminders`，管理蕴含查看，提醒默认关闭。
- 成功保存授权后未调用仓库变化回调，已有安排刷新链路没有触发。现在仅在成功响应后通知一次，并等待现有 `onChanged`；拒绝请求不宣布保存成功。
- 家庭 API 的 `id` 是成员关系行标识，照护接口的 `memberUserId` 要账号标识。模型独立保留 `userId`，缓存往返保留两者，原 `id` 语义不变。
- 照护成员选择器原用成员关系 ID 去重和提交，且可选自己。现在按账号 ID 去重/提交，排除本人及缺少有效账号 ID 的旧缓存记录；不按姓名或成员关系 ID 猜账号。
- 接收提醒的开关原省略 `canView`，服务端会默认添加查看权。现在提醒开关保留原查看/管理权限；管理开关保留原提醒选择，只有主动开启管理时增加必需的查看权。新增成员明确为仅查看且不接收提醒。

## 验证范围

针对真实生产页面与 `ApiClient`/仓库，用模拟 HTTP 回应验证：完整请求体、四种管理/提醒组合、默认不订阅、成功回调等待、拒绝不回调、模型与缓存账号标识、旧记录兼容、选择器去重和排除、取消无写入、提醒仅接收权限不扩权、失败后的主动重试、处理中禁用重复提交以及退出页面的晚响应。

### 实际执行（独立 Linux 云工作目录）

- 工具：官方 Flutter Git tag `3.47.6`，框架 `5fc346839b5d0eef006ed8404392afb4dfae428d`，Dart `3.13.5`。SDK、依赖缓存和配置限定在云端任务目录，没有使用或修改所有者电脑。
- `flutter pub get`：PASS。沿用精确基线 `pubspec.lock`（Git blob `3359fcd7e479830703ae2f3834f3de052f3f77c9`），未升级项目依赖。基线中文字体按 blob `bbe09e344ca739c72bd31d3844c82653f119fb8f` 校验后参与完整测试，无替代字体。
- 将最终新增测试放到三个精确基线源码文件上执行：RED，15 项中 10 项断言失败、5 项控制通过，退出 1。不是编译失败或缺 SDK。
- 修复后同一针对性测试：PASS 15/15，退出 0。
- `flutter analyze --no-pub`：PASS，无诊断，退出 0。
- `flutter test --no-pub --reporter expanded`：PASS 76/76，无跳过，退出 0；含既有 61 项和新增 15 项。
- 新增测试 `dart format --output=none --set-exit-if-changed`、`git diff --check`：PASS。
- Debug APK：NOT_RUN，本云工作目录没有 Android SDK；本报告不借用基线 CI 的 APK 结果作为本补丁结果。提交后仍应核对该提交的 Flutter CI/APK。
- 真机、真实账号、实际通知与部署：NOT_RUN。

复现针对性命令（在 `apps/flutter`）：`flutter test --no-pub test/care_permission_contract_test.dart test/care_permissions_page_test.dart --reporter expanded`。仅用 MockClient、测试身份与模拟响应，不访问真实家庭或发送通知。

## 仍未关闭

- 当前 Android 提醒使用的日程接口仍按查看权限筛选。只有提醒接收、没有查看权限的成员不会获得 Android 本地通知日程；本补丁保持最小权限，不通过静默添加查看权解决这一独立契约限制，也不新增端点。
- 本补丁的模拟 HTTP 与 Widget 测试不证明真实双账号授权、Android 系统通知送达、微信模板、后台/重启行为或部署验收。
- 新增提醒回调沿用现有刷新链路；其他设备变更的即时同步和真实设备验证仍需独立验收。
- 真实通知、账号、设备安装、签名、供应商、独立 HTTPS 和数据库/图片恢复不在本次操作范围。项目保持 PARTIAL。
