# 2026-10-08 分支收口与清理

基线 origin/main de74a585dc77ac7f113d6473901f19d5cb606f87。

旧 final-delivery-2026-10-04、final-delivery-2026-10-07-review、flutter-ui-prototype、phone-trial-readiness 已是 main 祖先。delivery-audit 四项旧提交以及本地十一项历史的功能已在最新 main 集成或被更完整的身份、日期、成分确认、照片保护实现替代；不重新引入旧版本号或删除现有回归。当前用户允许保留新 main 实现，只整理有效增量。

post-merge-delivery-stage-2026-10-07 的九文件工具增量已合入隔离分支。初次验证 3 PASS / 2 FAIL：生命周期测试仍读取旧检查名，升级测试仍读取旧 JSON 字段。修复协议并增加注释假阳性和未实现真实模式拒绝验证；删除无实际迁移的 JSON 写回示例，明确 SOURCE_ONLY、STATIC_SYNTAX、NOT_RUN/NOT_PROVEN，不视为设备验收。

旧模拟器 14 张过程截图删除，历史文字记录保留。正式 Logo、字体许可、测试夹具、迁移、必要负例与审计账本保留。新增忽略 var 与 Flutter 工具状态。原目录的照片、数据库、配置、备份和本地提交不删除。

误推的 local-delivery-handoff-20261008 分支已按用户授权删除；新整合历史从最新 main 出发，不合入旧分支内 var 私照历史。删除远端引用不能保证 GitHub 历史对象清除，彻底移除尚需 GitHub 侧处理。

真实微信、双账号双手机、通知送达、正式签名、HTTPS 和生产数据库+照片恢复仍是独立门槛。合并与自动化通过不能替代。
