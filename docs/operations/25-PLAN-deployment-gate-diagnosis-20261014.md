# 部署阻断诊断与维护方案 · 2026-10-14

> 2026-10-20 原始工具回执纠错：2026-10-13 02:36:12 UTC 的 `exec_command` 仅返回 `CreateProcess ... blocked by policy`，没有 reviewer 身份、命中规则、弹窗记录或服务器 Docker 错误。本文及后续对它的“自动审批审核拒绝”表述是当时 Agent 的**未证实归因**，不应说成平台已经解释了原因。它只阻止了那一条本机组合脚本准备命令，不能外推为今天所有不同的新维护方案都会被拒。

本轮诊断起点主线f61609ec072a2b53b29a3a839c6a87e181295142；其最终CI38583982834的verify/backup-docker/flutter已实际确认全部SUCCESS。本记录所附资料适配器/照片封面修复需要新提交与CI，不能继承此CI。

## 拒绝证据与未知项
2026-10-13T02:36:12.156Z，本会话准备写入一个组合保数据升级脚本的exec_command在本机进程创建前返回CreateProcess Rejected blocked by policy。没有执行服务器停机、备份、迁移或切镜像。
原始会话响应只含该通用原因。default.rules共23条allow，没有相应deny；只读诊断日志在该时间窗口有记录，但没有匹配这次拒绝或具体审批原因。不能据此编造被某条SQL、docker动作或文件路径拦截。Jovi确认没有审批弹窗/更详细理由。
本会话不能发起额外执行审批，也不能改规则、换工具/代理或拆命令重做被拒绝部署。C2C可审查方案，不是解除系统拒绝的审批者。

## 当前只读运行证据
- API仍medbox-api:pr3-1867792、健康；实际Compose来自原runtime/compose.yaml和compose.gpu.yaml。
- 实际DB卷medbox-staging_medbox_database；照片卷medbox-staging_medbox_private_uploads。仓库默认卷逻辑名不同，绝不能直接用默认Compose替换。
- 服务器当前可用磁盘682920KiB、内存available441MiB；DB约9655987bytes，照片目录du4KiB。备份容量小不代表可恢复，仍需合法维护窗口和配对校验。
- 识别provider=ollama/modelqwen3.5:4b，但既有medbox-ollama-bridge已退出137/OOMKilled=true，内存48MiB、restart=no。这是识别链路实际故障，不是小程序网络报错即可归因。
- bridge既有user1001、只读根、capdropALL、no-new-privileges、无公开端口、仅既有药箱内部网络和RO Unix socket目录。socket600，本机Ollama已有qwen3.5:4b/9b。
- 仅修复这个独立OOM故障可与被拒绝的数据升级操作区分：不停止API，不读写药箱库/照片，不换镜像/卷、不改socket/安全/公开网络；有限提高原bridge内存并启动同一容器后验证模型tags。若此独立动作也被拒绝，立即停下，不换入口。
- 微信开发者工具登录过期，扫码窗口已打开；login pending task login_1a143135-65e0-49f5-a10a-3e971641af53。未更新手机/上传包。

## 原C2C复审新发现（已读回）
原会话对49dc给CHANGES_REQUIRED：资料直查重复detail，无ID会错报不可用；failed重拍保留旧照片但封面取首张。旧status/confirm源码风险与追加实验BLOCKED仍独立保留。
本地最小修复：直查复用首次有效详情；照片继续追加保留并明确告知保存全量照片，封面开关启用时用最近已上传正面，关闭不改现封面。禁止自动删旧图或重写照片回执。修复须合成回归、独立审查、新SHA/CI后才交付。

## 需要审查的完整维护路径
1. 固定最终新main、CI、镜像来源及artifact摘要；确认设备、公开签名/API/版本兼容。
2. 先解决审批可见性/允许路径。若没有可核实审批，不把用户一般授权、C2C计划或改写脚本当系统解除；停在这个门槛，不发布。
3. 允许后在明确停写窗口只停药箱API/其后台任务，排除卷及DB外部写入者，DB保持运行。以实际旧Compose和卷身份取得成对DB/私照备份，不覆盖旧回执。
4. 按文件名/校验和迁移032两份、033两份、034；仅单成员旧会话回填家，多家旧会话正常选择，不任取首家，不合并家庭。
5. 必须复用实际原卷/配置/网络。升级前后内容/归属摘要与会话token/有效期保护分开检查；原始明细/照片/凭据只留服务器私有位置，不送C2C或GitHub，不用真实Owner资料做合成测试。
6. 没有安全的旧镜像自动降级；迁移部分提交/新API失败要先停写查明，独立恢复策略经审查才能执行。
7. API就绪后生成HTTPS/urlCheck=true微信包、保数据更新；现有两账号/两家正常验首页返回、邀请加入/切家、拍照待确认草稿及旧家数据。缺真实微信交互记NOT_RUN，不假称PASS，不卸载清数据。

C2C请在同一会话审读本方案及当前源码，提出能证明安全差异的建议和所需Owner/平台审批动作，不提供绕过路径；完整阶段为诊断→代码修复/CI→合法服务升级→设备验收→集中复审。


## 本轮实际进展（不代表数据升级）
- 两项C2C源码发现已确认和修复，合成回归：mini428PASS、API279PASS/16SKIP、tooling112PASS/24SKIP；lint/typecheck/buildPASS。新增catalog26项和照片33项相关回归分别通过。只读独立源码审查通过，无新wx/fs/network/component能力；最终mini树a8e2fff68da6dc96d2d39a9e8dfdc46c38f9d6b5登记后继续保留未知能力门禁。
- bridge原容器ID afc0b02a353efd516330f84108afdcbec1085c43875450cf123ec730cdc4153a的memory已128MiB、总memory-swap192MiB，已启动且OOM=false。镜像/网络/用户/只读挂载/capdrop/security/restart=no/无公开端口均保留。不是API或数据库升级。
- API到模型tags仍UND_ERR_SOCKET；进一步确认remote旧Unixsocket600、uid1001但无监听，本机无对应SSH/runner存活。准备保留旧socket并恢复既有私有连接；第一次SSH在连接阶段超时，未移动socket。未改凭据、未公开模型端口。
- 微信login任务首次查询Task not found，状态未知；不重发登录任务、不声称已登录。待Owner扫码后先核真实登录状态。
- 本机原拒绝诊断：相应时间窗口存在日志，但未包含该拒绝详情；规则23条均allow。仍不能确认具体被拦截的动作，不能将通用授权或方案当作系统解除。
- 同一原C2C会话已收到一次完整iteration7维护审查请求，实际确认main/f616与dirty并读取方案，正在思考。未新建任务、不重复催发。
- Hub revision查询仍WinError10061；不自动重试，不伪报上报成功。
