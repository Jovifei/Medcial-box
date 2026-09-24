# 当前阶段状态

- 当前阶段：P0 收口（PARTIAL / BLOCKED_RUNTIME）＋ P1 手动药箱与 Markdown 导出（PASS_CODE_ONLY，B1/B2 完成）＋ P2 家庭共享（PASS_CODE_ONLY / BLOCKED_RUNTIME，B3 代码与合成测试完成，待真实两账号验收）
- 交付顺序：P0 收口 → P1 手动药箱＋Markdown 导出 → P2 家庭共享 → P3 拍照识别 → P4 上线试用（见 `tasks/plans/2026-09-24-mvp-roadmap.md`）
- 完成证据：
  - `npm run lint` PASS（`--max-warnings=0`）。
  - `npm run typecheck` PASS。
  - `npm test` PASS（全仓 83/83：P0 基线 7 + B1 新增 50 + B2 新增 7 + B3 新增 13 + D2/D3 决策落地新增 6；全部为合成注入测试，不依赖真实数据库）。
  - `npm run build` PASS（含小程序 `tsc --noEmit`）。
  - `docker-compose --env-file deploy/.env.example -f deploy/docker-compose.yml config --quiet` PASS（本机未安装 compose 插件，仅独立版 docker-compose v5.4.0）。
  - 无密钥 CI 已就绪：`.github/workflows/ci.yml`（Node 22，npm ci → lint → typecheck → test → build，零 Secrets）。
  - B1 后端核心：`002_core_inventory.sql` 迁移（含仅存令牌哈希的 sessions 表）；微信登录 `WechatGateway` 可注入（测试用假网关，无公开测试登录后门）；Bearer 认证 preHandler；家庭/药品/批次/个人剂量备注 CRUD（PUT 版本不符 409、跨家庭一律 404 不泄露存在性）；有效期纯函数（月末/跨年/年月精度/提前 30 天临期）。
  - B2 导出与小程序：`POST /api/v1/exports/markdown`（四分区、D1 存放位置、D4 归档排除、说明书核验区分、个人剂量权限、Markdown 转义）；小程序统一网络层/登录服务与五个页面（首页、创建家庭、药品录入/编辑、药品详情、批次编辑、导出预览：复制文本与写本地 .md + `wx.shareFileMessage` 回退复制）。小程序仅 typecheck 通过，未做开发者工具编译预览。
  - B3 家庭共享：`003_family_invites.sql`（一次性邀请凭据仅存 sha256、72h、原子消费防复用）；owner 生成邀请码（403 OWNER_ONLY 门槛）、明文接受（404 无效 / 410 过期与已用 / 409 已有家庭）、owner 移除成员（自移除与移除 owner 403；被移除者原令牌后续请求 404 FAMILY_NOT_FOUND 即时失效）；小程序 `pages/invite`（owner 生成/复制、无家庭用户粘贴加入、成员提示）。
- BLOCKED：Docker CLI 使用的 Docker Desktop Linux engine named pipe 未运行；本机没有 PostgreSQL／`psql`；未发现微信开发者工具。
- NOT_RUN：真实 PostgreSQL readiness 与迁移执行、微信开发者工具编译与页面预览、正式 AppID 真实登录、`.md` 真机分享、真实两账号邀请/共享/移除验证（需合法 HTTPS 测试环境，没有实测不标完整 PASS）、外部模型与药品查询 API、生产部署。
- 当前基线：Git 已初始化；B1/B2/B3 轮改动尚未提交（禁止由工程师执行 commit/push，由主理人统一处理）。npm 锁文件已生成，依赖包缓存位于允许的 `E:\Claude_allow\Download\medcial_box\npm-cache`。
- 允许范围：当前本地项目文件、合成数据、本地依赖缓存目录 `E:\Claude_allow\Download\medcial_box`。
- 不包括：真实微信账号、真实用户照片／健康信息、真实线上 API 密钥、生产网站或服务器变更、推送／发布。
- 下一步：QA 全量回归；P0 真实数据库与开发者工具验收、P2 真实两账号共享验收保留 `BLOCKED_RUNTIME`/`NOT_RUN`，待环境可用后补证；随后评估 P3 拍照识别排期。
