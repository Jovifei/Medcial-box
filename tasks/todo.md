# 当前任务：主线归一与项目清理

Jovi于2026-10-14明确授权功能合并至main及冗余清理；原E目录执行，用户数据/配置/未处理历史保留。完整前序日志已归档到[任务历史](archive/2026-10-14-todo-history.md)。

- [x] 核对PR3/4/5祖先关系、43份dirty文件备份和all-refs.bundle。
- [x] 三项dirty审查；删除闲置用途猜测helper、4份过时fixture，保留有效回归。
- [x] 修正25页导航高亮与对比度，CSS简化及独立源码审查。
- [x] 本机全回归/lint/typecheck/build通过；真实平台和旧受限实验不冒充PASS。
- [x] 统一README、当前状态与本次整合记录，本机运维数据和回执排除Git。
- [x] 候选2a4f047的CI38578731818三job全过；PR5合入main ebe3df2，E原目录ff同步。
- [x] 4个远端分支删除，仅保留main；8个已合入本地分支删除，2个独有/脏工作区分支改为archive。
- [x] 已核main同步且工作树无待处理源码；剩余卡点已汇总。最终本轮状态由Hub及GitHub集中回执记录。

实际固定SHA、主线/PR和最终验证结果见[本次整合记录](../docs/operations/24-RECEIPT-main-consolidation-20261014.md)及对应GitHub回执。工程合并不是生产上线；部署准备/旧额外竞态仍BLOCKED。

审核结果：本轮主线归一/确证清理已完成，项目仍PARTIAL；两个现有家庭和私有资料未动。有效回归与历史证据保留。主线合并源代码树与已通过CI的候选完全一致；后续本提交只更新记录。
