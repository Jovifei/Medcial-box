# 手机试用准备：本地验收报告（2026-09-27）

基线 `ad6b31f`；实施分支 `codex/phone-trial-readiness`，独立工作树 `C:\Users\Admin\.codex\worktrees\phone-trial-readiness\medcial_box`。主工作区未改动。此报告只针对本地代码与合成数据，不记录家庭真实药品、账号或凭据。

## 已通过

| 项目 | 状态与证据 |
| --- | --- |
| 导出选项与临时文件 | `node --test apps/api/test/export-preview.test.mjs`：21/21 PASS。覆盖旧请求乱序、选项变化、写文件中变化、原生复制／分享发起后选项锁、onShow、写入失败后的部分文件清理、清理失败提示及下次页面显示重试。微信系统接口仍是模拟回调。 |
| PostgreSQL 集成 | 原生 PostgreSQL 17.11 在独立临时集群运行，`REQUIRE_POSTGRES_TESTS=1` 下 `npm test`：API 124/124、工具 3/3，0 跳过。真实数据库集成子测试 14/14 PASS，包含 001–005 迁移重复运行、CRUD、家庭隔离／私人备注、导出、邀请／owner 约束与竞争、批次与整体保存的双向锁竞争。每轮新建随机 schema，结束只删除自己创建的 schema。 |
| API 冒烟 | 用合成登录网关和真实 PostgreSQL 访问健康检查、药品与两个不同有效期批次、版本更新和 Markdown 导出。默认导出排除私人剂量。首次断言把 Markdown 对下划线的正确转义误判为失败；修正断言后重跑 PASS，未改业务代码。 |
| 备份恢复 | 对合成数据库执行原生 `pg_dump -Fc`，还原至独立新数据库，再启动 API 指向还原库读取同一药品 ID／version 2／两批次；`ready` PASS。恢复计数为 medicines 1、batches 2、notes 1、migrations 5。备份文件本地 SHA-256：`9712FED891BEB70214FAC209D233F0EA1198F5F7C79C76AB9D4F5D2751788831`。此证明不等于容器版 shell 脚本实跑。 |
| 静态检查 | `npm run lint`、`npm run typecheck`、`npm run build` PASS；测试环境 Compose 在合成变量下 `config --quiet` PASS；备份与恢复 shell 脚本通过 `bash -n`。 |
| 独立源码复核 | 复核导出、父行锁、隔离数据库测试、CI 必跑配置、部署模板及备份脚本；指出原生动作与临时文件清理边界，修复并重新测试后无剩余阻断性源码问题。复核者未独立运行服务。 |

测试用 PostgreSQL Windows 二进制版本 17.11，存放在允许下载目录 `E:\Claude_allow\Download\medcial_box\postgresql-17.11-3`；下载包本地 SHA-256 为 `4B8DB0930C38F6EF845DB919551DEDDA3B6B845AEB0927B3D79A6E8E9E4537CF`。此值是本地计算，未声称与发布方公布的校验值比对。数据库集群及 dump 均为合成数据。首次在本轮最终复跑时遇到 `ECONNREFUSED`，原因是先前临时 PostgreSQL 已停止；重新启动同一临时集群后，严格模式全套测试通过。连接失败不计为通过。

## 已备但未运行的门槛

- **远端 CI：NOT_RUN。** `.github/workflows/ci.yml` 已使用 PostgreSQL 17 服务与 `REQUIRE_POSTGRES_TESTS=1`；未提交／推送，未产生远端流水线结果。
- **Docker 容器与脚本：NOT_RUN。** 本机 Docker Desktop Linux 引擎启动时因其本机 `sailor-ingest.sock` 清理失败而退出。仅检查了 Compose 解析与 shell 语法，没有修改 Docker 配置、代理或生产服务。原生 PostgreSQL 的 dump/restore 不能代替 `scripts/staging-backup.sh`、`scripts/verify-backup.sh` 的容器演练。
- **测试服务器与 HTTPS：BLOCKED_INPUT。** 已取得 ECS 公网 IP `120.55.64.11`、小程序 AppID 和候选测试域名 `medbox-test.joviluma.com`。用户截图显示该 A 记录在阿里云 DNS 页面，但域名权威 NS 为 Cloudflare；本机向 `1.1.1.1` 与 `8.8.8.8` 查询时该名称均未解析。因此需在权威 Cloudflare zone 确认/添加该记录。SSH 用户和密钥入口、网站备案状态、证书路径及服务端 AppSecret 仍未确认。没有连接或修改服务器、DNS 或现有网站。
- **微信开发者工具与两账号真机：NOT_RUN。** 小程序 TypeScript 与页面逻辑已验证，尚未证明实际微信登录、合法域名、分享 `.md`、复制、家庭共享与设备端行为。
- **P3 拍照识别与私有照片备份：NOT_STARTED。** 目前的数据库恢复不包含未来图片能力。

## 下一次执行

取得 SSH 连接方式并在权威 DNS 完成可解析的测试记录后，按 `docs/operations/staging-deployment.md` 先只读核查主机、端口、备案、证书和代理；随后部署独立测试栈，执行容器备份恢复，并用两台手机完成完整家庭流程，逐项登记 `PASS / BLOCKED / NOT_RUN`。微信管理员本人应在后台完成扫码授权，AppSecret 只写入服务器环境配置。本轮源码仍是未提交工作树，未发布。
