# 当前阶段状态

- 当前阶段：P0 项目规划与可运行骨架
- 状态：PARTIAL / BLOCKED_RUNTIME
- 目标：完成产品／架构／参考资料文档、微信小程序前端骨架及可运行的 API＋PostgreSQL 开发环境。
- 完成证据：`npm run lint` PASS；`npm run typecheck` PASS；`npm test` PASS（7 tests，2026-09-24 新增 3 项迁移排序测试）；`npm run build` PASS；`docker-compose --env-file deploy/.env.example -f deploy/docker-compose.yml config --quiet` PASS（本机未安装 compose 插件，仅独立版 docker-compose v5.4.0）。健康路由在合成数据库依赖下通过 localhost HTTP 验证。
- BLOCKED：Docker CLI 使用的 Docker Desktop Linux engine named pipe 未运行；本机没有 PostgreSQL／`psql`；未发现微信开发者工具。
- NOT_RUN：真实 PostgreSQL readiness、微信开发者工具预览、正式 AppID 登录、外部模型与药品查询 API、生产部署。
- 当前基线：`E:\project\medcial_box` 初始骨架创建于空目录；Git 已于 2026-09-24 初始化（main 分支），首个提交 `5c3adf2` 已推送远端 `https://github.com/Jovifei/Medcial-box.git` 并经 `ls-remote` 验证。npm 锁文件已生成，依赖包缓存位于允许的 `E:\Claude_allow\Download\medcial_box\npm-cache`。
- 允许范围：当前本地项目文件、合成数据、本地依赖缓存目录 `E:\Claude_allow\Download\medcial_box`。
- 不包括：真实微信账号、真实用户照片／健康信息、真实线上 API 密钥、生产网站或服务器变更、推送／发布。
- 下一步：Docker Desktop Linux 引擎恢复后执行 `docker-compose --env-file .env -f deploy/docker-compose.yml up --build` 并请求两个健康接口；同时通过微信开发者工具打开 `apps/miniprogram/`（`touristappid` 即可本地预览，无需等账号获批）。这两项完成后验收 P0 并启动 P1。
