# JF小药箱双端最新构建与测试入口

2026-10-04，产品代码5d973b6，包含远端最新开发8031a2f。本轮实际使用微信开发者工具2.02.2609231 RC打开隔离项目并通过官方自动化连接读取已编译页面，不再只把wcc/wcsc结果作为IDE通过。没有上传发布正式版本。

## 现在如何测试

1. App：手机桌面打开“JF小药箱”，版本1.0.1(2)，直接进入本机试用家庭；不经过一次性连接码。电脑本机API13306与Ollama、USB/ADB tcp13300转发需保持可用。
2. 小程序：电脑微信开发者工具选择“JF小药箱-本机试用”，目录 `E:\project\medcial_box\.local-data\mini-local-cda8c9b0-e996-4d2c-8b89-f230f43dbef8`。点击“使用微信登录”进入已经创建的“JF小药箱小程序试用家庭”，随后可录入药品、改批次、选择日期、筛选和测试识别。API13307，使用独立开发身份，不与App正式连接。
3. 小程序不是APK安装包。电脑模拟器测试和手机微信预览是不同入口；当前本机loopback地址不能保证微信手机预览可连接。手机预览需另行确认账号权限和手机可访问的API，正式微信、双手机与HTTPS部署仍未验收。参考[腾讯官方调试/预览参考](https://github.com/TencentCloudBase/skills/blob/main/skills/miniprogram-development/references/devtools-debug-preview.md)。

## 名称与Logo

App系统名称、App首页标题、小程序导航标题/登录页/项目名称已同步“JF小药箱”。AppID和Android包名不变。提供的download.png原图复制为Android drawable和小程序登录Logo，不重新绘制；APK内图标1254×1254，RGBA像素与原图完全一致。源版本已固定1.0.1+2，后续默认构建保持一致。微信后台名称是Jovi已修改的平台信息，本轮仅同步源码显示。

## 本轮验证

| 范围 | 结果 |
|---|---|
| lint/typecheck | PASS |
| Node回归 | 小程序230/API234/tooling18 PASS；API13可选PG套件/工具23平台测试明确跳过 |
| Flutter analyze/完整回归 | PASS；674 PASS，15Windows能力跳过，0FAIL |
| 官方WXML/WXSS | 51文件PASS |
| 开发者工具实际编译 | CLI auto成功，SDK读取pages/login/login，原生窗口显示JF名称与Logo |
| 小程序模拟器测试登录 | PASS：mock wx.login+真实本机API，进入family-entry；不是微信真实换码 |
| 小程序测试家庭创建 | 输入/提交后SDK等待超时；随后本机API读取确认正确家庭已创建并持久化 |
| 后续SDK连接 | 部分请求超时；未据此声称完整界面流程通过 |
| App Release/R8/安装 | PASS；install -r，1.0.1(2)，首次安装时间2026-09-27保留，实际页面JF名称可见 |

小程序模拟器保留在新项目中，旧miniprogram窗口未删除；请按项目名称选择。测试服务器使用开发网关和专用测试数据库，非真实微信身份。

App APK SHA256：94a1241cdc909a997468d94c47d26a0b677e36519229fc09b30885b34685eb52，仍为debug证书，非debuggable，不代表正式签名发布。
