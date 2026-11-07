# 1.0.5+7 电脑候选验收

本文件随候选源码提交。固定SHA、最终CI、包摘要及网页最终复审结果以本批外部回执与GitHub集中说明为准；不拿早前提交或中间APK当完成。

## 已执行证据

- 小程序452PASS；API279PASS/17资源SKIP；工具113PASS/24平台SKIP；lint/typecheck/build通过。API新增有界负载只接受独占TEST_DATABASE_URL，当前本机Docker服务未运行，实际PG结果须核该SHA的普通CI。
- Flutter子Agent全量725PASS/15平台SKIP，无失败；analyze无问题。新临时图片测试验证持久reserved先于copy、无ACK不copy/不上传、ready确认、冷导入丢ACK同键恢复、未完整照不上传、完整补拍可上传且保留未完草稿，以及旧legacy显式导入/按id删除。此前3项旧自动恢复测试预期已依Owner新要求改为显式导入，并保留数据保全断言。
- 原生能力未扩展，照片归属helper未改；独立阅读者批准mini精确树`45e9cc2880ecc4fc9ed28d1774c256aab77a9824`。登记仅该树，未知wx/fs能力仍拒绝。
- 精确miniQA首次6条照片时序夹具仍按自动恢复访问旧草稿而失败；仅在重新开页后补显式onRestoreDraft操作，原来的晚到写入、删除、归属及文件字节断言完整保留。修正后本机38PASS/1平台SKIP，无失败。原3ba2fcb不是最终CI结论；替代提交只改夹具/回执，mini/Flutter业务子树不变。
- 生成独立HTTPS小程序工程，包检查和官方wcc/wcsc共57文件通过；最终树生成物及miniQA另外冻结回执。没有上传到微信，没有关闭域名校验。
- Android Release/Debug技术构建通过，实际包名com.joviluma.home_medicine_flutter、版本1.0.5/code7。Release未签名，因此安装准入FAIL；Debug验签通过，但原生badging明确application-debuggable，仅用于只读Android35模拟器，不供手机正式更新。通用验包脚本的debuggable字段对Windows换行误报false，已由直接aapt2输出纠正，不据此放行。

## 今日范围与暂停点

Jovi已拔出手机，明确今天只电脑测试和准备包，明天本人真机测试。原有两家庭、草稿、私照及配置未清理；旧APK另存，未卸载/清数据/降级手机。

不能宣称上线：真实条码库尚无AppKey（见27号指引）；手机相机到API的失败仍待最新版本实测；模型私有连接复发断连，持续在线未证实；线上API仍旧1867792，原保数据部署准备自动审批拒绝未解除；正式签名/同证书覆盖安装待具备条件。旧额外status/confirm撤权竞态维持BLOCKED。

本地机器证据目录：`E:\Claude_allow\Download\medcial_box\pre-release-1.0.5-20261014`（目录延续本次跨日执行，非版本日期）。仅脱敏源码/合成证据可交远端，手机照片与私有日志不提交。Hub连接拒绝的pending摘要保留在该目录，不自动重试。
