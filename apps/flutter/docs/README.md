# Flutter 客户端专用文档（Android）

`apps/flutter/` 当前为 Android 客户端（Flutter）。iOS 已定为原生独立路线，见 [apps/ios/docs](../../ios/docs/README.md)；Flutter 代码不再承担 iOS 目标。产品需求、总体架构与双端混合记录见仓库根 [docs/](../../../docs/README.md)。

## 现行文档

（暂无；Android 专用 SOP 在下一开发阶段建立，如正式签名、保数据安装与构建号递增规范。）

## 归档（仅对应其日期与提交）

- [03 Android 实体机安装与启动验证](archive/03-RPT-Android实体机安装与启动验证.md)
- [04 Android 识药、库存单位、日期与 Release 验证](archive/04-RPT-Android识药单位日期与Release验证.md)
- [07 最新代码与 App 独立试用](archive/07-RPT-最新代码与App独立试用.md)
- [13 App 对齐与本机资料库验收](archive/13-RPT-App对齐与本机资料库验收.md)

## 划分约定

- 本目录只放 Android/Flutter 端专用内容：签名与 keystore、构建号递增、真机安装与 ADB、Flutter 引擎/插件环境坑位。
- 涉及 API 部署、双端对照或发布准入的回执仍记入根 `docs/operations/`，不在本目录复制。
- iOS 相关新文档一律放 `apps/ios/docs/`，不放本目录。
