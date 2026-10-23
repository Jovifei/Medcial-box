# 主线合并与 1.0.6 服务升级回执

日期：2026-10-23。此次在 `E:\project\medcial_box` 原仓库执行，业务源码固定为 `10f284ba6a70659cf2af954466be7fee1126fb1a`；`VERSION.json` 仍为 `1.0.6 / candidate`，Android build 8。本文只记录实测，微信小程序与 Android 均未正式发布。

## 源码与审核

- 远端功能分支的新增提交已接收；`main` 从 `db787841bc1b6f39e7fd5f65d4068cdfaa6b3e27` 快进到 `10f284b` 并推送 GitHub，无冲突或历史重写。
- 修复审查发现的四类问题：资料详情缺失时的药名错配、任意追溯码内部数字误当商品条码、原图超限先于压缩以及模型通道新源码与安装校验哈希不一致。当前 20 位无明确 GS1 结构的追溯码保留原文、提示人工核对，不推断或联网查询内部商品码。
- 本机 `lint`、`typecheck`、`build` 通过；小程序 505 PASS，API 290 PASS / 18 SKIP，工具链 138 PASS / 25 SKIP。跳过项维持原平台/资源边界，不算通过。固定源码的功能分支 CI [39881132949](https://github.com/Jovifei/Medcial-box/actions/runs/39881132949) 与主线同 SHA CI [39882501460](https://github.com/Jovifei/Medcial-box/actions/runs/39882501460) 均已完成，`verify`、`backup-docker`、`flutter` 三项全部成功。

## 备份与部署

- 线上原 API 镜像 `sha256:1693ee595a324672c97887a67c3e1c206b89aa2ed9cb7d984782ea626cbb8d3f` 已保留。新镜像独立标签 `medbox-api:1.0.6-10f284b`，服务器镜像 ID `sha256:ee135598ca5189a571818559d8240b998740036b8c6c112a42250d24e42c3bfe`；本机源码归档、镜像构建及传输包分别记录摘要，传输包 SHA256 为 `4cf0e3e14a720493f08dc23d664cd5be54c7f1fb3b2146345167774663b38b71`，云端校验一致。
- 现役 Compose 容器属于项目 `medbox-staging`；文件默认 `name` 与其不同。所有检查和切换均显式带 `-p medbox-staging`、现役 `runtime/compose.yaml`、`runtime/compose.gpu.yaml` 及受限 `config/runtime.env`。新配置 dry-run 只重建 API；原 DB 卷 `medbox-staging_medbox_database`、私照卷 `medbox-staging_medbox_private_uploads` 未改名或重建。
- 停止现役 API 后从现役 DB 与只读私照卷取得同点备份；云端和 E 盘副本哈希一致：数据库 dump `de1db11cd39848e1f217f1af71ee56356bef4c580a2485017bf94bf14f4860d7`，照片归档 `025a88b89adb6140fa46ff77ddf091e6f7f7fa8da32f602708ff5f53ef0ef4e6`。照片归档仅有空目录，与当时数据库 0 照片记录一致。独立断网、内存盘 PostgreSQL 恢复成功，得到 36 迁移、2 家庭、2 用户、2 成员、0 药品/批次/照片、5 邀请、9 会话；家庭稳定 ID 摘要与停写生产库一致。临时数据库已销毁，原备份保留。
- 仅将现役 Compose 的 API 镜像标签改为新独立标签，保留原文件副本。新 API 容器运行 `healthy`，公网 `/api/v1/health/ready` 返回数据库已连接；切换后上述表计数及家庭 ID 摘要仍与备份一致，DB/私照卷身份保持。服务器原镜像仍可定位；不作自动数据库降级或清数据回退。
- 从新 API 容器经原私有桥接向本机显卡模型提交确定性合成药盒图，返回“甲乙丙合成片”、`requiresConfirmation=true`。该图 SHA256 为 `344435dfe5b68466c57fde4d3a2f06d6b4fd261c32d76b12874d222eadb173dd`；未使用真实用户照片或令牌。模型列表与这次合成推理通过，不等于手机实拍识别准确率。

## 剩余发布门槛

- 已生成当前源码的隔离 HTTPS 小程序候选，包门禁通过（130 个打包文件）；源码工程仍禁止直接上传。微信开发者工具 `codex` 授权任务仍待用户在工具内确认，官方模拟器编译、体验版上传、iPhone 双家庭/拍照/扫码/保存重开均 **NOT_RUN**。
- `JISU_MEDICINE_API_KEY` 已在服务端配置（仅核存在），资料提供者为 `composite`；没有本轮真实商品码外部命中证明。无匹配时必须保留码值和人工录入路径。
- 本机显卡私有通道当前运行、API 可完成合成推理；既有计划任务安装清单仍写旧源码哈希，而现装运行文件已是新哈希。更新后的仓库安装器可校验新源码，但**不能据此宣称现有计划任务已完成受控升级**；运行中通道未被停止或重装。需另定旧安装身份到新版的维护路径并在重启后验收。
- Android 正式签名及手机保数据覆盖安装未验；微信平台体验、审核与正式发布分列，不因 API 部署或 CI 通过而标记上线。

## 审查结论

API 镜像切换、同点备份的隔离恢复、所列计数与家庭稳定 ID 摘要、服务健康和合成模型链路 **PASS**。这不等于所有业务表内容均做过逐行比对或真机业务验收。微信小程序 **CANDIDATE / PLATFORM_AUTH_PENDING / REAL_DEVICE_NOT_RUN**；Android **UNSIGNED_RELEASE / DEVICE_NOT_RUN**。两个既有家庭仍在，所列数据与备份一致；微信开发者工具授权结果仍待取得，不把待运行项写成 PASS。
