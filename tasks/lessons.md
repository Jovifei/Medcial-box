# 实施经验记录

本文件仅在项目实施中出现明确纠错或反复验证后追加经验。

## 2026-09-23／24

- Windows 上 npm 首次下载 Biome 原生二进制（约 76 MB）不可靠：lint 链路改用 TypeScript ESLint 加 JSON 语法检查，并从依赖中移除 Biome（详见 tasks/plans/2026-09-23-p0-project-bootstrap.md）。
- 本机 Docker CLI 29.7.2 未安装 `docker compose` 插件，只有独立版 `docker-compose` v5.4.0：文档、验收证据与脚本统一使用 `docker-compose`，避免"照 README 抄命令即失败"。
- 连接池环境下 `pool.query("BEGIN") … pool.query("COMMIT")` 不构成事务：每条语句可能落在不同连接，部分写入不会回滚。多步写入必须走 `Database.withTransaction`（绑定单个 PoolClient）；合成假池的 withTransaction 同步包裹脚本执行并记录 BEGIN/…/COMMIT 顺序，真实并发场景由 `integration-pg.test.mjs`（设 `TEST_DATABASE_URL` 自动执行）覆盖。
- 业务"今天"绝不能取 UTC 日期部件：家庭时区固定 Asia/Shanghai（`zonedDateParts`），否则中国时区凌晨 0–8 点之间到期日会整体偏移一天。
