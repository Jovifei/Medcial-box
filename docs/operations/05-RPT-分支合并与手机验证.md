# 2026-10-04 分支合并与本地验证

本地 main 已整合远端 f5e17e5 和本地未提交修复，功能合并提交 7e4f707。phone-trial-readiness 已是最新开发分支的祖先；不重复合并。不改动另一已有工作树，保留本地快照 1212a41。

冲突处理经 Jovi 确认：中文日期滚轮与远端身份保护/大字体布局并存，R8 使用远端精确规则，文档同时保留远端进展与本机证据。补齐 Release INTERNET 权限，修正窄屏200%字体日期标题溢出，布局测试验证中文滚轮打开/确认。

| 验证 | 结果 |
|---|---|
| lint/typecheck/build | PASS |
| 小程序 | 230 PASS |
| API | 233 PASS，13 可选数据库套件跳过 |
| tooling | 6 PASS |
| 官方 WXML/WXSS | 51 文件 PASS |
| 严格 PostgreSQL | 12 组，151 PASS，0 skipped |
| Flutter analyze | PASS |
| Flutter 全量 | 663 PASS，15 Windows 符号链接能力明确跳过，0 FAIL |
| Release/R8 | PASS，非 debuggable，仍为 debug 证书 |
| 手机安装 | PENDING，USB 恢复后等待 ADB 发现设备 |

Release SHA256：FB9503D2B4986F32255C51F008841DBACE013B9EB6E73A81F0FB3F02CFE24A4C。API_BASE_URL=http://127.0.0.1:13300，ADB 转发至整合源码本机13303 API；使用专用测试数据库和假微信身份，不代表正式部署。迁移文件换行差异已恢复原始字节，未修改数据库迁移校验值。

真实微信、双手机、真实通知、药盒原始照片OCR准确率、正式签名和HTTPS部署未验收。远端 main 未推送。
