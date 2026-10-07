# 2026-10-04 Flutter 字体减包后的测试与许可证修复

- 源码父提交：`4b5b641dcc978f0521ec040ba4f65dd64ebd5ec8`。
- 精确 CI [37216095687](https://github.com/Jovifei/Medcial-box/actions/runs/37216095687)：verify（含严格 PostgreSQL）和隔离 Docker 备份恢复 SUCCESS；Flutter analyze SUCCESS，测试 674 PASS / 2 FAIL；后续 Android 构建 SKIPPED。
- 两项失败为 PDF 字形测试及录入布局测试的 setUpAll，都仍通过 rootBundle 加载已在 `7da2439` 中移出运行包的字体。不是网络、设备或忽略测试可解决的问题。
- 保留移除 10 MB 运行字体的意图：两个宿主测试通过共享 helper 从版本化仓库 fixture 读取字体，保留原 PDF 和布局断言，不跳过、不删测试、不放回生产 APK。
- main.dart 仍向 LicenseRegistry 注册 OFL 文本，因此仅恢复 4 KB 许可证 asset 声明，避免运行时查看许可证时报资源缺失。
- 本地配置回归 1/1 PASS，diff-check PASS。云端没有 Flutter SDK，此批 Flutter 完整测试与 Android 构建必须以本次提交后的 Actions 为准，尚不宣称通过。
- 不涉及账号、真实药品、签名密钥、微信上传或发布。
