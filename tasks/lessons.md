# 实施经验记录

本文件仅在项目实施中出现明确纠错或反复验证后追加经验。

## 2026-09-23／24

- Windows 上 npm 首次下载 Biome 原生二进制（约 76 MB）不可靠：lint 链路改用 TypeScript ESLint 加 JSON 语法检查，并从依赖中移除 Biome（详见 tasks/plans/2026-09-23-p0-project-bootstrap.md）。
- 本机 Docker CLI 29.7.2 未安装 `docker compose` 插件，只有独立版 `docker-compose` v5.4.0：文档、验收证据与脚本统一使用 `docker-compose`，避免"照 README 抄命令即失败"。
- 连接池环境下 `pool.query("BEGIN") … pool.query("COMMIT")` 不构成事务：每条语句可能落在不同连接，部分写入不会回滚。多步写入必须走 `Database.withTransaction`（绑定单个 PoolClient）；合成假池的 withTransaction 同步包裹脚本执行并记录 BEGIN/…/COMMIT 顺序，真实并发场景由 `integration-pg.test.mjs`（设 `TEST_DATABASE_URL` 自动执行）覆盖。
- 迁移执行入口必须唯一：Postgres `/docker-entrypoint-initdb.d` 只跑 SQL 不登记 `schema_migrations`，与迁移器并用会导致二次建表失败。容器化部署只让 API 迁移器跑迁移。
- 涉及"父记录 + 子记录"的并发：子记录端点必须递增父记录聚合版本（批次增/改/删 → 药品 version + 1），否则旧页面的整体保存会绕过乐观锁静默覆盖/删除他人新增的子记录。
- 单 owner 这类"恰好一个"不变量，唯一索引只能保证"最多一个"——转让/退出/移除必须共用同一把家庭行锁并在事务内复核角色，删除/降级语句要带角色条件。
- 业务"今天"绝不能取 UTC 日期部件：家庭时区固定 Asia/Shanghai（`zonedDateParts`），否则中国时区凌晨 0–8 点之间到期日会整体偏移一天。
- 异步界面：开关/筛选变化后，旧请求的响应必须作废（请求序号 + 选项快照比对），复制/分享等动作前按当前选项重新生成，防止"看到的与拿到的"不一致。
