# Android 实体机安装与启动验证

日期：2026-10-03（Asia/Shanghai）  
源码：`codex/flutter-ui-prototype` / `736d7623435e2a38e3ebb51859574d43dffa0120`

## 结论

**最新 Debug APK 已用数据保留方式安装到 OnePlus 7 Pro（GM1910），应用启动并进入前台；未发现 FATAL/ANR 信号，首次安装时间保持不变。** 本次未登录、未配置可用 API 地址，也未触碰通知权限或家庭数据流程。此 Debug 安装不构成正式 Release 验收。

## 工具链与测试

| 项目 | 结果 |
|---|---|
| 项目识别 | Flutter，包名 `com.joviluma.home_medicine_flutter` |
| 工具链 | Flutter 3.47.5 / Dart 3.13.4、JDK 17、Android SDK build-tools 37.0.0 |
| `flutter pub get --enforce-lockfile` | PASS；依赖锁文件未改 |
| `flutter analyze` | PASS，无诊断 |
| 本机 `flutter test` | 259 项通过、9 项失败。8 项临时导出安全测试在创建 symlink 时因 Windows 返回权限错误 1314 失败；依赖版本边界测试未能从 CRLF 的 `pubspec.lock` 匹配包段。它们没有证明相关产品逻辑通过。 |
| 精确提交 CI | GitHub Actions [run 37107940730](https://github.com/Jovifei/Medcial-box/actions/runs/37107940730) 对提交 `736d762` 显示 Success。 |
| Release 构建 | FAIL：`assembleRelease` 在 `minifyReleaseWithR8` 失败，R8 报告缺少 ML Kit Devanagari/Japanese/Korean recognizer classes。项目 Android 配置包含中文识别依赖。没有生成新的 Release APK。 |
| Debug 构建 | PASS：生成 `apps/flutter/build/app/outputs/flutter-apk/app-debug.apk`。包名 `com.joviluma.home_medicine_flutter`，版本 `1.0.0 (1)`；SHA-256 `2E9C3D02BB9FA2A565FA5076ED0A226F146BAA71C886F31F5EB77B9483BDAB6C`，签名证书 SHA-256 `9AB144E824ABF26A5941819ABB06831288C36A8BFE622657E3DC9D88281FC774`。`aapt2` 将其标为 `application-debuggable`。 |

Release 错误需要调整 Android ML Kit/R8 构建配置；本轮遵守代码改动需先获 Jovi 授权的约定，没有修改业务或构建源码。正式签名也尚未配置。

## 手机安装与启动

安装前确认手机只连接了一个 ADB 实体设备，型号 GM1910，Android 11 / API 30。构建 APK 与手机已安装包的签名指纹一致，版本号相同。执行的唯一安装变更为：

~~~text
adb -s <device> install -r app-debug.apk
~~~

ADB 返回 Success。安装后包仍存在，首次安装时间与安装前一致；未卸载应用、未清除数据、未删除数据库。随后启动 `com.joviluma.home_medicine_flutter/.MainActivity`，确认进程存活且 Activity 位于前台。按应用 PID 做有界日志筛查，FATAL、ANR、SQLite/Room 和 `NoClassDefFoundError` 信号为 0；没有清空设备日志缓冲区。

## 未验收事项

这次构建没有提供 `API_BASE_URL`。应用启动可观察，但登录/设备绑定、家庭数据、计划、导出、相机及通知都未验收。手机上的登录、连接码、系统权限和账号操作仍由 Jovi 手动完成。要生成非 Debug Release 并完成 Release 安装，还需授权修复 R8/ML Kit 缺类配置，再复跑 Flutter 测试、签名核验和数据保留安装。