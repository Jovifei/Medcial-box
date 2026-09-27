# 家庭药箱 Flutter 交互原型

这是家庭药箱的独立 Flutter 交互原型。库存使用本地合成数据；相机／相册和中文 ML Kit 识别已经接入，识别只生成待人工核对草稿，不连接微信登录或真实家庭数据。

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

点击“录入药品”可选择拍照、相册或手动录入。Android 首次拍照会弹出相机权限；图片识别使用中文 ML Kit，药品名称、规格和有效期都允许人工修改，识别失败仍可直接手动保存。
