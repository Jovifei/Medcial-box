# 家庭药箱：交付前源码复核与完整验收执行方案

**版本：1.0｜编制日期：2026-10-08｜任务：medbox_delivery_20261007**

> 本文件包含本轮已经完成的 GitHub 读取复核，以及准备交给本地 Codex 执行的测试规范。它不是本轮已经跑完真机、模型或数据库测试的结果报告。用例账本初始全部为 `NOT_RUN`。

## 0. 结论先行

**可以开始受控测试；目前不能批准正式发布。**

以本轮实际读取的 GitHub 快照为准：

| 对象 | 精确标识 | 本轮核验结果 | 用途 |
|---|---|---|---|
| main | `de74a585dc77ac7f113d6473901f19d5cb606f87` | 当前 main | 本轮产品测试基线 |
| main tree | `1211ec10a9c90b6635816f42a0758a3573a12595` | 与 merge commit 对应 | 源码内容核验 |
| main CI | `37596971109` | `verify`、`backup-docker`、`flutter` 全部 SUCCESS | 历史精确提交的自动化证据 |
| PR #2 | `75e06f02a240a1554f5647659d01bc05f309c62e` | OPEN，未合并 | 不并入本轮已验 main |
| PR #2 tree | `bd123820922173b982d77962d01af8e5ccfe85f6` | 与其最新 head 对应 | 单独缺陷跟踪 |
| PR #2 CI | `37633263578` | FAILURE；`verify` 的 `npm test` 失败 | 不能作为可交付候选 |

CI 的 `flutter` 成功包含 analyze、test、Debug APK 与 optimized unsigned Release APK；**不包含正式签名、安装成功或真实微信操作的证明**。main CI 的成功不能借给 PR #2，PR #2 的失败也不能倒过来描述为 main CI 失败。

### 四道不同的准入判断

1. **代码/合成数据测试：可以开始。** 在隔离工作树、一次性数据库、非敏感照片下执行。
2. **真人体验测试：有条件开始。** 先确认真实网关、HTTPS、权限和照片用途告知；只使用获准测试资料。高风险故障注入仍留在隔离环境。
3. **上传开发/体验版本：暂不直接放行。** 必须生成合法 HTTPS 副本、通过包门禁和上传前隐私/身份门禁，且获得对应上传授权；不允许直接上传“源码-禁止上传”工程。
4. **提审与正式发布：HOLD。** 本方案全部适用必测项有证据，阻断缺陷关闭，真实平台配置与两设备验收完成，再分别审批。

“能上传代码”“能生成二维码”“浏览器返回200”“模型偶尔识别成功”不是最终交付完成标准。

## 1. 项目目标、范围和本轮证据等级

最终目标是**真实可用的家庭共享药箱管理工具**，不是问诊、处方审查或个人用药推荐：微信小程序和 Android 客户端支持拍照/条码/手录、人工核对、品牌厂家规格、库存单位和批次位置/效期、分类人群、家庭邀请与权限撤销、用药计划/确认历史/提醒、说明书与私照、导出、备份恢复及正常升级保留。

两台手机含 iPhone 时，iPhone 验证的是**微信小程序**；不把它解释为已有原生 iOS 客户端交付。两个真实微信身份必须连接同一个真实药箱服务，不能让 fixed-openid 开发网关冒充家庭共享。

本轮证据分为：

- **GITHUB_READ：** 实际读取精确 ref 的源码、目录、AGENTS、需求、架构、任务进度、CI、PR 信息。
- **SOURCE_CONFIRMED / SOURCE_INFERENCE：** 从代码确定的行为或需运行复现的推论。二者不是运行通过。
- **HISTORICAL_CI_VERIFIED：** 已读取 GitHub 对指定 SHA 的历史运行结果。
- **NOT_RUN：** 本方案尚未执行的新增行为测试、真机、模型质量、后台、目标环境恢复。

`docs/product/requirements.md` 的早期首版曾排除计划/提醒；后续架构、收尾范围和 Jovi 当前目标已包含这些功能。**不得因旧文档而删掉计划/提醒验收。** `tasks/status.md` 和 `tasks/todo.md` 头部仍保留旧分支和日期，不能直接以旧勾选推断当前状态。

本轮没有改动产品代码、没有合并 PR、没有上传小程序、没有访问本地 workspace 连接器，也没有读取 AppSecret 或私人照片。

## 2. 已沿实际代码确认的识别执行路径

### 2.1 小程序录入识别（不是直接存药）

```text
medicine-edit.wxml：拍药盒/相册/补拍效期/说明书入口
  → medicine-edit.ts:onRecognizePhoto
  → 识别代次 + 当前账号/家庭scope + 字段触碰版本 + 批次结构快照
  → wx.chooseMedia(count=1, compressed)
  → <=4MiB检查、readFile(base64)、JPEG/PNG前缀检查
  → photo-file-lifecycle.writeOwnedPhotoFile
       独占open → reserved持久登记 → 完整字节write → close → ready登记
  → ensureLoggedIn
  → api.recognizeMedicine（wx.request，JSON，60秒超时）
  → POST /api/v1/recognitions/medicine
  → 会话/家庭认证 + MIME/base64/解码后字节数/图片envelope/purpose校验
  → Ollama 或 DashScope 实际provider
  → JSON解析 + cleanDraft字段清洗 + warnings + requiresConfirmation=true
  → 页面检查仍为同scope/代次/照片队列
  → 只补未触碰空字段；批次结构未变才回填批号和效期
  → 状态review；用户核对并编辑
```

页面的 `expiry` 拍照用途发送给识别 API 时映射为 `box_front`；保存照片时仍可使用 `expiry` 和具体 `batchId`。不能把 API 不接受 `purpose=expiry` 判为与当前契约相反的错误。

### 2.2 人工保存与家庭私照保存（两个持久步骤）

```text
onSubmit
  → 名称/批次/单位/日期验证
  → 持久createOperationKey和原始attemptedPayload
  → createMedicine 或 updateMedicine(version)
  → 得到实际medicineId/batchId
  → 逐张uploadLeafletPhoto
  → 必要时setMedicineCover
  → 成功后清理精确归属本机草稿
```

药品保存成功、照片失败时，当前实现进入 `photo_pending`，提示药品已保存、照片待补；重试应沿用已保存药品，而不是再建一条。还必须测试“图片已落服务端但回包丢失”的去重和回执，因为药品幂等通过不等于图片幂等也通过。

### 2.3 详情页补传说明书是另一条流程

`medicine-detail.ts:onAddLeafletPhoto` 会选择图片、检查6MiB客户端限制、弹出明确上传确认，然后写入家庭私照。弹窗说明**不会自动发送给识别模型或联网资料服务**。测试必须断言该入口的模型调用数为0。

这纠正了此前“找不到chooseMedia/family-entry”的错误说法：这两个入口确实存在。家庭加入也确实有预览和确认弹窗；需要验证共享范围是否说明充分，不能再说完全没有确认。

### 2.4 Android识别与恢复模块

`apps/flutter/lib/data/medicine_recognition.dart` 含 API 识别仓库与 ML Kit 实现。API 仓库检查照片字节并调用相同 `/recognitions/medicine`，再映射草稿。**测试前要读实际AppServices装配和入口，确认当前用户点到哪一个实现；文件中存在 ML Kit 不代表当前生产入口使用它。**

`app_stores.dart` 中确有 `SharedPreferencesAppStore`、旧数据隔离和已验证scope的计划草稿收回逻辑，包括写入后 `reload()` 再确认、目的副本确认后再删除原数据。升级测试必须调用这些实际入口；不能拿另一份自行写读的JSON作为证明。

## 3. 独立源码复核发现：不能直接给“完全没问题”结论

以下等级是本轮交付风险判断，不是宣布已复现所有运行故障。

| 编号 | 证据与判断 | 类型/级别 | 处置与放行条件 |
|---|---|---|---|
| F01 | 录入页写“未保存草稿仅在本机”，但保存前已把图片发给识别API，provider还可能把图传给云模型。 | 源码确认的告知歧义；P1，真实照片测试前必须收口 | 区分临时识别传输、后端/第三方处理与家庭持久存储；Owner核隐私指引；未收口仅使用合成非敏感图。不要直接断言违法。 |
| F02 | API给 `RECOGNITION_UNAVAILABLE` 分类说明，但小程序录入页对同code统一覆盖成“拍照识别暂不可用”。 | 源码确认的错误信息丢失；P1 | 用context_limit、invalid_json、timeout、model_missing回包验证可行动提示；不泄露上游原文。 |
| F03 | 图片仅按4MiB和头尾envelope校验，provider直接接收原base64；未见像素/分辨率控制或缩放步骤。 | 源码确认的边界缺口，影响需实测；P1 | 3840×2880约465KB及高像素低字节样本复验；不能声称已解决context_limit；保留所选原图，不擅自替换模型。 |
| F04 | provider通过 `response.json()`/`response.text()`读取响应；错误体的slice发生在读完后。 | 源码确认未见流式大小上限；P1 | 隔离测试大响应/断流/超时/内存；字段截断不等于网络读取有上限。 |
| F05 | `server.ts` 注册onClose用于停调度器/关pool，但该入口与app.ts未见SIGINT/SIGTERM触发app.close；模拟器入口有信号处理。 | 源码确认接线缺口；P1，运行影响待测 | 分别测生产入口/模拟器入口优雅停止、强杀、重启、回执；不推断这就是历史进程退出或530根因。 |
| F06 | `start-local-trials` 对已有进程只核mode；新启动核PID；脚本没有持续监测/重启逻辑，且固定端口、数据库和9b模型参数。local-app-trial标记不是数据库ready。 | 源码确认的启动复用/持续运行证据缺口；P1 | 端口占用/错误服务/启动器退出/DB断连/异常退出；复用必须核归属；固定配置碰到Owner服务时不得直接执行破坏测试。 |
| F07 | `app.ts` 自定义error handler只保留validation/400/415，其余统一500；识别路由bodyLimit为6MiB。 | 源码推论：413可能变500；P1，必须运行复现 | 实际Fastify与真实HTTP各发超bodyLimit请求；期待正确4xx和provider0调用，不接受改断言为500让测试绿。 |
| F08 | helper明确检查SDK >=2.16.1及open/write/close/unlink；IDE `libVersion=latest`只是配置值。 | 源码能力门槛已确认；平台兼容未验 | 后台最低版本、IDE实际解析库、真机库分别记录；2.16.1不是整个产品已验最低版本。 |
| F09 | PR2最新CI的npm test失败，且新增审计不能证明目标生命周期/升级/识别正确；README删掉了有效隔离准备/签名说明。 | 独立分支未通过；不影响main历史CI状态 | PR2保持不合并、不用作main验收结果；修复后另锁新SHA全回归。 |

额外重点用例但**未直接定为缺陷**：详情页修改阈值是否保留品牌/标签；效期照片是否绑定正确批次；私照上传未知结果是否去重；说明书原文迟到是否覆盖用户编辑；非法标签结构是否导致客户端崩溃。测试复现后再定级。

## 4. 统一测试规则：严格体现在断言和证据，而不是标题

### 4.1 状态与严重性

| 状态 | 含义 |
|---|---|
| PASS | 该用例实际执行，所有断言及必要证据满足 |
| FAIL | 实际执行且有至少一个预期不满足 |
| BLOCKED | 缺少明确环境/授权/测试驱动，不能执行；必须写阻塞原因 |
| SKIP | 测试框架明确跳过；必须记录条件，适用必测不得当PASS |
| N_A | 功能确实不适用，需源码/网络调用或Owner确认依据 |
| NOT_RUN | 尚未执行 |

P0：未授权访问、串账号/家庭、未确认自动入库、错误重复写入、数据/照片丢失、泄密等。发现立即停止同风险真实数据测试，隔离环境继续定位。P1：核心功能不可用、关键边界/恢复/告知/发布门禁缺陷，正式发布前关闭。P2：不影响安全正确性的次要展示/维护性问题，登记风险和Owner接受，不与P0/P1混淆。

### 4.2 禁止假验证

- 不用“源文件含spawn/close/draft”证明实际行为。
- 不用临时自建服务器正常退出证明目标API可靠。
- 不用自写JSON→自读JSON证明项目迁移恢复。
- 不用regex读prompt证明真实provider输出边界。
- 不用截图上有库存证明当前API数据正确。
- 不用HTTP200空草稿证明识别成功。
- 不通过删除失败测试、改预期为当前错误结果、去掉QA守卫来通过。

允许在**外部边界**注入假供方HTTP、平台文件系统适配层或合成微信网关；被测的路由、provider解析、页面回填、迁移和身份恢复必须是该SHA的真实产品实现。Fastify注入测试与真实进程/网络测试互补，前者不能证明TLS或进程生命周期。

### 4.3 资源和权限

工程只从GitHub读取，不调用本地workspace连接器。Owner旧目录ahead/dirty/冲突保持原样；从隔离副本执行。禁止改VPN、DNS、系统代理、GPU配置，禁止清缓存/卸载App来规避升级测试，禁止结束不属于本轮的服务。

凭据沿用既有安全注入，不写脚本、前端、GitHub、报告、原始日志。故障注入只允许一次性库/目录/进程。SIGTERM和Windows强杀不是同一语义：分别记录，不互相替代。

`mp.weixin.qq.com` 自动访问已被站点策略禁止，保持停止，不换入口绕过。IDE授权pending只记BLOCKED并由本地提醒Jovi，不能循环轮询当进展。法律声明/正式上传/提审/发布都不能代Owner提交。

## 5. 执行顺序与可直接运行的基础命令

### 阶段A：冻结和环境清点（BASE-01～06）

先只读最新main和PR。若与本方案SHA不同，登记差异并重新审查影响范围，不能自动把新main当这份方案已经审核过。推荐新clone，不复用Owner脏工作区。

下面命令是**本地执行范例，本文没有执行这些工程测试**。PowerShell中 `$Work` 选择新的空目录；不要填Owner旧根目录。

```powershell
$ErrorActionPreference = 'Stop'
$Source = 'de74a585dc77ac7f113d6473901f19d5cb606f87'
$Work = Join-Path $env:TEMP ('medbox-acceptance-' + [guid]::NewGuid().ToString('N'))
function Invoke-Checked {
  param([string]$Program, [string[]]$Arguments)
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Program failed, exit=$LASTEXITCODE" }
}
Invoke-Checked git @('clone','--no-checkout','https://github.com/Jovifei/Medcial-box.git',$Work)
Set-Location $Work
Invoke-Checked git @('checkout','--detach',$Source)
Invoke-Checked git @('rev-parse','HEAD')
Invoke-Checked git @('rev-parse','HEAD^{tree}')
Invoke-Checked git @('rev-parse','HEAD:apps/miniprogram')
Invoke-Checked git @('status','--porcelain')
```

保留 `AGENTS.md` 所描述的本机报告机制，但只能报告自己实际执行的内容；本方案不代称已调用任何本机hub命令。执行证据中保存source/test driver分别的SHA/哈希。

### 阶段B：先跑现有真回归（BUILD-01～08）

```powershell
# 先从既有安全机制注入 TEST_DATABASE_URL，目标必须是新建的一次性测试库。
# 不执行会把该变量值打印到日志的命令。
if (-not $env:TEST_DATABASE_URL) { throw '缺少专用测试数据库：BLOCKED' }
$env:REQUIRE_POSTGRES_TESTS = '1'
$env:QA_INTEGRATION_SOURCE_SHA = $Source

Invoke-Checked npm.cmd @('ci')
Invoke-Checked npm.cmd @('run','build')
Invoke-Checked npm.cmd @('run','lint')
Invoke-Checked npm.cmd @('run','typecheck')
Invoke-Checked npm.cmd @('test')
Invoke-Checked npm.cmd @('run','test:integration')
Invoke-Checked npm.cmd @('run','test:mini:qa')
Invoke-Checked npm.cmd @('run','check:miniprogram:source')
# 官方IDE可用且已授权后再执行，否则单列BLOCKED。
Invoke-Checked npm.cmd @('run','check:miniprogram')
```

Linux/CI使用 `npm` 而非 `npm.cmd`。根 `npm test` 包含工作区测试和tooling；API工作区test自身会先build。本方案显式先build，避免直接运行tooling时导入旧/缺失dist。严格PG入口为 `scripts/run-integration.mjs`，它顺序单独运行13套集成测试并要求专用测试库。

不要在main执行PR2才新增的 `check:lifecycle-audit`/`check:upgrade-matrix` 并将其标签作为成功依据。main已有真实 `recognitions.test.mjs` 和真实页面QA用例，应先运行再按下文补充覆盖。

```powershell
Push-Location apps/flutter
try {
  Invoke-Checked flutter @('pub','get')
  Invoke-Checked flutter @('analyze')
  Invoke-Checked flutter @('test')
  Invoke-Checked flutter @('build','apk','--debug')
  Invoke-Checked flutter @('build','apk','--release')
} finally { Pop-Location }
# 已审查为隔离合成资源的恢复测试；不指向Owner或生产卷。
Invoke-Checked node @('scripts/test-staging-backup-docker.mjs')
```

以上Release是技术构建门禁。真正待安装包另有配置和签名证明。若需本机loopback签名例外，按仓库既有文档及显式Gradle开关执行；不要默默给正式Release使用debug证书。业务源码改变后合理推进版本，不能降低已装code6。

### 阶段C：目标服务稳定性（OPS-01～10）

准备 `dist/server.js` 的真实进程、专用PG、专用照片根和唯一测试端口。每个进程由控制器记录：创建句柄、PID、启动时间、命令来源SHA、根目录、父子关系、监听端口。测试报告不输出含密码的环境/命令行。

1. 启动真实API，先跑迁移，分别请求 `/api/v1/health/live`、`/api/v1/health/ready`，再真实读写一条合成药品。
2. 中断测试数据库：live与ready分开观察；ready应503。恢复数据库后重复同一读写意图，检查幂等。
3. 对真实入口测试SIGTERM、有请求在途时停止、强杀、重启。只有PID消失不能证明app.close或pool.end执行；需目标生命周期内的观测/断言和PG连接释放/端口可重绑。
4. 对真正的启动器做端口冲突、错误服务复用、启动器退出后子服务存活测试。当前脚本固定数据库/端口；**若无法安全隔离这些固定资源，该项BLOCKED而不能在Owner活跃服务上试。** 这仍是工程测试未覆盖，不是Owner-only功能验收。
5. 30分钟连续健康采样（每5秒），2小时低负载观察，插入识别与手录。记录计划停机窗口、失败率、RSS趋势和进程退出；不据此宣传24×7可靠性。
6. 530出现时同步记录手机→临时HTTPS边缘→origin live/ready→数据库→model的分层状态。没有退出事件证据，不断言OOM/启动失败是根因。

当前没有成熟目标harness时，本地可以使用独立测试驱动控制**真实目标**；不能改业务代码代修。需要纳入产品的supervisor/信号修复由远端另交精确提交。本地只回传可复现缺陷及缺少的测试自动化，不将样例服务替换为被测目标。

### 阶段D：拍照识药黄金路径（每个设备都执行）

准备一个无敏感信息、人工已确认真值的药盒，例如：药名、品牌、厂家、`0.3g×20粒/盒`，仅年月有效期，库存由测试员另填而非从包装猜。固定 `sample_id`，不在报告里放真实健康照片。

| 步骤 | 操作 | 必须检查 |
|---|---|---|
| 1 | 冷启动客户端并登录A | 真实网关、合法家庭、与B不同userId；不得固定openid |
| 2 | 打开录入页 | 未采集前用途可理解；识别传输与家庭保存分开 |
| 3 | 拒绝一次相机/隐私授权 | 无照片上传；手录可用；原表单不丢 |
| 4 | 允许后拍摄/相册选择同样本 | 选定图片的实际类型、尺寸、字节数、H1；不靠扩展名判断 |
| 5 | 本机草稿写入 | reserved→完整write→close→ready；H2与选择图对应 |
| 6 | 上传识别 | JSON POST真实识别路由、mime/purpose、解码字节数、耗时；日志不含base64/token |
| 7 | 模型请求 | 当前实际provider/model/options；H3；不更换/卸载模型制造好结果 |
| 8 | 识别回包 | JSON结构、draft/warnings/confirmation；200空结果不算识别成功 |
| 9 | 页面回填 | 名称/品牌/厂家/规格分开；效期保持年月；库存仍由人填；不填个人剂量 |
| 10 | 手工纠正一个字段 | AI迟到不覆盖修正；warning可见；原图可查 |
| 11 | 保存前核库 | medicines/batches零新增；B看不到未保存草稿 |
| 12 | 点击确认保存 | 原始操作意图与幂等键保持；药品/批次只新增一次 |
| 13 | 照片及封面存储 | 图与对应medicine/batch/purpose一致；封面合法；H4对应所选图 |
| 14 | B刷新并查看 | 同一服务端记录；共享字段一致；不含无权个人备注 |
| 15 | 关闭/重开、离线/恢复 | 已存药品可核验；草稿按身份恢复；照片错误不伪装记录丢失 |
| 16 | 导出后交叉核对 | 名称规格数量日期与数据库/两端一致；默认不含个人剂量 |

对“补拍效期”和“识别说明书”再各执行一次，不把药盒正面成功代替这两类通过。详情页补传说明书另外执行CAP-08，断言不会自动调用模型。

### 阶段E：识别边界、故障和恢复（CAP/IMG/MODEL/RACE/SAVE）

执行逐项用例文件的46项采集/输入/模型/异步/保存测试。关键故障点采用真实模块+外部边界注入：

| 注入位置 | 主要反例 | 核心判定 |
|---|---|---|
| 选择器/权限 | 拒绝、取消、后台返回 | 不采集、不暗传、不丢表单 |
| 本机文件 | open失败、部分write、close失败、ready登记失败 | 不上传未完成私照；归属回执可恢复 |
| 输入 | 4MiB临界、6MiB请求体、伪图、HEIC、超高像素 | 明确拒绝或安全降级，不无界内存/假成功 |
| 模型 | context_limit、invalid_json、OOM、缺模型、429、断流、超时 | 有界终态、分类可行动、草稿保留 |
| 响应结构 | 200 HTML、缺draft、数组/null、错误类型、超长字段 | 客户端不崩溃、不落库、不把对象当文本 |
| 字段语义 | 12小时、20粒规格、生产日期、年月、儿童标签 | 不猜库存、日期或个人剂量 |
| 回填前 | 用户改/清空字段、增删批次、发起新识别 | 用户修改优先；旧响应无效 |
| 身份变化 | logout、切家庭、撤销成员、旧401迟到 | 不串账号/家庭，不清新token |
| 药品保存 | 连点、提交后丢回包、同键异载荷 | 唯一持久结果、明确冲突 |
| 照片保存 | 药品已存图片失败、图片已存回包丢失、封面失败 | 不重复药品；图片回执及待补状态真实 |

网络故障通过测试代理/受控fetch/测试网络命名空间注入，不改用户VPN或系统代理。AI恶意/大响应仅打在隔离fake供方，不向真实云模型发送无必要负载。

### 阶段F：真实模型质量与性能（QUALITY-01～06）

**样本建议，作为本轮验收政策而非平台/医疗标准：**

- 清晰样本30张：至少15种不同包装，覆盖药盒正面、有效期面、说明书，品牌/厂家不同，固体/液体/软膏，不同精度效期。
- 困难样本12张：反光、模糊、倾斜、遮挡、两个药盒、非药品、无可见效期、长说明书等。
- 边界合成样本12张：用于字节/分辨率/格式/损坏条件，可在API测试复用。
- Android微信和iPhone微信各跑30清晰图；困难图两平台都覆盖；Android App另跑10张交叉样本。复测不删除首轮失败。费用/模型调用上限先由Owner确认。

**指标必须分开：**

- 有效草稿成功率 = 在规定等待窗口返回可编辑且至少有一个目标可辨识字段的有效草稿次数 / 正常样本有效尝试次数。200但全空、invalid_json、timeout是失败；用户主动取消单列。
- 字段精确率 = 非空且与独立真值一致的字段数 / 所有返回的目标非空字段数。无可见依据却返回内容计错误。
- 字段覆盖率 = 正确识别的可见目标字段数 / 真值中可辨识目标字段数。防止全部返回null取得虚高精确率。
- 端到端延迟 = 完成选图/确认识别至页面进入可操作结果或错误终态；另记上传、排队、推理、清洗、回填时间，不混为模型耗时。

**建议准入线（执行前冻结，不得事后降低）：** 清晰图有效草稿成功率≥95%，目标字段精确率≥98%，字段覆盖率≥90%；识别有明确终态，当前mini60秒/provider55或25秒配置下观察最长70秒的用户可见终态窗口；固定样本报告p50/p95，不承诺尚未测出的速度。任何未确认写库、串家庭、把时长当数量并自动持久、私照泄漏等安全违例容忍度为0。

这些样本不能证明所有药品、光照、微信版本都支持。模型识别错但可人工纠正，应计入质量错误；不能因为“最终人改对了”从识别错误统计删除。

### 阶段G：业务与家庭全流程（AUTH/DATA/PLAN/BAR）

按用例文件逐项验证：未知/0数量、计件整数/ml精度、单位变更、批次拆分、效期/月精度、位置、并发version冲突、handled/archived/回收站、个人备注权限、条码候选/未命中/服务失败、计划/确认幂等及提醒权限。

两个真实微信用户在同服务验收。B被A撤销后，B的旧会话、直接资源URL、照片下载和迟到回调都要检查；第三个合成/受控用户验证跨家庭拒绝。不能以UI隐藏替代服务端授权。

只接收提醒与照护权限按已实现最小投影验证。提醒状态必须区分已排队、发送开始、供方接收、设备实际收到、点击打开；不将供方accepted当送达。

### 阶段H：旧数据、身份、草稿、照片升级（UPG-01～10）

**自动验证和真实覆盖安装是两件事，均要执行。**

1. 旧fixture由旧版真实serializer或真实旧schema生成，不是任意编造JSON。
2. 使用当前 `SharedPreferencesAppStore`、`session_identity_state`、普通草稿/计划重试模块和照片ownership恢复路径读取旧数据。
3. 注入copy失败、remove失败、reload持久层不同、目标冲突；每次重建实例/进程，验证原件保留和恢复幂等。
4. 使用合成图片的真实临时文件验证ready/reserved/missing/replaced/wrong-scope；不仅比较元数据字符串。
5. 真PG旧schema→实际迁移030→API读取→重复迁移；中断只针对一次性数据库。
6. code6已装环境创建专用测试记录和草稿，按既有签名链正常 `install -r`，不卸载/清数据，不动配对码。安装前后比较合法身份、库存、普通草稿、计划意图、ready照片、失败照片及首装时间。只看首装时间没变不够。
7. 微信同AppID正常更新，不能用清缓存后的全新登录代替更新保留。

若没有可用旧版驱动/serializer或测试适配层，标 `BLOCKED(TEST_AUTOMATION_MISSING)` 并把需要远端补齐的测试接口说清；**这仍是可实施工程测试缺口，不得转为Owner-only。**

### 阶段I：导出、成对恢复与UI（EXPORT/UI）

成对备份指数据库、照片文件与manifest属于同一可恢复集合。恢复到新空环境，通过真实API逐条比较关系、purpose/batch/cover、哈希、handled/archived/回执；缺图、篡改、错配备份必须识别。不得用压缩/解压成功当完整恢复。

UI至少覆盖320/360/430逻辑宽、100%/150%/200%字号及真实输入法、安全区和系统返回。截图不证明后台数据正确，必须与API/DB断言配套。

### 阶段J：平台核对和最终放行（RELEASE-01～08）

- IDE `latest`、实际调试基础库版本、公众平台最低基础库配置、真机实际版本分开记录。后台最低仍为1.0.0的用户回传不能据本轮代码改写成已适配；helper下限2.16.1也不能替代全量能力审核。
- 现有图像POST通过 `wx.request`，私照下载通过 `wx.downloadFile`。因此先核request/download对应合法域名。**仅实际使用 `wx.uploadFile` 时核该类别；没有web-view/订单/支付等功能，不要求虚构后台页面或全填不适用项。**
- 家庭内共享照片/文字仍是用户内容。UGC后台项由Owner对照平台当前问题原文和类目决定，不因不是公开社区一律N/A。
- 隐私指引需覆盖实际采集、识别供方、家庭存储与分享；相机系统权限与数据处理告知分别验收。
- 使用源码自带 `prepare-miniprogram.mjs` 生成HTTPS副本后跑release gate；AppID regex仅格式检查，不证明平台主体/授权。
- 体验上传、提交审核、正式发布分别取得授权；本方案不代为提交。

生成副本与包检查示例：

```powershell
# $ApiOrigin 为Owner批准的公开HTTPS origin，不含令牌、路径、query或fragment。
if (-not $ApiOrigin) { throw '未提供已批准HTTPS origin：BLOCKED' }
$MiniAppId = (Get-Content 'apps/miniprogram/project.config.json' -Raw | ConvertFrom-Json).appid
$MiniProject = & node scripts/prepare-miniprogram.mjs --appid $MiniAppId --api-base $ApiOrigin
if ($LASTEXITCODE -ne 0) { throw '小程序副本生成失败' }
Invoke-Checked node @('scripts/check-miniprogram-package.mjs', $MiniProject.Trim())
# 停在生成与校验，不自动执行upload/submit/publish。
```

## 6. 证据怎样记录才能复核

每条用例至少绑定：`run_id、case_id、source_commit、source_tree、test_driver_commit/hash、环境类别、设备/微信/基础库版本、provider/model/options、开始/结束时间、退出码或HTTP状态、断言、结果、脱敏证据引用、缺陷ID`。

识别单次trace建议记录：

```json
{
  "sample_id": "BOX-001",
  "case_id": "QUALITY-02",
  "source_commit": "de74a585dc77ac7f113d6473901f19d5cb606f87",
  "environment_class": "REAL_WECHAT_TEST",
  "selected_image": {"sha256": "本机计算", "bytes": null, "width": null, "height": null, "mime": null},
  "transport": {"request_id": "脱敏关联值", "http_status": null, "decoded_image_sha256": null},
  "provider": {"type": null, "model": null, "duration_ms": null, "failure_category": null},
  "ui": {"terminal_state": null, "latency_ms": null, "manual_edits_preserved": null},
  "persistence": {"medicine_delta_before_confirm": null, "medicine_delta_after_confirm": null, "photo_delta": null},
  "result": "NOT_RUN",
  "evidence_refs": []
}
```

不要记录真实token、真实userId全值、照片base64或完整个人健康回包。授权对比可使用稳定匿名别名或本地HMAC，不能把公开原值放入GitHub。

失败回传应包含：精确SHA和环境、最少复现步骤、预期/实际、第一次失败与重试结果、调用链断点、源文件与方法、脱敏证据、本轮是否修改源码、资源已清理/未清理。**本地不得为通过而修改产品代码。**

## 7. 截图是否需要

源码审查不需要你先补截图。真机验收需要以下六类截图或短录屏，可由本地Codex采集，人工授权/触摸部分由Jovi配合：

1. 登录与家庭选择/加入确认，遮住头像昵称和有效邀请码。
2. 录入页完整布局：名称、品牌、厂家、规格、数量单位、效期、保存区域。
3. 拍照→识别中→结果回填→人工修改→保存的连续录屏。
4. 识别超时/上下文超限/格式失败和手录降级界面。
5. 详情的批次、封面、私照和另一个微信身份看到的共享数据。
6. 覆盖升级前后的未保存草稿、照片和合法身份恢复。

每份证据注明source SHA、设备型号、OS/微信/实际基础库、App版本、字号与测试ID。无需提交真实私照、AppSecret、有效配对码或未脱敏健康资料。

## 8. 最终准入与出报告规则

受控测试可以在main开展；不能因为发现一个P1就停止所有独立可测项。P0立即隔离同风险真实数据操作，其他安全的合成测试可继续。

正式放行要求：适用P0/P1用例全部PASS；所有必测的BLOCKED/SKIP/NOT_RUN有补测结果；真实网关双身份同服务、相机/扫码/识别质量、持久保存/权限撤销、正常升级保留、系统提醒/分享、目标库+照片恢复、包/签名/平台配置均有精确证据。P2残余问题有Owner接受理由。不得把统计分母删掉未跑场景。

最终报告给出四个独立结论：

- `CODE_REGRESSION`: 本次精确产品SHA及测试代码回归结果。
- `EXPERIENCE_TEST_READY`: 是否允许指定人员、指定HTTPS、指定配置体验。
- `SUBMISSION_READY`: 是否满足提交微信审核/正式Android分发准备。
- `PRODUCTION_DELIVERED`: 是否已有真实部署和业务验收证据。

本轮当前判断：**CODE历史CI通过；可开展受控测试；体验上传/提审/正式发布均未放行。** 这不是说工程不可用，而是尚未建立完整可交付证明，并且源码复核仍有明确待修/待验路径。

## 9. 来源索引与外部规则边界

仓库源码统一固定到：
`https://github.com/Jovifei/Medcial-box/tree/de74a585dc77ac7f113d6473901f19d5cb606f87`

主要源码：`AGENTS.md`、`README.md`、`tasks/status.md`、`tasks/todo.md`、`docs/product/requirements.md`、`docs/architecture/overview.md`、`apps/miniprogram/pages/medicine-edit/medicine-edit.ts/.wxml`、`apps/miniprogram/pages/medicine-detail/medicine-detail.ts`、`apps/miniprogram/pages/family-entry/family-entry.ts/.wxml`、`apps/miniprogram/services/api.ts`、`auth.ts`、`photo-file-lifecycle.ts`、`apps/api/src/routes/recognitions.ts`、`leaflet-photos.ts`、`health.ts`、`apps/api/src/services/medicine-recognition.ts`、`apps/api/src/server.ts`、`app.ts`、`apps/flutter/lib/data/medicine_recognition.dart`、`app_stores.dart`、`scripts/start-local-trials.mjs`、`dev-simulator-server.mjs`、`prepare-miniprogram.mjs`、`check-miniprogram-package.mjs`、`run-integration.mjs`、`miniprogram-qa.test.mjs`、`apps/api/test/recognitions.test.mjs`、`.github/workflows/ci.yml`。

CI证据：
- https://github.com/Jovifei/Medcial-box/actions/runs/37596971109
- https://github.com/Jovifei/Medcial-box/actions/runs/37633263578
- https://github.com/Jovifei/Medcial-box/pull/2

测试方法参考的公开官方资料（不是新引入依赖）：
- Fastify Testing：https://fastify.dev/docs/latest/Guides/Testing/ —— 实际应用实例的inject测试与listen网络测试分层。
- Fastify Server：https://fastify.dev/docs/latest/Reference/Server/ —— bodyLimit、close和资源生命周期语义。
- Node.js URL：https://nodejs.org/api/url.html —— 文件URL转路径使用fileURLToPath，不能用URL.pathname当Windows路径。

微信公开官方隐私、网络、基础库文档本轮尝试读取返回不可重试访问错误，未据二手网页宣布任何最新平台规则已满足；`mp.weixin.qq.com` 后台没有访问或绕过限制。对应平台项保留Owner人工核验。本文的工程断言来自实际仓库，建议质量门槛是本测试方案制定的准入政策，不是微信/医学标准。
