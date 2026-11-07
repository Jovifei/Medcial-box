# Android 识药、库存单位、日期本地化与 Release 验证

日期：2026-10-04（Asia/Shanghai）  
源码基线：`codex/flutter-ui-prototype` / `736d7623435e2a38e3ebb51859574d43dffa0120`；本报告对应的修复仍是未提交工作区改动。

## 结论

- Release APK 已在本机完成 R8 构建，编译时包含 `API_BASE_URL=https://medbox-test.joviluma.com`。APK 为 Release 构建，但使用 Android debug 证书，不能作为正式签名发布包。
- Debug QA APK 使用本机 API 地址 `http://127.0.0.1:13300`，通过 `adb reverse` 在 GM1910 上安装并走通合成设备连接、家庭创建与会话交换。测试使用本机专用 PostgreSQL 数据库和固定合成微信身份，不是真实微信登录。
- 最终检查时，Debug APK 对应的本机假 API 仍监听 `127.0.0.1:13300`，手机 ADB reverse 仍启用；隔离测试库保留合成联调家庭，供本机继续检查。
- 独立 `.qa` 安装和手机上的临时测试照片副本已清理；标准应用包仍在，原有待核对草稿保留。
- 日期滚轮在手机上以中文年、月、日顺序显示；确认后栏位显示 `2026年10月3日`，程序内部与 API 仍使用 `YYYY-MM-DD`。月份精度仍使用 `YYYY-MM`，不会补造具体日。
- `medbox-test.joviluma.com` 最新 DNS 检查仍未解析，Release APK 的远端登录、相机上传、通知和家庭同步未验收。真实药盒照片识别准确率仍为 `NOT_RUN`；OCR 解析和确认界面的自动化回归已通过。

## 修复内容

- `MedicineTextParser` 补充“凝胶”剂型，并把药名候选截到剂型词末尾，避免同一行英文标签或 OCR 尾字符污染药名。识别仍只产生待核对草稿，不推断库存数量或个人剂量。
- 识别核对页将“产品规格（例如 20g）”与库存数量、库存单位分开；用户从下拉框选择“支、盒、粒、片”等单位，再输入数量。API 与小程序共享的单位契约新增 `tube`（“支”）；数据库增量迁移 `029_tube_quantity_unit.sql` 同步扩展批次、补货、低库存阈值及经确认的盒装换算目标。小程序把新单位追加到列表末尾，保持旧草稿 `unitIndex` 映射不变。
- Flutter 日期滚轮固定 `zh_CN` 本地化，展示中文年月日；选择结果在写入前保持规范 ISO 字符串。仅到月的有效期继续保留月精度。
- Debug manifest 仅为本机 HTTP 测试允许 cleartext；Release 不使用该 Debug 网络设置。

## 验证结果

| 检查 | 结果 | 边界 |
|---|---|---|
| 根仓库 lint、typecheck、npm test | `PASS`；小程序 220/220、API 222 PASS/12 skipped、tooling 6/6 | 不替代真实微信账号验收 |
| 官方小程序 WXML/WXSS | `PASS`，51 个文件 | 编译不证明真机页面交互 |
| PostgreSQL 单位迁移与 API 回归 | `PASS`，12/12；隔离 schema 应用至迁移 029，`tube` 创建/读取和计件整数校验通过 | 使用合成数据 |
| Flutter analyze | `PASS`，无诊断 | — |
| Flutter 识药/单位/日期控件回归 | `PASS`，12/12 | OCR 使用锁定文字样本；不代表真实图片准确率 |
| Flutter 全量测试 | 266 PASS / 9 FAIL | 8 项临时文件安全测试受 Windows symlink 权限 1314 阻断；1 项依赖版本断言仍受 `pubspec.lock` CRLF 匹配影响 |
| Android Release / R8 | `PASS`；Release APK 已生成，AOT 中可查到目标 `API_BASE_URL` | 构建有非阻断 Cupertino 图标字体提示；Release 使用 debug 证书 |
| Android Debug 本机 API | `PASS`；保留数据的 `adb install -r` 首次安装时间未变，合成设备会话成功交换 | API 只在本机回环可达；未使用真实账号 |
| Android 日期滚轮 | `PASS`；真机确认显示中文日期 | 未提交药品或改变原有待核对草稿 |

## APK 与复现信息

- Release APK：`E:\Claude_allow\Download\medcial_box\android-evidence-2026-10-03-release\app-release.apk`，包名 `com.joviluma.home_medicine_flutter`，版本 `1.0.0 (1)`，SHA-256 `38FC6CF9B8ABDC2749CD5315CCB2F63B34E9D9918FBAD7C73127AAE9EB0EF1E4`。构建命令需传 `--dart-define=API_BASE_URL=https://<可达的 HTTPS API 地址>`。
- 本机 Debug APK：`E:\Claude_allow\Download\medcial_box\android-evidence-2026-10-03-debug-api\app-debug-api-local.apk`，SHA-256 `E4A104BB25781E0DDA13A294FD5C554ECA0BBD822B9E657AEA709E330423859F`。本机 QA 使用 `API_BASE_URL=http://127.0.0.1:13300`，连接实体机前需 `adb reverse tcp:13300 tcp:13300`。
- 本次 Release R8 使用的 `apps/flutter/android/app/proguard-rules.pro` 在开始本轮前已存在于工作区且仍未跟踪；它被本机 Gradle 合并加载并与中文识别依赖一起完成构建。发布补丁时需确认将该文件纳入代码审查。

未执行真实微信 OAuth、生产 HTTPS/API、正式签名安装、真实通知或数据库/图片恢复。项目整体继续保持 `PARTIAL`。
