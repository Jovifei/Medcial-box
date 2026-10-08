# JF小药箱独立交付审计

审计日期：2026-10-08。仓库：Jovifei/Medcial-box。审计冻结提交：`f675416ced73b59144c1f3d327dcdc741608a84e`。

## 1. 本轮结论

**允许进入隔离环境、使用合成资料的受控测试；不批准当前候选直接用于真实家庭数据验收或正式发布。**

主要理由不是“还可以再优化界面”，而是本轮发现了一条明确的前后端契约错误：只保存低库存提醒，会把没有发送的批次当作空集合同步，触发原有批次的软删除，同时清空条码与标签。识别相关测试也需要补充真实图片、真实模型、真实微信与响应丢失恢复证据。

本报告的结论范围是本轮已读取的关键执行路径，不是“所有文件逐行审计后无其他缺陷”。没有访问实际生产服务器、微信后台、测试手机或本机未提交修改。没有在本轮运行完整仓库测试，不能把下面的代码推导称为数据库实测。

## 2. 历史、源码与证据的边界

提供的分享页内容过大，未能完整展开。已经结合可检索历史、用户重述的问题、当前仓库文档和精确SHA源码继续审计；没有声称完整读完全部分享页。GitHub源码可以读取；本机Codex工作区连接失败，因此本地未提交代码和实际安装包不能由GitHub推断。

当前精确候选的GitHub Actions运行 `37787635027` 有 `verify`、`flutter`、`backup-docker` 三个成功检查。此事实证明这次配置下的自动门禁执行成功，不证明真实模型识别准确率、微信身份、实际通知送达或上线配置已验收。可在仓库Actions中按精确SHA追溯。

仓库[2026-10-08整合记录](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/tasks/reports/2026-10-08-branch-consolidation.md)还记录：此前 `fe7d1ef` 本地验证小程序389通过，API256通过/14跳过，工具86通过/24跳过。**这些是该记录里的本地结果，不是本轮独立重跑数，也不应当硬套成最新CI各测试数量。** 没有PostgreSQL的本地结果不能替代真实数据库集成测试。

## 3. 项目最终目标

项目不是一个只展示药品卡片的原型，而是可长期维护真实家庭资料的药箱系统：微信原生小程序与Flutter Android共享Fastify API、PostgreSQL和私有照片。用户拍药盒或说明书、扫描商品码、手动补全资料，经人工核对后记录药品和批次；管理数量、单位、包装/开封期限和存放位置；支持家庭、照护权限、计划提醒、库存待办、导出与备份恢复。范围见当前[README](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/README.md)、[小程序入口](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/apps/miniprogram/app.json)与[后端路由注册](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/apps/api/src/app.ts)。

交付标准应是：数据不会因普通操作丢失，未知不冒充已知，识别不是未经确认的事实；同家庭可协作、不同身份严格隔离；失败与恢复可解释；真实平台和真实设备可运行。药品资料整理不等于诊断、处方或个体用药建议。

## 4. 已核对的识别执行链路

### 微信小程序

`medicine-edit.onRecognizePhoto()` → `wx.chooseMedia()` → 校验实际文件大小、读取base64和JPEG/PNG头 → `writeOwnedPhotoFile()`登记并持久化本机照片草稿 → `ensureLoggedIn()` → `api.recognizeMedicine()` → `POST /api/v1/recognitions/medicine` → 家庭校验、base64/大小/图片外壳校验 → DashScope或Ollama适配器 → `cleanDraft()`字段清洗和日期精度处理 → 返回`draft + warnings + requiresConfirmation` → 当前身份/请求代次/字段版本校验 → 仅填未被用户修改的空字段 → 用户核对并点击保存。

识别入口和回填实现见[medicine-edit.ts](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/apps/miniprogram/pages/medicine-edit/medicine-edit.ts#L1150-L1368)，客户端请求见[api.ts](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/apps/miniprogram/services/api.ts#L227-L287)，后端见[recognitions.ts](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/apps/api/src/routes/recognitions.ts)及[medicine-recognition.ts](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/apps/api/src/services/medicine-recognition.ts)。

这里存在两个不同的“上传”：**识别时图片已经发送到后端/所配置模型；保存药品之后才另行上传到家庭私有照片存储。** 不能把“不写私照存储”说成“从未发送图片”。识别接口本身不依赖药品写库逻辑。

### 保存与私照链路

点击保存 → 校验药名/批次 → 固定创建意图与幂等键 → 药品及初始批次同事务提交 → 收到药品ID → 逐张调用私照上传接口 → 保存照片ID → 设置正面封面 → 持久化队列回执 → 清理本机草稿 → 回到列表。药品已存但图失败时保留`photo_pending`，重试不应再创建药品。见[保存代码](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/apps/miniprogram/pages/medicine-edit/medicine-edit.ts#L1720-L1888)和[药品事务/创建回执](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/apps/api/src/routes/medicines.ts)。

### Android差异

Android拍照后可选择仅本机ML Kit或服务端AI；服务端同样调用识别API，本机则走中文文字识别与`MedicineTextParser`。两条路径不能互相替代验收。见[Android选择分支](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/apps/flutter/lib/features/medicine/medicine_entry_api_page.dart#L548-L680)与[识别仓库](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/apps/flutter/lib/data/medicine_recognition.dart)。Android字段承接与多图持久性还需按本矩阵验证，不能由Flutter编译通过推导。

### 当前代码参数，不等于运行环境实值

| 项目 | 源码值/行为 | 验证注意 |
|---|---|---|
| 识别图片 | JPEG/PNG，128字节至4MiB；HTTP body 6MiB | 4MiB指解码后的图片字节；Base64和JSON会增加传输体积 |
| 私照上传 | 单图8MiB；HTTP body 12MiB | 与识别限制不同；需经过真实HTTPS代理 |
| 私照配额 | 每家庭100张、64MiB；单用户10次/分钟 | 并发、预留、清理和失败重试都影响配额 |
| 小程序识别请求 | 总超时60秒 | 必须包含上传、排队、模型和回传时间 |
| DashScope适配器 | 请求超时25秒 | 当前部署是否启用此provider未知 |
| Ollama适配器 | 请求超时55秒；默认model qwen3.5:0.8b | 默认值不是实际安装/可用模型证明；60秒客户端预算可能较紧 |
| 结果 | requiresConfirmation=true；字段/标签清洗；日期保留精度 | 这些是规则，不能代替真实准确率评估 |

参数依据为上面识别源码及[私照路由](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/apps/api/src/routes/leaflet-photos.ts)。

## 5. 本轮独立发现

### AUD-01 / P0：保存低库存提醒导致活动批次被软删除，条码/标签被清空

**证据级别：完整静态调用链已核对；真实PG复现待本地执行。**

1. 前端[onSaveThreshold](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/apps/miniprogram/pages/medicine-detail/medicine-detail.ts#L539-L586)给`updateMedicine`传药名、规格、厂家、成分、说明书、阈值和version，**不传batches、barcodeValue、populationTags、purposeTags**。
2. [API包装](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/apps/miniprogram/services/api.ts#L394-L407)原样发送PUT，没有补齐遗漏字段。
3. [parseMedicine/validateMedicineUpdateInput](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/apps/api/src/inputs.ts#L414-L511)将缺省batches转为空数组，条码转null，两个标签转空数组。
4. [PUT同步](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/apps/api/src/routes/medicines.ts#L129-L215)对未进入keptIds的所有旧批次执行deleteBatch。
5. [deleteBatch的实际SQL](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/apps/api/src/repositories/batches.ts#L305-L323)是UPDATE deleted_at等字段，即**软删除**，不是物理DELETE。其上方物理删除注释已与实现不符。
6. [药品UPDATE SQL](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/apps/api/src/repositories/medicines.ts#L184-L242)将缺省后的条码/标签写回。brand有单独provided保护，不应误报为一并清空。

用户影响：正常修改提醒即可使原批次从有效库存消失，资料丢失，而页面仍可能显示“库存提醒已保存”。不能交给真实家庭直接试。

修复约束：优先定义独立阈值更新接口或一致的局部更新契约；若保留完整替换PUT，必须让调用方明确携带完整集合并拒绝危险缺省。不能简单删掉批次删除能力、去掉version或让测试接受丢失。先执行REG-01~04的红色回归，修复经授权后再验证。

### AUD-02 / P1风险：私照缺少上传意图幂等，回包丢失可能重复保存

**证据级别：静态实现缺口；响应丢失故障实测待执行。**

[私照POST](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/apps/api/src/routes/leaflet-photos.ts#L210-L352)每次生成randomUUID，未见按上传请求键/内容身份复用回执的分支；客户端仅在收到响应后持有uploadedId。服务端已激活图片但客户端没收到201、或回执未落盘即崩溃，再次上传可能产生重复照片与配额损耗。不能拿“药品创建有幂等键”证明图片也幂等。

执行REG-05/06和PHOTO-09/10，验证每次原始意图最终只有一张逻辑照片。修复时应在家庭/药品/用途/批次权限范围内设计上传意图回执，不能跨家庭用全局图片hash泄露关联。

### AUD-03 / P1可操作性缺口：模型失败信息在小程序被压平

后端识别服务有9类原因及不同建议，而[前端catch](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/apps/miniprogram/pages/medicine-edit/medicine-edit.ts#L1330-L1375)遇到RECOGNITION_UNAVAILABLE统一写“拍照识别暂不可用，请先填写药品名称保存”。这使模型没启动、显存不足、超时和图片解码失败对用户难以区分。日志诊断和用户安全可操作信息应贯通，但不要暴露密钥/服务器细节。执行REG-07。

### AUD-04 / 待验证：多批次与双端字段承接

本轮读到的拍照入口把照片batchIndex设置为0，并按第一批次回填；不能假定编辑第二批次照片也正确关联。Android识别结果对象没有承接后端所有字段（例如approvalNumber、lotNumber），需按实际入口/产品承诺确定是缺失功能还是未承诺字段。列入REG-08/OCR-16，不在没有对应真机入口证据时断言所有多批次操作都坏。

## 6. 为什么自动化通过还不等于真实识别通过

已读到的[recognitions.test.mjs](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/apps/api/test/recognitions.test.mjs)使用合成图片外壳、FakeWechatGateway、fake pool以及注入的fetch/识别返回。其价值是验证路由、错误处理、请求参数和清洗规则；**并不是实际拍一盒药、连接真正模型、量出真实识别准确率**。因此必须补充独立金标准真实图片、模型固定版本、真机和真实PG证据。

这里不能反向推论整个仓库没有任何真实测试；只能说这些自动化证据不能替代本次要求的真实端到端验收。

## 7. 发布门槛与当前卡点

| 层级 | 本轮判断 |
|---|---|
| 当前代码/CI状态 | 精确候选CI检查成功，但静态发现AUD-01，不能据CI放行 |
| 隔离合成测试 | 可以立即开始；优先复现数据丢失，禁止连接真实家庭资料 |
| 真实微信体验测试 | AUD-01关闭并具备真实AppID/HTTPS/授权后，使用独立测试家庭执行 |
| 微信正式发布 | 未满足：阻断缺陷、真实身份/图像/双端同步、模板实际送达、平台配置/隐私核对、恢复演练 |
| Android正式分发 | 另需正式签名、覆盖升级和真机通知；不应把Android签名缺失误当微信专属要求 |

生成微信副本与发布门禁依据为[prepare-miniprogram.mjs](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/scripts/prepare-miniprogram.mjs)和[check-miniprogram-package.mjs](https://github.com/Jovifei/Medcial-box/blob/f675416ced73b59144c1f3d327dcdc741608a84e/scripts/check-miniprogram-package.mjs)。脚本只能检查AppID形状、包内容、静态HTTPS配置等，不能证明后台已配置合法域名、真实证书可达、账号资质或审核已批准。不能关闭urlCheck或放松门禁凑通过。

仓库整合报告保留了历史私照误推后续处置未完成的说明。没有在本轮下载这些私照，也不能声称删除远端引用就消除了历史对象。应单独核对授权处置记录，不再把敏感图片带入新的审计附件。

## 8. 是否需要用户现在提供截图

检查源代码调用链不依赖截图，当前不需要为了开始审计而补图。后续真机验收需要的是绑定候选SHA的证据：拍照入口、系统授权、识别中、结果核对、人工修改、保存、照片待补、重启恢复、另一账号可见/不可见、通知实际到达。单张“保存成功”截图无法证明数据一致；关键场景保留短录像及脱敏请求/数据库对照。原始私照不进Git、不公开分享。
