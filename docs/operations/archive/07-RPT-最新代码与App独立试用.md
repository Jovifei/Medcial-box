# 2026-10-04 最新远端代码与 App 独立本机试用

代码提交 `7a62351`。编译前及提交后均重新fetch；本地main包含远端最新开发分支`8031a2f`，phone-trial-readiness也是祖先。远端main当前cb4f670；本次代码没有自动推送。最新源点新增备份维护窗口、平台验证文档及Docker备份恢复CI测试，均已合入，不以旧分支替代。

## 独立试用

本次APK显式启用LOCAL_APP_TRIAL=true，API_BASE_URL=http://127.0.0.1:13300。仅本地HTTP loopback可用，必须先验证开发服务器的试用标识；随后沿用正常令牌持久化和服务端用户/家庭验证，不生成或确认小程序连接码。普通构建开关默认false，远端地址拒绝该入口，生产API没有试用标识。

客户端与连接流程共用接受凭据的方法；识别核对页也改为复用MedicineDateField，删除重复日期弹层/显示代码。已有批次新增、编辑、开封/截止日期仍共用中文日期选择器和批次表单。

## 验证

- lint/typecheck PASS；小程序230、API234、tooling18 PASS。API13个可选PG套件跳过；Windows工具测试23项Linux平台跳过，不记为PASS。
- 新增备份脚本24项契约测试在现有node:22-bookworm-slim容器PASS，无端口、无生产数据库访问；真正Docker备份恢复脚本限定GitHub-hosted CI，未伪造环境在本机执行。
- Flutter analyze PASS；完整674 PASS，15符号链接能力测试明确跳过，0失败。试用/原连接/日期核对聚焦9 PASS。
- Release/R8 PASS，使用debug证书，非debuggable；APK SHA256 DC99A5042141903F3B01CA41663FC146539A5CC24E17FEDE3A9547F64F857D45。
- OnePlus GM1910 install -r成功，首次安装时间2026-09-27保持。实际启动直接进入“本机联调测试家庭”，读取原测试库存，首页显示成人/儿童与用途筛选；未出现一次性连接码。

本机API13306经ADB13300转发，假微信网关、专用测试数据库及本机Ollama；电脑/服务/ADB转发需保持可用。测试药品数据真实写入专用测试库，不是纯静态页面。正式微信账号、双手机共享、真实通知、正式签名及HTTPS部署仍未验收；小程序按Jovi安排后续测试。
