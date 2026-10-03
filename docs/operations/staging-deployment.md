# 独立测试环境与手机试用

本流程使用阿里云 ECS `120.55.64.11`、域名 `medbox-test.joviluma.com` 和当前小程序 AppID。服务器地址、SSH 登录用户名和访问域名是不同信息。部署放在药箱独立目录和容器中，访问 API 使用独立 HTTPS 域名。

### 域名解析：改用阿里云 DNS

`joviluma.com` 当前委托的权威 DNS 是 Cloudflare（截图显示 `burt.ns.cloudflare.com` / `leia.ns.cloudflare.com`），因此阿里云 DNS 页面即使已经有记录，公网也仍由 Cloudflare 应答。可以继续用阿里云；无需把 ECS 搬到别处。

截图显示阿里云已存在 7 条 A 记录（`medbox-test`、`etf`、`photo`、`teslalink`、`auth.teslalink`、`api.teslalink`、`@`），目标均为 `120.55.64.11`。切换前请在阿里云解析控制台逐项确认它们仍全部存在且启用；不要删除或修改这些记录。

在阿里云域名控制台打开 `joviluma.com`：域名列表 → **管理** → **DNS管理** → **DNS修改** → **修改DNS服务器**。填写截图中阿里云分配的两台服务器 `dns29.hichina.com`、`dns30.hichina.com`，提交后等待 DNS 状态正常。阿里云官方说明，切换前需先在新 DNS 服务商完整配置旧记录，生效期间递归 DNS 缓存可能保留旧结果最长约 48 小时。[修改 DNS 服务器](https://help.aliyun.com/zh/dns/pubz-modify-dns-server-for-alibaba-cloud-domain-name) [平滑迁移说明](https://help.aliyun.com/zh/dws/support/domain-name-transfer-in-and-transfer-out-related-faq)

切换生效后，在阿里云确认 `medbox-test` 的 A 记录为 `120.55.64.11`，再继续配置 HTTPS。由于 ECS 位于中国大陆，域名通过公网访问还须确认已有适用的 ICP 备案；阿里云说明中国内地服务器上的网站域名需完成备案。[阿里云个人网站备案说明](https://help.aliyun.com/zh/icp-filing/basic-icp-service/getting-started/quick-start-for-icp-filing-for-personal-websites)

## 准备

在本机运行 `npm run setup:staging`。它会自动生成独立数据库密码、从小程序项目读取 AppID，并写入被 Git 忽略的 `deploy/.env.staging`。Jovi 只需在文件中填写 `WECHAT_APP_SECRET`；部署 Compose 会使用其余服务器默认值。Secret 只保留在本地私有配置和受限的服务器配置中，不要放进聊天、Git、小程序包或备份报告。

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

在开发机执行以下命令，使用获批 AppID 和公网 HTTPS API origin。生成目录位于被 Git 忽略的 `.local-data/mini-staging-<UUID>`；源项目的 `touristappid` 与源码配置不会被覆盖。命令行上的 AppID 和域名是公开客户端配置，AppSecret 绝不传给此命令。

```powershell
npm run prepare:mini -- --appid wx0000000000000000 --api-base https://<测试域名>
```

将示例 AppID 换成真实值，在微信开发者工具中打开命令输出的目录，确认项目配置启用域名校验。先验证编译和登录，再用两个真实微信账号及两台手机依次完成：创建家庭、邀请与接受、共同查看和修改、并发版本冲突提示、按批次录入不同有效期、数量未知和零、导出预览、复制、`.md` 分享、默认不含个人剂量及勾选后仅含获授权备注。保存脱敏结果与设备/构建版本；模拟网关、单元测试或开发者工具预览不算真机 PASS。

## 备份与恢复演练

在测试服务器上使用项目脚本。数据库 dump 与说明书图片卷分别备份，备份文件保存在 Git 忽略目录，目录本身应受文件权限保护。图片验收脚本只将归档解压到独立临时目录，不会覆盖现有图片卷。

```bash
bash scripts/staging-backup.sh deploy/.env.staging .local-data/backups
bash scripts/verify-backup.sh /absolute/path/to/medbox-YYYYMMDDTHHMMSSZ-PID.dump
bash scripts/verify-photo-backup.sh /absolute/path/to/medbox-YYYYMMDDTHHMMSSZ-PID.dump.photos.tar.gz
```

检查 `.sha256`、两个验证脚本的退出码和数据库恢复输出中的家庭、药品、批次数量。图片验证会做路径检查并解压到临时目录。正式恢复必须另行制定停写、快照和回滚步骤，再把验证后的图片归档恢复到目标卷；不要把临时目录验证误记为服务器恢复通过。

## 证据边界

本仓库的真实 PostgreSQL 验收只使用一次性隔离容器与临时 schema；本地试用栈和其他项目容器不作为测试目标。Compose 私有图片卷与成对备份脚本已加入代码，但本轮没有对 ECS 执行部署或备份。正式 AppID 对应关系、微信订阅模板与类目、目录授权、HTTPS 和两台手机共享仍须在实际微信账号及设备上验收；未完成前记为 `BLOCKED` 或 `NOT_RUN`。
