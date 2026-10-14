# 当前任务：主线归一与项目清理

Jovi于2026-10-14明确授权功能合并至main及冗余清理；原E目录执行，用户数据/配置/未处理历史保留。完整前序日志已归档到[任务历史](archive/2026-10-14-todo-history.md)。

- [x] 核对PR3/4/5祖先关系、43份dirty文件备份和all-refs.bundle。
- [x] 三项dirty审查；删除闲置用途猜测helper、4份过时fixture，保留有效回归。
- [x] 修正25页导航高亮与对比度，CSS简化及独立源码审查。
- [x] 本机全回归/lint/typecheck/build通过；真实平台和旧受限实验不冒充PASS。
- [x] 统一README、当前状态与本次整合记录，本机运维数据和回执排除Git。
- [ ] 固定精确候选，最终普通CI通过后整合main并同步E原目录。
- [ ] 删除已包含的远端/闲置本地分支；独有历史和脏旧worktree保留。
- [ ] 核main同步/工作树、汇总剩余卡点及Hub报告。

实际固定SHA、主线/PR和最终验证结果见[本次整合记录](../docs/operations/24-RECEIPT-main-consolidation-20261014.md)及对应GitHub回执。工程合并不是生产上线；部署准备/旧额外竞态仍BLOCKED。
