# 家庭药箱 Android App

Flutter Android 客户端与微信小程序共用 Fastify API。App 不执行微信登录；新设备在 App 显示连接码后，由已登录小程序确认，App 再用独立轮询凭据换取自己的可撤销会话。演示流程保留在 `/demo/*`，不会写入正式家庭药箱。

## 本地开发

Flutter SDK 位于 `E:\AI_Tools\Other\Flutter`，Android SDK 使用 `E:\AI_Tools\Other\AndroidSDK`。将 API 地址通过 `API_BASE_URL` 构建参数设置；默认示例地址不会连接真实服务。

```powershell
$env:FLUTTER_SUPPRESS_ANALYTICS = "true"
E:\AI_Tools\Other\Flutter\bin\flutter.bat pub get
E:\AI_Tools\Other\Flutter\bin\flutter.bat analyze
E:\AI_Tools\Other\Flutter\bin\flutter.bat test
E:\AI_Tools\Other\Flutter\bin\flutter.bat build apk --debug --dart-define=API_BASE_URL=https://<测试 API 域名>
E:\AI_Tools\Other\Flutter\bin\flutter.bat build apk --release --dart-define=API_BASE_URL=https://<可达的 HTTPS API 地址>
```

APK 输出到 `build\app\outputs\flutter-apk\app-<variant>.apk`。实体机连接本地合成 API 时，可在 Debug 变体使用 `API_BASE_URL=http://127.0.0.1:13300` 并先运行 `adb reverse tcp:13300 tcp:13300`；Android cleartext 只在 Debug manifest 中开放。Release 必须传入可达的 HTTPS API 地址。`API_BASE_URL` 是构建时配置；不要把微信 AppSecret、资料服务密钥或模型密钥放入 `--dart-define`。

## 功能范围

- 药箱、待处理、我的三个入口；家庭共享库存、批次开封期限、阈值、补货、盘点、回收站和变更记录来自服务端 API。
- 相机／相册识别和条码扫描均生成可编辑草稿；联网药品候选查询要用户明确同意，结果仍须人工核对。识别和查询失败保留手工录入。
- Markdown、CSV、中文 PDF 和 JSON 备份共用当前家庭数据；个人剂量默认排除。
- 登录凭据保存在 Android 安全存储，库存缓存和录入草稿保存在本地；断网时显示缓存时间，不自动重放写请求。

PDF 使用内嵌的精简简体中文字体。上游、字体加工方式、SHA-256 与 SIL Open Font License 1.1 说明见 [开源参考登记](../../docs/references/open-source-review-2026-09.md)；可在 App“我的 → 开源许可”查看许可文本。

## 验收边界

Widget/API 契约测试和 Debug APK 构建不代表真实微信账号、实体相机／扫码、通知送达或药品资料供应商已经联调。正式 AppID 对应关系、微信模板及类目、两台手机家庭共享、现场拍照与消息点击路径须单独记录结果；尚未实测时使用 `NOT_RUN` 或 `BLOCKED`。

## 本机独立试用（2026-10-04）

使用已启动的本机开发服务器并设置ADB转发，可构建：

```powershell
flutter build apk --release --dart-define=API_BASE_URL=http://127.0.0.1:13300 --dart-define=LOCAL_APP_TRIAL=true
```

此开关只允许loopback与明确声明试用能力的开发服务器。普通构建保持小程序连接流程。当前手机测试结果与源点见docs/operations/07-RPT-最新代码与App独立试用.md。
