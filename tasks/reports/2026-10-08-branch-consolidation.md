# 2026-10-08 分支收口与清理

基线 origin/main de74a585dc77ac7f113d6473901f19d5cb606f87。

旧 final-delivery-2026-10-04、final-delivery-2026-10-07-review、flutter-ui-prototype、phone-trial-readiness 已是 main 祖先。delivery-audit 四项旧提交以及本地十一项历史的功能已在最新 main 集成或被更完整的身份、日期、成分确认、照片保护实现替代；不重新引入旧版本号或删除现有回归。当前用户允许保留新 main 实现，只整理有效增量。

post-merge-delivery-stage-2026-10-07 的九文件工具增量已合入隔离分支。初次验证 3 PASS / 2 FAIL：生命周期测试仍读取旧检查名，升级测试仍读取旧 JSON 字段。修复协议并增加注释假阳性和未实现真实模式拒绝验证；删除无实际迁移的 JSON 写回示例，明确 SOURCE_ONLY、STATIC_SYNTAX、NOT_RUN/NOT_PROVEN，不视为设备验收。

旧模拟器 14 张过程截图删除，历史文字记录保留。正式 Logo、字体许可、测试夹具、迁移、必要负例与审计账本保留。新增忽略 var 与 Flutter 工具状态。原目录的照片、数据库、配置、备份和本地提交不删除。

误推的 local-delivery-handoff-20261008 分支已按用户授权删除；新整合历史从最新 main 出发，不合入旧分支内 var 私照历史。删除远端引用不能保证 GitHub 历史对象清除，彻底移除尚需 GitHub 侧处理。

真实微信、双账号双手机、通知送达、正式签名、HTTPS 和生产数据库+照片恢复仍是独立门槛。合并与自动化通过不能替代。

## 本次验证

fe7d1ef357d043f050f5abce38bd4238dd2d0b32 冻结后 npm build/lint/typecheck 通过；npm test：小程序389 PASS，API256 PASS/14 SKIPPED（未配置 PostgreSQL），tooling86 PASS/24 SKIPPED（原有环境门槛）。随后仅纠正一条升级脚本注释与历史审计合并身份；小程序子树始终为17dbc684f86008de4e387b40a36097606907d9ef，Flutter源码与原main完全一致，没有重构或重新安装。

小程序 source 包检查通过，622618字节/124文件。直接对源码运行 release 门禁被正确拒绝（源码并非独立HTTPS发布包），不把source通过称为release验收。

独立代理仅只读复审，7项新增工具测试通过，确认删除范围为历史截图、运行代码/品牌资源/已有隐私测试保留。指出的一条升级检查注释已修正。

旧delivery-audit分支使用保留最新主线的合并策略登记祖先；四项旧变更已有更新实现，未拿旧树覆盖主线。原本地分支b18e985保留、不并入main（其旧历史含var私照）；新交付记录按文件选择复制。
