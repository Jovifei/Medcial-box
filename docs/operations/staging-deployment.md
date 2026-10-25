# 独立测试环境与手机试用

本流程使用阿里云 ECS `120.55.64.11`、域名 `medbox-test.joviluma.com` 和当前小程序 AppID。服务器地址、SSH 登录用户名和访问域名是不同信息。部署放在药箱独立目录和容器中，访问 API 使用独立 HTTPS 域名。

### 域名解析：阿里云迁移历史方案（尚未生效）

**2026-10-11核对：公共NS仍是Cloudflare，medbox-test公共查询返回NXDOMAIN；以下是历史迁移方案，不是已执行状态，也不是立即切换整站DNS的指令。** 当前决策、国内部署解释和迁移边界见[域名DNS与国内部署决策](17-ARC-域名DNS与国内部署决策.md)。执行前完整盘点所有项目的解析记录并确认具体方案；历史截图中的7条A记录与NS分配值不能替代当前控制台核对。

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
```

既有环境更新使用下节受控入口，需要 Node.js 22+、Docker Compose v2、Bash 与 GNU coreutils。`deploy/docker-compose.staging.yml` 的普通命名卷可在项目名改变时创建另一套空卷，不能直接执行不带已核项目身份的 `compose up --build`；48 号回执记录过这一误切。新建环境的首次建库需单独批准的初始化方案，本节不自动创建新 DB 或卷。`ready` 的数据库就绪不能证明是原家庭所在的实例、卷或源码。

`deploy/nginx.staging.conf.example` 仅作反向代理参考。填入实际测试域名、证书路径和已核对的回环端口后，先执行 `nginx -t`，再按主机现有运维流程加载配置。通过 `https://<测试域名>/api/v1/health/ready` 验证外部 TLS 与 API；微信小程序管理后台的 request 合法域名应为该 HTTPS 域名。域名或证书未就绪时，不用“关闭域名校验”代替真机验收。

## 既有部署身份门禁（2026-10-25）

本轮完成代码、合成回归和 CI 接入；**真实服务器的新 binding 审定、受控备份和 API 替换均为 NOT_RUN**。不得把合成 PASS 写成现役切换回执。历史现役源码/部署信息以 48 号及后续明确授权回执为准。本入口不会停止现役 API、处理真实家庭，或扩大部署许可。

门禁要求人工保存并审定一份绑定：本机 Docker socket 与 daemon ID、明确 Compose 项目名、原 API/DB 容器完整 ID 与镜像 ID、两只卷的名称/创建时间/挂载点/driver/options/labels、既有网络 ID、DB system identifier/数据库名/用户/OID/public schema/迁移账本指纹，以及 Compose 输入及其解析结果摘要。普通卷没有不可变 ID，这些是身份元数据指纹，不等于照片内容校验或灾备证明。旧现役镜像按原 image ID 绑定即可，无需伪造新的来源标签。

先在获准维护窗口停止 API 及同进程任务，保持原 DB 运行，排除其他 DB client、活动卷使用者和未纳入支持范围的网络 peer。当前窄入口仅支持一条明确 bridge 网络、原 DB/私照命名卷和默认 public schema；额外网络、host/DNS 覆写、PGOPTIONS/DATABASE_URL、生命周期 hook、卷 subpath、改写照片目录等均拒绝。现有 GPU bridge 等额外 peer 需要另行审定方案；本门禁不会自动停用、删除或接管它们。

`deploy/existing-stack.override.example.yml` 给出 **external** 原卷/网络模板。把其中四个非秘密身份值与独立保留的部署、备份记录核对后写入私有配置，并把实际 override 一并列入下述 `--file`。缺少原 external 资源会失败，不为恢复名称而自动新建空资源。

以下命令中的绝对路径、项目名、完整 SHA、候选 tag 和 HTTPS origin 都必须替换成已核值；不能直接照抄占位符运行。不要将私有 env、binding 原件、DB dump 或照片放入 Git/聊天/CI。

```bash
node scripts/build-api-candidate.mjs --sha FULL_40_HEX_SHA --tag medbox-api:candidate-UNIQUE_TAG --api-origin https://APPROVED_API_ORIGIN --output /absolute/private/api-candidate.json
node scripts/deployment-guard.mjs inspect --endpoint unix:///var/run/docker.sock --project REVIEWED_EXISTING_PROJECT --file /absolute/project/deploy/docker-compose.staging.yml --file /absolute/private/existing-stack.override.yml --env-file /absolute/private/staging.env --api-origin https://APPROVED_API_ORIGIN --output /absolute/private/binding-proposal.json
```

构建器从指定 Git 对象导出临时源码，忽略工作区未提交文件，显式传入 revision/source tree/API tree，核镜像 ID 与四个来源 label，再写全新本地候选回执。默认只使用本机 `/var/run/docker.sock`，不复用环境中的远程 Docker context 或 Docker 登录配置。回执/label 是本地来源证据，不是签名或生产授权；必须与该 SHA 的独立 CI/源码记录核对。

`inspect` 仅执行配置/身份读取及 DB 只读 SELECT，输出 `UNREVIEWED`。缺失或未初始化账本不能生成可用绑定；已经迁移但空白的另一实例仍有不同 system identifier，不能匹配原绑定。**自动发现不能证明发现的是原家庭数据库。** Owner 应逐项对照先前独立留存的记录，确认原实例与原卷，才在私有 binding 中将 `review.status` 设为 `OWNER_REVIEWED`、填写可追溯的 `review.reference`，另存人工审定文件。脚本没有自动 capture/approve 命令；不能用刚发现的任意栈自行授权。

```bash
node scripts/deployment-guard.mjs --binding /absolute/private/reviewed-binding.json --candidate /absolute/private/api-candidate.json
bash scripts/staging-backup.sh /absolute/private/staging.env /absolute/private/backups /absolute/private/reviewed-binding.json
```

不写模式名时默认 `preflight`。预检不创建/停启 Docker 资源，只检查原对象、私有配置摘要、只读 DB 指纹和候选来源。原接口缺少第三个 binding 参数时会明确拒绝备份。备份在采集前后重复核身份，通过固定 daemon 和 DB 容器 ID、清空 libpq 连接覆写、显式 `127.0.0.1:5432` 导出；不靠环境里的 Compose 项目或 `db` 服务名找库。已有镜像的无网络只读 tar 读取器采集原照片卷。

只有另经明确授权的维护窗口，才执行更新：

```bash
node scripts/deployment-guard.mjs apply --binding /absolute/private/reviewed-binding.json --candidate /absolute/private/api-candidate.json --apply
```

`apply` 要求候选配置中的 `WECHAT_REMINDER_SCHEDULER_ENABLED`、`WECHAT_DOSE_REMINDER_SCHEDULER_ENABLED`、`LEAFLET_PHOTO_CLEANUP_ENABLED` 三项全部显式为字符串 `false`，避免恢复正常入口时提前启动写库或照片清理任务；缺项也拒绝。单纯 inspect/旧镜像备份不要求改写原配置。它首先用候选镜像运行没有挂载、无 provider 环境、只读根文件系统的 SELECT 探针，核同一 DB/public schema/迁移账本；不会先运行 `server.js` 或 migration 入口。随后重读 binding/候选文件/实时原对象，生成只含 API、既有 external 私照卷与网络的临时配置，以明确项目名执行 `up -d --no-deps --no-build --pull never --force-recreate api`。新旧迁移账本须完全一致，本入口不批准 schema 升级。Docker probe 的密码文件与 Compose 的空 env 文件分离，已解析配置的 `$` 字面值统一保留，避免二次解析重定向配置。

返回 `API_REPLACED_HEALTH_AND_REAL_DATA_NOT_VERIFIED` 仅说明受控替换与身份检查；需要另外核 ready、原双家庭数据/私照/批次/备份、实际 API 来源和真机行为，才能形成部署回执。原 binding 不会自动改写为新容器；失败时也不自动回滚、删除卷或覆盖审定文件。成功后的新容器身份须连同原 DB/卷保全证据由 Owner 重新审定后用于下一轮。

Docker 多条命令不是原子锁。复检能发现观察到的漂移，不能阻止两次检查之间的外部管理员操作、卷被删后重建或写入者启动后立即退出；最后复检与 Compose 执行之间仍有 TOCTOU 窗口。必须保持独占维护窗口，不能以通过本入口声称约束了所有 Docker 管理操作。

合成 CI 命令为 `node scripts/test-deployment-guard-docker.mjs`，仅允许 GitHub 托管 Linux runner；它自建随机项目/内部网络/假数据，记录自身资源完整身份后才清理。`var/deployment-guard/result.json` 和绑定备份身份摘要是可复核产物，真实数据和凭据不在其中。卷名/创建时间反例验证的是审定元数据不匹配，不冒称在真实环境删除重建原卷。原 `test-staging-backup-docker.mjs` 继续验证真实 Docker 配对备份/恢复，新增身份回执一起保存于合成备份证据。

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

成功结果位于 `.local-data/backups/medbox-时间-PID/`，内含 `database.dump`、`photos.tar.gz`、`deployment-identity.json`、`SHA256SUMS`。身份摘要仅含绑定/DB 指纹及固定容器、镜像、照片卷标识，三份内容统一校验。两次采集和摘要生成都成功后，才用同一文件系统的一次目录重命名发布整组；目标已存在时不覆盖。失败/SIGINT/SIGTERM仅清理本次创建的未发布临时文件，保留原备份和其他文件。强制终止或断电可能留下隐藏临时目录，应保留并另行核对，不能视为成功备份；此流程不声称断电持久性。目录/文件默认0700/0600，禁止将数据库或照片加入Git或报告。

```bash
bash scripts/staging-backup.sh deploy/.env.staging .local-data/backups /absolute/private/reviewed-binding.json
bash scripts/verify-backup.sh /absolute/path/to/medbox-YYYYMMDDTHHMMSSZ-PID/database.dump
bash scripts/verify-photo-backup.sh /absolute/path/to/medbox-YYYYMMDDTHHMMSSZ-PID/photos.tar.gz
(cd /absolute/path/to/medbox-YYYYMMDDTHHMMSSZ-PID && sha256sum -c SHA256SUMS)
```

检查 `SHA256SUMS`、两个验证脚本的退出码和数据库恢复输出中的家庭、药品、批次数量。图片验证会做路径检查并解压到独立临时目录，不会覆盖现有图片卷。旧格式的 `.dump`、`.dump.photos.tar.gz` 和 `.sha256` 仍保留，验证脚本仍接受旧文件路径，但不能从历史成功输出推断当时存在停写窗口。正式恢复必须另行制定停写、快照和回滚步骤，再把验证后的图片归档恢复到目标卷；逐条核对活动图片关联、授权下载和权限，不能只看计数或把临时目录验证误记为服务器恢复通过。

## 证据边界

本仓库的真实 PostgreSQL 验收只使用一次性隔离容器与临时 schema；本地试用栈和其他项目容器不作为测试目标。Compose 私有图片卷与成对备份脚本已加入代码，但本轮没有对 ECS 执行部署或备份。正式 AppID 对应关系、微信订阅模板与类目、目录授权、HTTPS 和两台手机共享仍须在实际微信账号及设备上验收；未完成前记为 `BLOCKED` 或 `NOT_RUN`。

## 2026-10-11 最新小程序真实 SDK 接收
- 来源 HEAD：17f0854863bdac8abc56a563d5a799bf09d141b2（PR3）；PR4中间候选不纳入本次。
- 隔离项目：E:\project\medcial_box\.local-data\mini-staging-bd85946f-43c1-4eae-9930-c955be225c82。
- 公开客户端配置：AppID wx1f6dd99d28aab8e5，API https://medbox.joviluma.com；urlCheck=true，无服务端密钥。
- 微信工具0.3.11登录状态有效，开窗成功，auto_preview成功503870字节；模拟器实际显示登录页。
- 实际点击微信登录：FAIL。受控 wx.request 健康探针明确返回 request:fail url not in domain list，未到服务端。不能以公网curl健康200替代SDK登录验收。
- 待Owner在微信后台补齐request/uploadFile/downloadFile合法域名；保留旧域名，不关闭校验。保存后重新编译再验证OAuth、相机、识别与双账号同步。
- 拍照识别、双手机同步：NOT_RUN，登录门槛未通过。预览成功不等于登录或整体验收通过。
- 服务器独占部署仍为1867792，31迁移含031已核；客户端17f0854新增改动与服务端契约兼容需在登录通路后实测，不能声称服务端也已升级到17f0854。

### Owner保存域名后的复验
Jovi确认已配置request/uploadFile/downloadFile。执行simulator_refresh并关闭/重开本次独立项目后，真实wx.request健康探针仍返回request:fail url not in domain list。当前等待核对后台AppID wx1f6dd99d28aab8e5及开发者工具服务器域名刷新结果；未关闭校验，未清缓存，登录/拍照/双机仍未通过。

### 首台手机预览结果
Owner扫码新503870字节预览包后，登录仍显示无法连接药箱服务：FAIL。公网health/ready同轮200数据库connected；API最近10分钟脱敏日志未检出auth/login请求（仅作为日志观察，不能断言绝对没有请求）。模拟器同轮wx.request明确域名列表拒绝。必须核微信后台实际域名值及生效配置，未进入拍照/双机验收。

### 域名配置截图与新项目复验
Owner截图确认AppID和三个合法域名正确，原缺项归因撤回。新独立项目mini-staging-70261f15-d267-4a5a-8998-055191e688f3真实wx.request返回200/status ok/database connected，域名网络门槛通过。模拟器实际点击登录仍提示登录没有完成：OAuth未通过，不能标登录PASS。新项目手机二维码已请求生成，手机OAuth/拍照/同步待验证。

### OAuth定位（非网络停机）
服务端收到POST /api/v1/auth/wechat；两次换取微信身份失败均为WechatCodeError，微信errcode40125。服务器私有检查仅输出布尔值：AppID匹配、Owner输入与运行容器Secret一致、存在且无空白或外层引号。无密钥值输出。需Owner核对当前小程序有效Secret并更新原私有配置；不自动重置、不修改业务代码。真实登录仍FAIL，拍照与同步NOT_RUN。

### Secret更新后的实际OAuth验收
Owner更新私有配置后，经SCP仅同步药箱服务器；保留原数据库密码，compose --no-deps仅重建api服务。公网health/ready恢复200/connected。新独立项目真实点击微信登录后，当前页面pages/family-entry/family-entry，标题选择家庭药箱，errorMessage为空：开发者工具真实OAuth登录PASS。手机OAuth仍待确认，相机/识别/双机同步NOT_RUN；不计整体验收完成。

### 手机仍失败：独立门槛未通过
Owner在服务端Secret更新后手机登录仍提示连接失败，手机OAuth为FAIL，不能沿用IDE OAuth PASS。公网A解析120.55.64.11，无AAAA；源站443监听IPv4/IPv6，SNI域名HTTPS健康正常，证书SAN对应medbox，有效期2026-10-11至2027-01-09。最近API日志只观察到先前IDE登录请求，未确定手机请求到达。等待同台手机浏览器health/ready与网络类型，对比手机TLS/连接和微信预览配置；未要求关闭校验或改系统网络。

### 手机浏览器对照
Owner确认同台手机浏览器health/ready返回ok/connected，手机HTTPS基础通路PASS；不等价微信wx.request或OAuth PASS。预览源配置复核为medbox HTTPS，仅config.ts无旧config.js。MCP automation_viewport_action remote自动连接返回timeout waiting for automator response，未取得手机调试会话；请求Owner建立原生真机调试后采集原始失败，不能直接归因TLS或缓存。

### 双账号隔离及新增需求
Owner实机第二微信账号进入选择家庭药箱，未进入123：邀请前隔离观察PASS（Owner报告）。Owner已为第二账号创建家庭。当前API已有家庭accept邀请返回409，UI写明一个账号一个家庭；不能宣称支持多家庭。新增需求：保留自建家庭仍可接受其他家庭邀请，显式切换当前家庭，权限/请求/草稿/照片/导出/提醒按家庭隔离，需远端独立完整阶段实现，本地不代改。不得为测试删除Owner家庭或绕过membership约束。
识别服务器只读配置核实：provider=dashscope，dashscopeKeyConfigured=false，ollamaEndpointConfigured=false。当前云端未接本机GPU，识别功能NOT_READY，不能标准确率失败或通路成功。拍照/扫码识别错误类别待分别采集；条码资料库不等于OCR模型。

### 本机GPU识别路线（Owner确认）
Jovi选择优先本机GPU。只读检测：RTX4070 SUPER 12GB，Ollama 127.0.0.1:11434可读取模型列表，已有qwen3.5:9b和qwen3.5:4b；尚未验证图像推理与实际GPU使用。方案优先复用现有Ollama API及已有SSH认证，建立药箱专属非公网反向通路，API容器到该通路必须有限定访问边界；不开放公网11434，不改其他项目。当前仅准备，尚未连接或切换云端provider。需验证合成图像、超时/断连、GPU利用率再做手机识别。

### 2026-10-11 本机GPU实际接通
- 服务端仍部署1867792，业务源码未改。配置覆盖选择ollama/qwen3.5:4b，内部地址medbox-ollama-bridge:11434。
- SSH使用既有密钥和严格hostkey，将本机11434映射至药箱0700目录中的Unix socket；socket600。独占代理以1001用户、只读文件系统、drop ALL capabilities、no-new-privileges、48MiB/0.15CPU运行，仅药箱Docker网络，无公网端口，未挂载Docker socket或其他项目目录。
- API容器访问本机模型tags HTTP200。现有真实Ollama adapter合成图片探针PASS，14617ms：规格20粒装、效期2027-12/月，药名null并人工补充提示，requiresConfirmation=true。仅连通与受限回填证据，不是药品识别准确率验收。
- 实际观察Ollama llama-server进程、GPU显存约6398MiB；未将其他桌面进程显存归因为模型。
- 切换仅重建api；health/ready200/connected。两个家庭及持久数据库/照片卷未清理，其他服务未重建。
- 本机SSH进程PID记录gpu-ssh.pid；电脑关机/休眠或连接断开会使识别暂不可用。当前连接未做开机自动恢复，长期运维/断线恢复另列；不要把临时接通标为无人值守部署完成。
- 手机读取：OnePlus GM1910显示邀请家人(jjj)。invite refresh已有owner优先覆盖待接受邀请码，现版本一个账号一家；不得删除jjj绕过。远端完整契约PR3评论6107539610，原会话已派发；已有多家庭阶段分支但只中间改动，不接收、不合main，等待最终完整提交/CI。
- 下一门槛：Owner手机真实药盒正面无个人信息拍照，读取手机结果及脱敏服务日志；照片留待核对而非自动保存/推断用途剂量。双家庭加入同步待远端实现。

### 邀请深链返回阻断（Owner严重问题）
Owner报告邀请链接进入后无法退出邀请页，要求保留底部导航。当前invite不在tabBar，owner视图无显式首页出口，member仅navigateTo家庭设置；冷启动无栈必须switchTab业务兜底。缺陷已追加GitHub PR3多家庭完整契约，等待远端修复，不本地代改或改真实家庭。手机当前页面截图已本地采集；模型tags200，但最近未收到手机recognition请求，拍照验收仍NOT_RUN/Owner失败报告待具体提示。

### 协调职责收口（2026-10-11）
收到规划家庭药箱小程序3协调消息：远端完整阶段、PR4收尾/多家庭/邀请导航整合及最终SHA接收由其统一推进。本会话停止远端发提示及自动催办，仅现有HTTPS/API/GPU部署健康维护；不部署中间多家庭候选，不代改业务，保留两个家庭及数据。automation-2已改为健康维护；既有证据仅绑定原SHA，不能代替新候选验收。协调来源为任务消息，未向其他会话发送回复。

更正：automation-2更新调用返回 Automation does not exist；该监测已不存在，未成功更新，也未新建替代监测。上段已改为健康维护仅代表拟定职责与提交请求，不代表自动化保存成功。本会话停止远端提示仍立即生效。
