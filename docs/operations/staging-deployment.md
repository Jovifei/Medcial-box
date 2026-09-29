# 独立测试环境与手机试用

本流程供拿到测试主机、独立 HTTPS 域名及已获批的小程序 AppID 后执行。仓库中的域名、端口和环境变量均为模板；执行前先只读核对目标主机上的现有站点、证书、反向代理、3301 端口和备份位置。先查询域名的权威 NS，在实际权威 DNS 提供商配置 A 记录并确认公网解析后再申请证书。现有生产站点不属于本流程的写入范围。

## 准备

在目标服务器安装 Docker Engine 和 Compose，确认 Node.js 22、DNS 指向及 HTTPS 证书可用。将代码放在独立目录，并在服务器上创建 `deploy/.env.staging`（参考 `deploy/staging.env.example`，权限 `0600`）。设置独立且至少 20 字符的 `POSTGRES_PASSWORD`、获批的 `WECHAT_APP_ID`、仅供服务端使用的 `WECHAT_APP_SECRET`。不要把该文件、密码或照片放进 Git、聊天记录、备份报告或小程序包。

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
