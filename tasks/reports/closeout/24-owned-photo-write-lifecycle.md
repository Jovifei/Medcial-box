# 2026-10-05 照片独占创建与登记先于私有字节

实施基线 `9de6d99137262e21142025a941094b7764209228`。该精确提交的 [CI37248957893](https://github.com/Jovifei/Medcial-box/actions/runs/37248957893) 已通过 mini265/API389（严格PG无跳过）/tooling59、Flutter689/analyze、Debug及unsigned Release、隔离Docker恢复。本报告新增产品写入链，不能把基线的通过当作新提交已通过。

## 原生能力依据与证据分层

- 本机验收回传：基线9de6d991、IDE2.02.2609231、模拟器SDK3.17.3，独立合成探针的wx/wx+独占创建、8字节write/close、重复路径失败且原字节不变通过。该探针不是当时仍使用writeFile的产品保护，也不是本批新页面已实测。
- 微信官方维护的 [api-typings精确源码](https://github.com/wechat-miniprogram/api-typings/blob/6092df9100c73b84e140c20b9a42a8e8799e0660/types/wx/lib.wx.api.d.ts) 标注open/write/close最低基础库2.16.1（插件内2.19.2）；OpenOption明确wx/wx+在路径存在时失败，WriteResult提供实际bytesWritten。
- 官方API直链：[open](https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.open.html)、[write](https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.write.html)、[close](https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.close.html)。本轮文档站无法打开，依据是上面微信官方源码及本机原生探针，不是Node/browser文件系统语义。
- project.config.json的libVersion=trial只选择IDE调试基础库，不能保证用户客户端能力；运行时检查SDKVersion与所需方法，失败即停持久照片写入。

## 产品流程

1. 只用open(flag="wx")创建精确新文件，不调用writeFile、不回退w、不使用先access再write的检查竞态。
2. 独占成功才建立owner/path/draftId的reserved记录；存储成功回执之前不写任何私有照片字节。已存在路径失败时没有归属记录、unlink或覆盖。
3. 通过fd写ArrayBuffer，核对bytesWritten等于byteLength；部分写入/错误均保留reserved，不能标ready或发送识别。
4. close成功后再写ready状态；存储未确认则当前内存回退reserved，阻止药品提交/照片上传，提示先删除未完成草稿后重拍，文字可手动保存。
5. 活跃写入租约持续到ready记录完成；清理不能在write期间或close与ready之间抢删。close失败保留精确fd租约，原归属的重试合并为一次close，其他归属不能关闭。
6. 写入前失败只尝试清理本次独占创建、且已关闭的空原件；开始过write则保留登记证据供既有失败清理流程处理。
7. 登录/家庭改变停止后续写入、ready保存和识别；已发出的原生调用无法撤回，但其原始fd仍执行关闭。加载中断reserved草稿显示失败，不推断文件完整；同页面后台重载不替换正在写入的记录。
8. 基础库低于2.16.1、未知版本或缺方法时，不落持久照片，不静默使用不安全写法；显示升级微信或手动录入路径，原草稿不删除。

## 云端验证

- 新10个真实产品页面合成场景：父提交生产页面0 PASS / 10 FAIL；新页面10/10 PASS。覆盖独占冲突、登记失败、部分写入、close/ready失败、加载重入、版本降级、切身份、中断恢复。
- 新15个服务场景覆盖调用顺序、版本门槛、无效归属/路径/字节参数、close重试与并发、清理租约、身份变化和失败边界；15/15 PASS。
- 完整本地门禁：mini305 PASS、API238 PASS / 13可选PG套件SKIPPED、tooling59 PASS；lint/typecheck/build/源包预算通过。包116 files / 587025 bytes。
- 旧识别迟到响应断言和照片归属清理断言保留，只为其受控wx替身补齐新安全原语和SDK版本，没有删测试或降低断言。

## 独立复审后的第二版

首版独立复审确认两类阻断，本版不沿用首版“聚焦通过”作为关闭依据：

- 有reserved未完成原件的当前草稿在再次选择相机/相册前就停止，要求先处理原件，不能一边积累失败文件一边显示新识别成功。
- onUnload同时标记disposed并取消识别代次；成功、错误及持久回调都不得重放旧页面数据，fd关闭仍由服务完成。onHide不等同卸载，正常系统picker的hide/show仍能完成。
- native write/close/ready及OCR续作都检查当前持久目标仍存在、未进入cleanup_pending/saved，且没有别页更新过表单字段；已删记录不能被迟到成功或catch复活。
- ready/OCR变更从最新持久queue快照合并，保留别页新草稿；快照深拷贝，避免在setStorageSync回执前修改平台缓存。登记失败只给当前页失败显示，不重新写旧queue。
- 页面重入重新读取queue，已不存在的active照片ID清空；未完成原件保持保守恢复，不猜测完整性。

原独立9项复现已全部通过。新增回归文件包含这9项与6项并发/正常picker场景，共15/15 PASS；完整复跑为mini305/API238（13PG套件跳过）/tooling59及全部根门禁通过。仍须针对这个新冻结版本独立复审和精确远端CI。

## 保留边界

wx.setStorageSync/close成功回执不等于跨文件与存储的原子事务或fsync保证；不声称断电、跨进程并发或同权限恶意替换已关闭。创建空文件后、登记前异常仍可能遗留空文件/句柄，但本流程尚未写入私有字节；失败关闭仍须重试或进程结束。旧无登记原件保持保守保留，不扫描猜删。

本批第二版尚需独立复审、精确新提交CI和官方IDE产品路径验收。此前家庭切换IDE矩阵因同账号/AppID副本共享存储而安全停止，不记PASS；后续使用明确内存隔离夹具，并与原生文件探针分层报告。


## 第三至第五版：并发队列与表单确认基线

第三/四版没有发布：独立审查在既有全套通过后继续复现“onShow之后再选择或输入”“删除确认等待期间实际新增capture”“清理另一目标后active表单滞后”“未落盘批次字段覆盖别页另一字段”等数据损失。不能用此前305/309/313项通过抵消这些独立反例。

第五版统一边界：

- 被动清理只使用已经持久确认的saved/cleanup_pending意图，不登记页面独有意图、不复制旧active表单；原生await后从最新队列只更新或移除完全匹配的目标。
- 页面独立保存queue确认快照和active表单确认基线。queue变化同时刷新可见表单，未获存储确认的本页字段差量仍保留。
- 所有普通照片草稿保存先读最新queue，再按本页相对确认基线的差量合并；别页新增receipt保留、已移除/已保存/待清理目标不复活。
- 照片记录按精确path合并；同结构批次逐字段合并，避免本地lotNumber覆盖别页storageLocation。并发结构改变时停止写入，保留当前表单，不通过选择/新建草稿丢弃未存编辑。
- 删除确认重新读取最新目标，只持久该目标删除意图；调用期间新增实际照片原件的归属回执不丢。

本轮实际云端门禁：mini321/321、API238通过/13可选PostgreSQL套件跳过、tooling94/94（其中生成实际产品模块的内存隔离QA35/35，无跳过）；lint、JSON、全部typecheck/build、源包预算116 files / 592713 bytes通过。使用现有依赖的直接eslint/tsc/node入口，未安装或下载依赖。早期一次npm门禁的会话轮询因意外registry网络风险被拦截，该不可确认结果不计通过；上述计数来自完整的本地直接工具复跑。

内存QA源码白名单当前绑定mini-tree `7081baa66f0532ea4c7ecff269f81d4fdd8b155d`，必须从精确提交生成全新包。R1/R2/R3/R4旧ZIP及旧README树号不能作为本版验收输入。测试会自动覆盖包含writer的当前提交，显式source SHA仅用于冻结候选；缺少环境变量不再意味着跳过writer测试。QA只提供内存存储/文件/接口模拟；官方IDE产品路径、原生持久化与真实设备依旧未验收。

本节记录的是发布前本地结果；独立终审、精确远端CI与生成包manifest另行绑定，不能继承基线CI或声称已发布/上线。


## 第六版：进行中上传与新增批次身份

第五版的独立新反例阻止了发布：另一草稿的cleanup结束会替换正在上传的照片数组/medicineId，导致失败重试丢关联或成功上传漏封面；新增批次都为null服务器id，删除后新增且数量相同时不能按索引判定同一批次。

第六版在原有队列差量合并基础上收紧：

- 当active照片正在submitting，其他目标cleanup仍安全写最新durable queue，但暂不替换进行中保存持有的UI照片/关联对象；后续显式保存再按最新队列合并。自身完成保存后的清理保持原流程。
- emptyBatch产生稳定本地draftKey，只在本机表单/草稿内使用，API payload仍为显式业务字段，不包含此key。同结构合并要求唯一且可证明的服务器id或本地key；旧无key批次和身份不明的并发结构变动停止合并，保留当前表单。OCR也使用稳定身份或原始对象身份检查结构。
- 新增实际回归：成功/失败上传期间清理另一目标、删除意图不可被旧writer输入覆盖、baseline不别名引用、删除再新增null-id批次不得转移数量。

最终本地候选门禁（2026-10-05，现有依赖、全合成数据）：mini326/326，API238通过/13可选PG套件跳过，tooling94/94，其中隔离生成页QA35/35无跳过；lint/JSON/全部typecheck/build通过；源包116 files / 593570 bytes。

当前mini-tree为 `abdef7419cb4abf00c54112456897ae05ebcbaba`，覆盖本报告上一节的R5候选绑定；旧包均不作为第六版输入。最终独立结论、远端精确CI和新生成manifest须另行核实，不声明真实账号、原生持久化、官方IDE产品链路或上线已通过。

独立复验补充：复审在唯一新冻结目录核对第六版产品TS及输入patch身份后，实际执行全mini326/326和45/45针对性边界，均通过且零跳过。较早复审目录重叠导致执行过旧309测试集，该旧结果明确不计作第六版全套；本处326是重新物化精确冻结输入后的实际结果。上述仍为合成代码级证据，不替代官方IDE/真机、签名发布或上线验收。
