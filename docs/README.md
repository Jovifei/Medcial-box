# 项目文档入口

本文档指向家庭药箱的当前实现说明与操作资料。产品边界和验收状态以仓库代码、当前状态台账和带版本的验证报告为准；旧日期文档保留其原始决策背景。

- [项目 README](../README.md)：模块、当前门槛和常用开发命令。
- [产品需求](product/requirements.md)：首版用户目标和健康信息边界。
- [技术架构与运行边界](architecture/overview.md)：微信小程序、Flutter、API、数据库和重试/提醒/导出责任。
- [MVP 设计历史](architecture/mvp-design-2026-09-24.md)：早期 MVP 的设计依据，不代表当前实现状态。
- [本地开发与数据保护](operations/local-development.md)：本地 API/PostgreSQL、小程序隔离副本和密钥边界。
- [本地微信小程序导入与编译验证](operations/02-RPT-本地微信小程序导入与编译验证.md)：2026-10-03 的 Windows 开发工具结果和 API 连通性限制。
- [Android 实体机安装与启动验证](operations/03-RPT-Android实体机安装与启动验证.md)：2026-10-03 首次数据保留安装与构建尝试的历史记录。
- [Android 识药、库存单位、日期与 Release 验证](operations/04-RPT-Android识药单位日期与Release验证.md)：2026-10-04 本机修复、迁移 029、Release R8 与真机本地 API/中文日期验证。
- [独立测试环境部署](operations/staging-deployment.md)：HTTPS 测试服务、部署前检查与恢复演练。服务器操作需按该文档的外部准备门槛执行。
- [收尾矩阵](../tasks/reports/closeout/2026-10-03-current-closeout-matrix.md)：当前代码门槛和独立真实环境验收。
- [识别服务路线](architecture/recognition-provider-decision-2026-09-27.md)：识别适配器与故障边界。
- [外部接口与开源来源](references/)：来源登记和依赖核查。

自动化通过、容器健康或 IDE 导入仅证明对应层级。真实身份、手机、模板消息、系统分享、正式签名、HTTPS 和恢复演练分别记录，不相互替代。

- [分支合并与手机验证](operations/05-RPT-分支合并与手机验证.md)：2026-10-04 main 整合与当前验证。

- [批次日期、分类与本机AI识别](operations/06-RPT-批次日期分类与本机AI识别.md)：原位修改批次、中文日期复用及4070S实际调用。

- [最新代码与App独立试用](operations/07-RPT-最新代码与App独立试用.md)：已包含8031a2f，不走小程序连接码的本机试用构建。
