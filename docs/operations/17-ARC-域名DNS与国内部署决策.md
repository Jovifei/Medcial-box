# 域名 DNS 与国内部署决策

更新：2026-10-11。Jovi已授权统一到阿里云DNS，但必须先完整盘点备份且不能影响其他项目；授权药箱解析、独立部署及真机测试，不等于合并main或正式发布客户端。

## 结论

药箱面向中国用户，使用 Jovi 自有阿里云服务器和 `joviluma.com`。Cloudflare不是小程序或ECS的必要依赖。Jovi已审核依赖冲突，选择药箱子域先交阿里云、主域暂留Cloudflare；medbox子域委派及A记录已生效，整站迁移未执行。其他项目原有连接保留。

服务器负责运行 API、数据库和文件存储；权威 DNS 负责告诉访问者域名对应的地址；HTTPS 负责连接加密与服务器身份校验。三个配置分别验收，DNS 生效不等于 API 或登录可用。

## 决策与状态

| 事项 | 状态 | 依据与执行边界 |
| --- | --- | --- |
| 用户范围 | 已明确 | Jovi于2026-10-11说明只面向中国用户。 |
| 服务器与域名 | 已明确 | Jovi确认使用自有阿里云服务器和joviluma.com。 |
| 药箱子域名 | 正式名称候选 | medbox.joviluma.com；当前双方表中未占用。名称正式化不等于产品正式发布，保留medbox-test历史配置。 |
| 国内路线 | 已选择 | 阿里云DNS＋阿里云服务器；配置尚未完成。 |
| 整站DNS迁移 | 已授权、冲突待审核 | 12条C2C Tunnel仍依赖Cloudflare代理；不能简单复制CNAME到阿里云后切换NS。 |
| Cloudflare当前角色 | 实际权威DNS | 当前NS为burt.ns.cloudflare.com与leia.ns.cloudflare.com；不能因国内路线建议忽略这个事实。 |
| Cloudflare代理／CDN | 未选为药箱必要依赖 | DNS托管不等于启用代理；本轮没有开启、关闭或更改代理。 |
| App独立试用 | 沿用已有决定 | 不操作一次性连接码，不将本次部署视作App与小程序配对授权。 |
| 业务修复分工 | 沿用已有决定 | 远端ChatGPT修业务代码并提交PR；本地仅接收、编译、独立验证和回传；main合并与发布仍需Jovi决定。 |

## 本轮实查与历史

- `staging-deployment.md`已存在“改用阿里云DNS”方案；旧截图曾显示阿里云有medbox-test等A记录。截图只证明旧控制台填写，不能证明公网已经委托给阿里云。
- 2026-10-11使用Google公共DNS查询接口核对：joviluma.com的NS仍为上述Cloudflare服务器；主域名A记录为120.55.64.11；medbox-test.joviluma.com查询返回Status=3（NXDOMAIN）。这是时间点快照，执行前重新核对。
- Windows本机解析得到198.18.0.36，属于本地网络映射线索，不能作为公网服务器地址或单独证明公共DNS故障。
- 本机HTTPS握手失败，尚未取得有效HTTP响应。公共记录缺失已构成接入阻塞；服务器证书、API部署、SSH方式尚未核实，不能把所有TLS失败归结为服务端证书。
- 本轮没有修改DNS、NS、VPN、代理、服务器、配对码或安装包。

## Cloudflare DNS与代理的区别

DNS-only记录返回源站地址，HTTP/HTTPS可直达阿里云源站；Proxied记录让Cloudflare参与业务流量转发。仅看到Cloudflare的NS，不能断言药品图片或API请求经过国外代理，也不能证明业务数据存储位置。应分别检查DNS记录的代理状态、API端点、模型提供者和存储配置。

若保留现有NS，记录必须在当前权威Cloudflare配置才能生效。若迁到阿里云，则在新DNS完整配置全部现有记录后，在域名注册商处更换为该域名实际分配的阿里云NS。不能只在阿里云添加A记录而保留Cloudflare权威NS，也不能把历史截图里的NS地址当作当前分配值。

## 后续执行门槛

1. 确认SSH入口和服务器身份，只读检查已有服务、端口、证书和药箱部署目录；密钥与AppSecret不进入文档、聊天或Git。
2. 选择“保留当前权威DNS，仅补药箱记录”或“整站迁到阿里云”；后一种先导出完整A/AAAA/CNAME/MX/TXT等记录，盘点DNSSEC及其他项目的代理、隧道依赖。旧文档列出的7条A记录不是完整清单。
3. 形成可审核的新旧记录、域名实际NS、验证步骤和回滚方案；Jovi确认后才切换，不触碰其他项目运行服务。
4. 独立部署精确验收候选，配置源站HTTPS，验证公网解析、TLS和API就绪，再配置微信合法域名并生成指定API的客户端测试包。
5. 微信登录、相机、双账号、通知、模型质量及升级数据保留分别验收；解析／健康200／构建通过不能替代真实验收。

## 2026-10-11完整记录盘点与备份

已登录双方控制台，只读核对：Cloudflare列表显示18/18，6条A（主域名、etf、photo、teslalink、auth.teslalink、api.teslalink）全部DNS-only，12条CNAME为Proxied Tunnel。逐项展开12条记录读取真实UUID.cfargotunnel.com目标，未点击Save。阿里云显示7/7 A，除上述6条外多一条medbox-test；默认线路、TTL600秒、均启用，但NS未接入。当前分配NS确认为dns29.hichina.com与dns30.hichina.com。

完整记录字段已备份到本机E:\Claude_allow\Download\medcial_box\dns-migration-20261011：cloudflare-records.json（SHA256 6b96174648be3046e36a65b094506eb10fdda4163e2e4d9b5e4f3f774fc9b15f）、aliyun-records.json（SHA256 ff26a375cfaf88d5902b1bf07780df19828b2afb55faf64b92b94172660dbd67）。这是带代理属性的结构化UI备份，不冒称官方BIND导出；完整快照留本地，不将账号信息或连接凭据提交Git。

Cloudflare DNSSEC页面显示Enable DNSSEC、Multi-signer与Multi-provider均关闭；公共DS查询无记录。本轮没有启用/关闭DNSSEC。列表未见MX/TXT/AAAA/CAA，不主动添加与药箱无关的记录。

12个受保护连接：c2c、c2c-ai-photography-director-app、c2c-ai-photography-director-app-t8、c2c-app-mimo、c2c-etf-fund-analysis、c2c-jovi-automation、c2c-medcial-box、c2c-nightly-photo-intelligence-pip、c2c-npi-real20-recovery-20260930、c2c-openclaw-videofactory、c2c-star-photo-addr、c2c-tesla-speed。

待Jovi审核两条路线：先保留主域Cloudflare权威DNS，将medbox子域委派给阿里云，优先交付药箱且不影响现有连接；或先独立迁移12个连接器的域名/传输接入，逐项验证后再整站切换阿里云。后者涉及其他项目，未获具体方案确认前不实施。Cloudflare当前为Free，第三方DNS下继续使用其代理的Partial/CNAME方案仅Business/Enterprise可用，不能假设免费复制记录就能保持原功能。

Jovi已选择：先将medbox子域委派阿里云，主域暂保留Cloudflare，优先药箱部署；12个C2C连接保持原状。整站迁移推迟，不再重复询问该选择。

执行状态：经Jovi当场确认，新增临时alidnscheck TXT，公共查询可读，阿里云所有权验证成功；阿里云已创建medbox.joviluma.com独立子域，实际分配ns1.alidns.com、ns2.alidns.com（不同于主域历史dns29/dns30，不能混用）。子域新增@ A→120.55.64.11、TTL600秒且启用；父域委派也已执行，见下面最终核对。主域NS未改，原18条记录完整保留。

父域委派最终已获Jovi确认并执行：新增medbox NS→ns1.alidns.com及ns2.alidns.com。公共查询返回子域NS为阿里云、子域A为120.55.64.11；主域NS仍为Cloudflare。对原18条记录逐项核对名称、值显示、代理状态与TTL，18/18未变。最新控制台22条（原18＋本轮TXT及两条NS＋并发新增c2c-ai-short-vidio-claw），并发记录未由本Agent创建、未修改，已补入本地after-delegation备份。其他11个容器的名称、镜像和端口清单核对未变。域名解析已完成，不代表HTTPS/API已部署或真机通过。

## 服务器连接诊断

已从控制台找到杭州实例120.55.64.11，Alibaba Cloud Linux3、2核2GiB、系统盘40GiB。阿里云网页账号登录与实例SSH登录是两层认证。

Workbench默认ecs-user临时密钥认证报USER_NOT_FOUND；用已有SSH只读getent复核该用户不存在，不能照提示擅自useradd。root失败的实际原因尚未确证，不能用通用提示断言root被禁用。实际存在的etfdeploy经本机SSH别名aliyun-etf正常认证；其Workbench临时密钥仍失败，但诊断仅给DISK_VAR_USAGE_HIGH与DISK_ALIYUN_ASSIST_USAGE_HIGH警告，两项均92%，并非已证明的登录根因。

同一/dev/vda3文件系统40G、已用35G、可用3.2G；可用内存约703MiB。后续镜像构建及新增数据库必须考虑磁盘与内存预算，不能清理其他项目容器、镜像、卷或日志。11个现有ETF/逐星/JourVolt/数据库容器与Nginx80/443保持运行。

etfdeploy没有无需密码执行nginx测试的权限；SSH配置文件也不可读，未绕过权限、开启root登录、重置密码或上传私钥。接入药箱HTTPS仍需合法管理员操作；本机只准备了新域名Nginx配置供审核，未安装、未启动药箱服务器、未读取用户真实Secret。

## 来源

- [Cloudflare：Partial setup适用套餐](https://developers.cloudflare.com/dns/zone-setups/partial-setup/)
- [阿里云：子域委派管理](https://help.aliyun.com/zh/dns/pubz-subdomain-management/)

- [阿里云：修改域名DNS服务器地址](https://help.aliyun.com/zh/dns/pubz-modify-dns-server/)
- [阿里云：解析记录常见问题](https://help.aliyun.com/zh/dns/pubz-faq-related-to-domain-name-resolution-resolution-records)
- [Cloudflare：DNS与代理状态](https://developers.cloudflare.com/dns/proxy-status/)
- [历史部署方案](staging-deployment.md)、[2026-09-27手机试用准备](../../tasks/reports/2026-09-27-phone-trial-readiness.md)。
