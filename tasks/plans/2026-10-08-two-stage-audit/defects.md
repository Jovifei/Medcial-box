# 初始缺陷账本

本轮仅独立静态审查与局部契约复现，未实施业务修复。

## AUD-01 库存提醒保存丢失非目标字段（P0候选）

状态：CONTRACT_FAIL；PG_REPRODUCTION_NOT_RUN。仅阻止相关真实数据路径，不否定其他独立测试。

来源B:REG-01/02。页面apps/miniprogram/pages/medicine-detail/medicine-detail.ts约562行仅发送阈值/基础资料，省略batches/barcodeValue/populationTags/purposeTags；api.ts原样PUT。API inputs.ts约439-469将缺省解析为空批次/null条码/空标签；routes/medicines.ts183-185将所有未保留批次软删除，repositories/medicines.ts195/199清空资料。brand有单独provided保护，不能假定其他字段一样。

在隔离f675416重新构建API后，经审阅的附件B探针实际执行页面方法+生产validator：开启、关闭均被校验器接受，但两批次ID、条码及两个标签集合保留断言全部失败；退出1。没连接PG、没有真正删除批次、没操作设备，不能声称已证明数据库丢失或全链路FAIL。

下一步：在全新专用PG合成家庭建立两有效批次、一已软删除批次及条码/标签；执行真实路由，前后对比数量、id、deleted_at、版本、条码/标签；开关/并发/回滚分别验。原threshold单测使用空批次mock fixture不能覆盖此风险。取得源端修复提交后保持相同断言，冻结新HEAD、全量回归并独立复审。

## 待复现的独立源码风险（不是已执行FAIL）

| ID | 范围/路径 | 下一步 |
|---|---|---|
| A-F01 | medicine-edit.wxml告知“未保存仅本机”与识别上传用途 | 采集/识别/保存网络步骤及实际声明对照 |
| A-F02 | medicine-edit.ts分类错误回包被通用提示覆盖 | 真实页面注入已分类后端错误，核按钮/提示/重试 |
| A-F03/04 | medicine-recognition.ts图片像素及上游response.text/json读取预算 | 合成极端尺寸/小字节图，受控大响应/断流/timeout，provider调用与内存证据 |
| A-F05 | server.ts关闭hook缺生产信号触发 | 独占Linux入口SIGTERM与真实PG清理、Windows强杀另列 |
| A-F06 | start-local-trials固定库/端口/mode复用 | 先隔离驱动，绝不直接占用Owner服务；身份/持续就绪证据 |
| A-F07 | app.ts body限制错误可能413变500 | 真Fastify超6MiB请求，正确4xx且provider零调用 |
| LOCAL-SDK-01 | check-miniprogram-compile固定source先release门禁 | 官方编译改为隔离候选可用调用路径；未经授权不改业务/门禁 |

所有待复现项保留SOURCE_FINDING/PENDING，不能预填PASS，也不把附件推论当数据库/设备事实。
