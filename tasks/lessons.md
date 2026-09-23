# 实施经验记录

本文件仅在项目实施中出现明确纠错或反复验证后追加经验。

## 2026-09-23／24

- Windows 上 npm 首次下载 Biome 原生二进制（约 76 MB）不可靠：lint 链路改用 TypeScript ESLint 加 JSON 语法检查，并从依赖中移除 Biome（详见 tasks/plans/2026-09-23-p0-project-bootstrap.md）。
- 本机 Docker CLI 29.7.2 未安装 `docker compose` 插件，只有独立版 `docker-compose` v5.4.0：文档、验收证据与脚本统一使用 `docker-compose`，避免"照 README 抄命令即失败"。
