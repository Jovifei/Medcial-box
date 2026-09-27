# 家庭药箱 Flutter 交互原型

这是家庭药箱的独立 Flutter 视觉原型，使用本地合成数据，不连接微信登录、真实家庭数据或药品识别服务。

## 本地运行

Flutter SDK 位于 `E:\AI_Tools\Other\Flutter`，Android SDK 使用 `E:\AI_Tools\Other\AndroidSDK`（指向本机已安装 SDK）。

```powershell
$env:FLUTTER_SUPPRESS_ANALYTICS = "true"
E:\AI_Tools\Other\Flutter\bin\flutter.bat pub get
E:\AI_Tools\Other\Flutter\bin\flutter.bat analyze
E:\AI_Tools\Other\Flutter\bin\flutter.bat test
E:\AI_Tools\Other\Flutter\bin\flutter.bat run -d 6e4fa92f
```

Debug APK：

```powershell
E:\AI_Tools\Other\Flutter\bin\flutter.bat build apk --debug
```

输出位于 `build\app\outputs\flutter-apk\app-debug.apk`。

## 原型流程

欢迎页 → 家庭选择 → 创建／加入底部面板 → 药箱首页 → 药品详情 → Markdown 导出选项。

原型重点验证 Flutter 的路由淡入滑动、底部面板、确认弹窗、共享元素动画、搜索、状态卡片和可访问性语义。后续接入真实 API 时，只替换 `AuthRepository` 和 `MedicineRepository` 的实现。
