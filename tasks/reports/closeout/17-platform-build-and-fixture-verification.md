# 平台编译与宿主测试验证 · 2026-10-03

分支 `codex/flutter-ui-prototype`；最终代码 `f5e17e581df865b2fedf247d00fba1a5a6036981`，源码树 `d567d0d6de02039d40ae352e363fea78aa5215b6`。本轮关闭复现的R8编译失败与测试宿主假设，**仍不等于正式发布、原生识别或家庭试用验收通过**。

## 原始证据与最小修改

精确C2代码 `6ec8d7a` 在Windows隔离worktree的结果：官方WeChat编译25WXML+26WXSS通过，Flutter analyze无问题；完整测试639通过、21失败；debug构建通过但API为空、未安装；release在R8报缺类。

- R8缺少三个未选脚本的Options及Builder共六类：Devanagari、Japanese、Korean。锁定的google_mlkit_text_recognition0.17.1归档SHA-256与pubspec.lock一致；这些模型在插件中为compileOnly，应用仅选择Chinese1，已有Chinese16.0.1运行时依赖。`083f961`仅增加六条精确类名的dontwarn和生产中文脚本通道契约测试，不加通配符、额外模型，不禁用优化/压缩，不改签名或版本。Flutter已有默认规则与本地proguard-rules.pro接线，未另改Gradle。CI新增正常 `flutter build apk --release` 技术门禁。
- 五个失败来自同一文件的Windows路径分隔符表示不同，改为完整绝对URI的规范比较；一个失败来自CRLF使锁文件包节正则无法匹配，规范换行后同时验证LF/CRLF，原依赖版本断言保留。
- 十五个安全场景在创建符号链接fixture时得到Windows errno1314。`f5e17e5`仅在Windows实际文件/目录链接能力探针返回该错误时明确SKIPPED并写明NOT RUN；其他系统或其他错误仍失败。不修改系统权限、不无条件跳过Windows。原安全断言保留；普通文件、孤立临时文件、缺失/非目录路径及插件/导入文件的保留另有四个独立、始终运行的场景。

## 精确提交结果

| 来源 | 实际结果 |
|---|---|
| [083f961 CI37136225113](https://github.com/Jovifei/Medcial-box/actions/runs/37136225113) | verify、analyze、661项Flutter、debug及优化release APK构建PASS |
| [f5e17e5 CI37136392579](https://github.com/Jovifei/Medcial-box/actions/runs/37136392579) | verify、analyze、671项Linux Flutter、debug及优化release APK构建PASS |
| Linux安全覆盖 | 解码CI日志逐项确认十五个原符号链接安全场景和四个独立非链接保留场景实际PASS；未把Windows能力跳过传播到Linux |
| Windows本机精确f5e17e5 | 离线pub get后锁文件不变；analyze0诊断；656 PASS / 0 FAIL / 15 SKIPPED，逐项原因是errno1314；不得称本机全部671通过 |
| Windows构建 | Flutter3.47.5 / Dart3.13.4 / JDK17.0.19；debug和release退出0，有实际R8映射和资源压缩证据；合并规则只有所述六条精确类，无Chinese/Latin或通配抑制、无dontoptimize/dontshrink |

本机技术release APK SHA-256：`858b7b2e3f7dd6807e5c7ded605db607e5ab8baa341c49167bd3cc4e3e97a60e`。它仍使用Android Debug签名且API_BASE_URL为空，**未安装，不是可连接家庭服务的正式候选**。没有由这些构建结果推导真实相机或原生中文OCR已运行。

## 避免错误修复

1. 实际合并release清单已有INTERNET，来源transport-backend-cct2.3.3；不能仅因main清单没直接写而认定release缺权限，本轮没有添加权限。
2. Flutter appVersion与小程序APP_VERSION按源码明确策略保持一致，均为0.2.0-s0s1r1；pubspec1.0.0+1是另一个原生包版本维度。分别记录，不擅自改号或安装新版本插件。
3. Windows创建链接能力不足只说明这些fixture分支在该宿主不能执行，不证明产品的链接防护逻辑通过或失败。完整安全覆盖仍来自实际运行这些用例的Linux结果，设备行为另验。

## 连接与交付前提

当前未建立已批准且可工作的公共HTTPS API证据。部署runbook明确把仓库域名/端口当模板；历史报告中的medbox-test.joviluma.com当时为BLOCKED_INPUT。后续只读探测受执行环境代理502影响，没有拿到目标响应或证书，不能据此断言该服务离线或DNS仍未配置。

最小外部输入是：用于此次手机试用的公共HTTPS API地址，以及不含密钥的后端提交/镜像和迁移执行到028的记录（包含d1fa41f的库存绑定编辑契约）。`/api/v1/health/ready`只做SELECT1，即使成功也不能单独证明部署代码/迁移兼容性。不要用示例地址或空配置安装APK，不需要在聊天提供凭据。

本轮未部署、未创建凭据、未变更Windows权限、未安装或清空设备。正式签名、原生中文OCR/相机/输入法、WeChat JS/页面、真实账号/通知及数据库＋图片恢复仍按 [当前矩阵](2026-10-03-current-closeout-matrix.md) 验收。
