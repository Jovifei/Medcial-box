# 独立测试环境与手机试用

本流程使用阿里云 ECS `120.55.64.11`、域名 `medbox-test.joviluma.com` 和当前小程序 AppID。服务器地址、SSH 登录用户名和访问域名是不同信息。部署放在药箱独立目录和容器中，访问 API 使用独立 HTTPS 域名。

### 域名解析：改用阿里云 DNS

`joviluma.com` 当前委托的权威 DNS 是 Cloudflare（截图显示 `burt.ns.cloudflare.com` / `leia.ns.cloudflare.com`），因此阿里云 DNS 页面即使已经有记录，公网也仍由 Cloudflare 应答。可以继续用阿里云；无需把 ECS 搬到别处。

截图显示阿里云已存在 7 条 A 记录（`medbox-test`、`etf`、`photo`、`teslalink`、`auth.teslalink`、`api.teslalink`、`@`），目标均为 `120.55.64.11`。切换前请在阿里云解析控制台逐项确认它们仍全部存在且启用；不要删除或修改这些记录。

在阿里云域名控制台打开 `joviluma.com`：域名列表 → **管理** → **DNS管理** → **DNS修改** → **修改DNS服务器**。填写截图中阿里云分配的两台服务器 `dns29.hichina.com`、`dns30.hichina.com`，提交后等待 DNS 状态正常。阿里云官方说明，切换前需先在新 DNS 服务商完整配置旧记录，生效期间递归 DNS 缓存可能保留旧结果最长约 48 小时。[修改 DNS 服务器](https://help.aliyun.com/zh/dns/pubz-modify-dns-server-for-alibaba-cloud-domain-name) [平滑迁移说明](https://help.aliyun.com/zh/dws/support/domain-name-transfer-in-and-transfer-out-related-faq)

切换生效后，在阿里云确认 `medbox-test` 的 A 记录为 `120.55.64.11`，再继续配置 HTTPS。由于 ECS 位于中国大陆，域名通过公网访问还须确认已有适用的 ICP 备案；阿里云说明中国内地服务器上的网站域名需完成备案。[阿里云个人网站备案说明](https://help.aliyun.com/zh/icp-filing/basic-icp-service/getting-started/quick-start-for-icp-filing-for-personal-websites)

## 准备

在本机运行 `npm run setup:staging`。它会自动生成独立数据库密码、从小程序项目读取 AppID，并写入被 Git 忽略的 `deploy/.env.staging`。要让**核心登录/家庭/库存链路**启动，至少还需在私有文件中填写 `WECHAT_APP_SECRET`。照片识别不是默认“已配置”：使用 DashScope 时需注入 `DASHSCOPE_API_KEY`，使用宿主 Ollama 时需显式改 `MEDICINE_RECOGNITION_PROVIDER=ollama` 并验证容器可达；微信主动提醒也必须配置已获批模板 ID / field map 后再启用 scheduler。未配置这些可选能力时应保留手工录入/待处理降级，并在验收报告中记为 NOT_CONFIGURED，而不是把 API health 通过记成识别/提醒 PASS。Secret 只保留在本地私有配置和受限的服务器配置中，不要放进聊天、Git、小程序包或备份报告。

在目标服务器把配置保存为 `deploy/.env.staging` 并设为仅管理员可读（`chmod 600`）。

```bash
chmod 600 deploy/.env.staging
npm run check:staging -- --env-file deploy/.env.staging
docker compose --env-file deploy/.env.staging -f deploy/docker-compose.staging.yml config --quiet
docker compose --env-file deploy/.env.staging -f deploy/docker-compose.staging.yml up -d --build
curl --fail --silent http://127.0.0.1:3301/api/v1/health/ready
```

若服务器只提供独立版 `docker-compose`，将上面的 `docker compose` 换成 `docker-compose`。Compose 使用 `medbox-staging` 独立项目、独立数据库卷和回环 API 端口；不会改动现有站点。`ready` 必须返回数据库就绪，不以进程运行或 HTTP 存活代替。未确认端口空闲时不要启动。

`deploy/nginx.staging.conf.example` 仅作反向代理参考。填入实际测试域名、证书路径和已核对的回环端口后，先执行 `nginx -t`，再按主机现有运维流程加载配置。通过 `https://<测试域名>/api/v1/health/ready` 验证外部 TLS 与 API；微信小程序管理后台的 request 合法域名应为该 HTTPS 域名。域名或证书未就绪时，不用“关闭域名校验”代替真机验收。

## 生成开发者工具项目与验收

在开发机执行以下命令，使用获批 AppID 和公网 HTTPS API origin。生成目录位于被 Git 忽略的 `.local-data/mini-staging-<UUID>`；源码工程本身标记为“源码-禁止上传”，其本机 API 配置不会被覆盖。命令行上的 AppID 和域名是公开客户端配置，AppSecret 绝不传给此命令。

```powershell
$miniProject = node scripts/prepare-miniprogram.mjs --appid wx0000000000000000 --api-base https://<测试域名>
npm run check:miniprogram:package -- $miniProject
```

第二条是正式包门禁：只有生成副本、公开 HTTPS API origin、非 QA / 非本机试用 / 非源码工程且包体规则通过时才返回 PASS。不要直接上传 `apps/miniprogram` 源码目录；CI 对源码只运行 `check:miniprogram:source` 做卫生与包体预算检查。

将示例 AppID 换成真实值，在微信开发者工具中打开 `$miniProject`，确认项目配置启用域名校验。先验证编译和登录，再用两个真实微信账号及两台手机依次完成：创建家庭、邀请与接受、共同查看和修改、并发版本冲突提示、按批次录入不同有效期、数量未知和零、导出预览、复制、`.md` 分享、默认不含个人剂量及勾选后仅含获授权备注。保存脱敏结果与设备/构建版本；模拟网关、单元测试或开发者工具预览不算真机 PASS。

## 备份与恢复演练

在Linux测试服务器上使用项目脚本，需要Bash及GNU coreutils（包括支持 `--no-clobber --no-target-directory` 的 `mv`、`mktemp`、`sha256sum`）。数据库 dump 与说明书图片卷必须在同一个独占停写窗口采集；在线先导出数据库、再打包图片可能在删除竞争中产生“元数据仍在但图片已缺失”的备份。

执行前按获准运维流程记录 API 原运行状态，停止本药箱 API（同时停止同进程提醒/图片清理 job），并暂停其他可能修改数据库或图片卷的任务、外部写入者和自动重启/更新操作。保持数据库运行，保持这个独占窗口直到脚本结束。停止 API 会影响请求与后台任务，需在维护窗口执行；备份脚本本身不会停启任何服务，不接受仅靠环境变量声称已经停写。失败或中断后先检查原因、保留既有备份，再由运维仅恢复维护前正在运行的服务和任务；原本已停止的服务保持停止。

脚本要求唯一现存 API 容器已停止、私有图片目录来自命名卷，并在采集前、数据库采集后和图片采集后复核容器/镜像/卷身份及卷使用者。发现运行、暂停、重启、身份变化或未知状态就失败，不发布备份。图片使用该容器的已有镜像 ID，禁止拉取，启动无网络、只读根文件系统与只读图片卷的临时 tar 读取器；不启动 Compose 依赖或 API 入口，不传服务器环境。镜像或容器不存在时先排查，不由备份脚本重建。

这些状态检查可以发现观察到的重启，并不能锁住 Docker 或主机：两次检查间的启动后又停止、直接写数据库/卷、其他 Docker daemon/主机写入均必须由独占运维窗口排除。发现无法排除的写入者时停止备份，不把检查通过当作并发环境中的原子快照保证。

成功结果位于 `.local-data/backups/medbox-时间-PID/`，内含 `database.dump`、`photos.tar.gz`、`SHA256SUMS`。两次采集和摘要生成都成功后，才用同一文件系统的一次目录重命名发布整组；目标已存在时不覆盖。失败/SIGINT/SIGTERM仅清理本次创建的未发布临时文件，保留原备份和其他文件。强制终止或断电可能留下隐藏临时目录，应保留并另行核对，不能视为成功备份；此流程不声称断电持久性。目录/文件默认0700/0600，禁止将数据库或照片加入Git或报告。

```bash
bash scripts/staging-backup.sh deploy/.env.staging .local-data/backups
bash scripts/verify-backup.sh /absolute/path/to/medbox-YYYYMMDDTHHMMSSZ-PID/database.dump
bash scripts/verify-photo-backup.sh /absolute/path/to/medbox-YYYYMMDDTHHMMSSZ-PID/photos.tar.gz
(cd /absolute/path/to/medbox-YYYYMMDDTHHMMSSZ-PID && sha256sum -c SHA256SUMS)
```

检查 `SHA256SUMS`、两个验证脚本的退出码和数据库恢复输出中的家庭、药品、批次数量。图片验证会做路径检查并解压到独立临时目录，不会覆盖现有图片卷。旧格式的 `.dump`、`.dump.photos.tar.gz` 和 `.sha256` 仍保留，验证脚本仍接受旧文件路径，但不能从历史成功输出推断当时存在停写窗口。正式恢复必须另行制定停写、快照和回滚步骤，再把验证后的图片归档恢复到目标卷；逐条核对活动图片关联、授权下载和权限，不能只看计数或把临时目录验证误记为服务器恢复通过。

## 证据边界

本仓库的真实 PostgreSQL 验收只使用一次性隔离容器与临时 schema；本地试用栈和其他项目容器不作为测试目标。Compose 私有图片卷与成对备份脚本已加入代码，但本轮没有对 ECS 执行部署或备份。正式 AppID 对应关系、微信订阅模板与类目、目录授权、HTTPS 和两台手机共享仍须在实际微信账号及设备上验收；未完成前记为 `BLOCKED` 或 `NOT_RUN`。
