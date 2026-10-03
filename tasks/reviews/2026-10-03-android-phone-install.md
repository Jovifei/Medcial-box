# Android 手机安装与启动记录

日期：2026-10-03。工作区基线 736d762；保留工作区现有用户修改。

## 执行结果

- Flutter Release APK 构建：PASS。初次构建发现 ML Kit 插件引用了未打包的可选文字脚本类；当前 App 只调用中文识别，因此在 R8 规则中仅抑制未使用的天城文、日文、韩文类缺失告警。
- APK：包名 com.joviluma.home_medicine_flutter，versionName 1.0.0，versionCode 1；non-debuggable；SHA256 B6C2A252CCD8A0B5540F36A2C5CC5BE8BA0F30F0639B8A3292AADB071C64D5DB。
- 签名：debug keystore，不是正式应用商店签名。签名与手机原安装包一致后才执行覆盖安装。
- 安装：adb install -r 成功。firstInstallTime 仍为 2026-09-27 21:28:22，确认原安装和应用数据未清除；lastUpdateTime 更新为 2026-10-03 22:16:28。
- 启动：MainActivity 成为 ResumedActivity；有 Flutter Impeller 初始化信息，所查 350 条末尾日志没有 AndroidRuntime 致命错误或崩溃。进程仍在运行。

## 限制

APK 编译时设置 API_BASE_URL=https://medbox-test.joviluma.com。该域名 DNS/ICP/HTTPS 和远端 API 尚未就绪，因此本轮只确认 Release 构建、覆盖安装和启动；真实微信登录、家庭、药品、拍照上传、服务端识别与数据同步均 NOT_RUN。

此包适合本机测试，不可作为正式商店发布包：正式发布还需正式签名密钥及上线前的真机业务验收。没有清除日志缓冲、卸载应用、清理数据或执行数据库删除。
