# JF小药箱最终交付审核报告（2026-10-07）

## 1. 审核对象与结论

- 仓库：`Jovifei/Medcial-box`
- 最终复核分支：`audit/final-delivery-2026-10-07-review`
- 上游整合线：`audit/final-delivery-2026-10-04`
- 产品范围：微信原生小程序 + Android Flutter + Fastify API + PostgreSQL + 私有照片/识别 + 用药计划/提醒 + 导出/备份
- 当前结论：**代码候选已通过最终自动化门禁，可进入 main 合并评审；正式生产交付仍为 PARTIAL。**

本轮不是只做静态“看代码”，而是按最终产品交付标准复核：数据口径、交互、异常恢复、身份边界、文件生命周期、部署参数、发布版本、签名、反向代理、CI/测试与真实平台验收边界。

### 当前放行判断

| 层级 | 结论 |
|---|---|
| 代码逻辑 / 自动化候选 | **PASS FOR MERGE REVIEW**：精确代码候选 `21303bfe` 的 GitHub Actions run `37581999346` 三个 job 全部 SUCCESS |
| Android 技术构建 | **PASS 作为构建门禁**；默认 Release 不含正式分发签名 |
| 微信小程序代码/QA | **PASS（自动化范围）**；QA 保持 exact-tree / exact-capability fail-closed，源码卫生、测试、构建均通过；真实微信平台仍独立验收 |
| 正式发布 | **BLOCKED**：正式签名、真实 HTTPS、微信真实身份/模板、两设备、真实相机/提醒/分享、目标库恢复均未完成 |

---

## 2. 本轮发现并已修复的问题

### P0 / 发布阻断类

#### P0-01 Android 版本倒退与版本显示错乱 —— 已修复

审核时远端候选 `pubspec.yaml` 仍为 `1.0.1+2`，而历史本机验收记录已有 `1.0.2(5)`；同时 App“版本与更新”仍显示旧手写值 `0.2.0-s0s1r1`。

风险：
- 现有手机可能拒绝覆盖安装；
- 商店/分发升级版本线倒退；
- 用户界面展示版本与真实 APK 不一致，故障定位失真。

修复：
- Android 候选推进到 **1.0.3+6**；
- Flutter 与小程序用户可见版本标签统一到 **1.0.3**；
- 新增 2026-10-07 发布说明。

剩余：版本号目前仍由 Flutter pubspec 与双端发布说明分别维护，建议后续引入发布脚本统一生成，列为 P2。

#### P0-02 正式 Android 签名仍缺失 —— 保留为硬 Gate

当前 Gradle 默认 Release **不回退 debug keystore**。这是正确的正式发布策略，不应为了“能安装”而伪造完成。

保留策略：
- CI 的 release 构建只证明优化/打包链可工作；
- 本机 loopback 试用必须同时满足：
  - 显式 `medboxLocalTrialSigning`；
  - `LOCAL_APP_TRIAL=true`；
  - API 为 HTTP `127.0.0.1/localhost`；
- 正式分发仍需独立正式 keystore、签名保护和发布流水线。

#### P0-03 最新整合候选 CI 曾失败 —— 已定位、修复并由精确候选 CI 验证

上游整合提交 `43803e3` 的 GitHub CI 失败并非业务单测大面积回归，而是安全 QA 沙盒主动 fail-closed：

1. 新小程序 tree 未进入 reviewed tree；
2. 新增 date/time 本地组件，而 QA 原来禁止任意 `Component` / `usingComponents`；
3. 私有照片 helper 因新增 `leaflet` purpose 导致精确 SHA-256 指纹变化；
4. 一条并发 QA 用例仍假设“第二页面可以再创建未完成药品草稿”，已不符合新的单一未完成草稿交互。

本轮修复没有关闭门禁，而是：
- 只批准精确小程序 tree；
- 只允许 `medicine-date-field` / `medicine-time-field` 两个精确本地组件路径；
- `Component(...)` 只允许出现在两个已审组件源文件；
- 组件 methods/observers 仍通过 QA fatal gate；
- 照片 helper 只因 `box_front|expiry` 扩展到 `box_front|expiry|leaflet` 更新精确 SHA-256，文件系统 API 清单未放宽；
- QA 并发用例改为验证“较新的持久照片 ownership receipt 不会被旧页面普通字段编辑覆盖”，不再构造已被产品规则禁止的第二未完成药品草稿。

---

### P1 / 产品与部署正确性

#### P1-01 HTTPS 代理会拒绝合法照片 —— 已修复

API：
- 药品识别允许原始图片最大约 4 MiB；
- 私有照片允许约 8 MiB；
- Fastify 对应 bodyLimit 已提升。

旧 staging Nginx：
- `client_max_body_size 1m`；
- 识别代理超时 30s。

结果：正式 HTTPS 下合法照片会在到达 API 前 413，Ollama 识别也可能被 Nginx 先 504。

修复：
- `client_max_body_size 12m`
- `proxy_read_timeout 75s`

#### P1-02 已处理批次仍污染药品级过期状态 —— 已修复

旧 API 的 `MedicationSummary.expiryState` 聚合所有批次，包括 `dispositionStatus=handled`。

风险：用户已经处理掉的旧过期药，首页仍可能继续显示“已过期”。

修复：药品级期限状态只由当前未处理批次驱动；历史批次自身仍保留真实过期状态。

#### P1-03 Android 低库存计数与筛选不一致 —— 已修复

旧 Android：
- 顶部低库存计数：`low/exhausted`
- 点击“库存不足”：`low/exhausted/unknown`

结果：用户点击数字后，列表数量会比数字多。

修复：筛选与计数统一为 `low/exhausted`；`unknown` 独立进入“数量/日期未知”。

#### P1-04 “待补资料”双端语义漂移 —— 已修复

小程序将“待补资料”定义为资料完整度：
- 规格；
- 厂家；
- 成分；
- 说明书核验。

Android 原来把“日期缺失”也算进待补资料。

修复：
- Android 与小程序统一“待补资料”语义；
- 数量/日期不完整单独进入“数量/日期未知”。

#### P1-05 小程序“已归档”筛选入口曾永远为空 —— 已修复

页面有“已归档”筛选，但首页旧请求调用 `listMedicines()` 默认不获取归档数据。

修复：
- 首页读取含归档集合；
- 默认/其他筛选仍隐藏归档；
- 仅“已归档”筛选显示归档记录；
- 顶部当前库存统计不计归档。

#### P1-06 药品录入页网络失败会被误判成登录失效 —— 已修复

旧 `checkEntrySession()` 对任何异常都跳登录页，网络断开、服务 5xx 等也会让用户误以为登录失效。

修复：只对 401 / UNAUTHENTICATED / UNAUTHORIZED / SESSION_EXPIRED 跳登录；普通网络/服务异常留在当前页面并显示错误。

#### P1-07 小程序网络错误把内部 API 地址/USB 信息暴露给用户 —— 已修复

旧用户提示直接包含 `API_BASE`、模拟器/手机网络和 USB 转发诊断。

修复：
- 用户提示改为通用“无法连接药箱服务，请检查网络后重试”；
- 详细 base URL / errMsg 仅写控制台诊断。

#### P1-08 Android 初始化错误和未配置页展示开发者内部信息 —— 已修复

旧 Android：
- 初始化页直接显示 `snapshot.error`；
- 未配置页直接展示 `flutter run --dart-define...`、`10.0.2.2` 等开发信息；
- Release 误配置时仍可见演示入口。

修复：
- 初始化错误改为通用用户文案；
- 技术配置说明移回开发文档；
- “查看演示界面”只在 Debug 显示。

#### P1-09 日期输入存在重复实现 / 交互不一致 —— 已收口

本轮确认：
- 日期校验已统一到公共 `input-validation`；
- 小程序引入精确审查的 `medicine-date-field` / `medicine-time-field`；
- 包装有效期、开封日期、开封后截止日期不再各自维护不同输入方式；
- 日期精度（月/日）转换有独立回归测试。

#### P1-10 小程序死 API 配置源 —— 已清理

旧 `app.ts globalData` 仍有 `127.0.0.1:3000`，真实请求实际走 `services/config.ts` 的另一地址。

风险：维护者/Agent 很容易改错位置。

修复：删除未使用的 `globalData.apiBase/token` 及对应 typings，网络配置只保留真实单一入口。

#### P1-11 本机试用 health 路由认证边界 —— 已修复

正式公共 health 只允许精确 `/live`、`/ready`。本机 App 试用还需要未登录读取 `/health/local-app-trial`，但不能把整个 health 前缀公开。

修复：
- Fastify route config 增加 `localTrialMarker`；
- 只有 **GET + 精确 local-app-trial path + route 显式 marker** 才绕过认证；
- POST、其它 health 路径、未标记同路径仍 401；
- dev simulator route 显式设置 marker。

#### P1-12 staging 初始化会覆盖人工可选配置 —— 已修复

旧 `setup:staging` 每次只重写：
- POSTGRES_PASSWORD
- WECHAT_APP_ID
- WECHAT_APP_SECRET

识别模型、提醒模板、端口等后续人工配置会被清掉。

修复：
- 初始化脚本只托管三项；
- 其余已有 .env 行（含注释和复杂 JSON field map）原样保留；
- 去重重复托管 key；
- 新增回归测试；
- staging env 示例补齐识别/提醒/端口可选项。

#### P1-13 待处理事项三端口径不一致 —— 已修复

此前 Android 待处理页、本地首页筛选与 API / 小程序 pending 列表对“数量/日期待核对”和“待补资料”的定义不同。

修复：
- 数量未知、包装有效期未知、已开封但开封期限未知归入“数量 / 日期待核对”；
- 只有设置过低库存阈值时，未知库存才作为待处理库存事项；
- “待补资料”统一覆盖规格、厂家、成分和说明书核验；
- API `/notifications/pending`、小程序文案和 Android 本地离线推导同步；
- 保留 Android 离线按缓存显示待处理事项的能力。

#### P1-14 Release 仍可进入合成 demo 路由 —— 已修复

旧 Android 虽然已隐藏 Release 的“查看演示界面”按钮，但 `/demo/*` 路由仍无条件注册并被 redirect 放行。

修复：
- demo 路由只在 `kDebugMode` 注册；
- Release 不再路由到合成药箱/家庭/导出流程；
- 生产主流程不再有可进入的演示入口。

#### P1-15 小程序源码目录可能被误当正式包上传 —— 已修复

源码 `services/config.ts` 默认是本机 loopback。旧包体门禁只检查体积/开发文件，不检查 API origin，维护者若直接上传源码目录可能得到“结构检查通过”的错误信号。

修复：
- 源码工程名改为 `JF小药箱-源码-禁止上传`；
- 包门禁拆成 `source` 与默认 `release` 两种模式；
- CI 对仓库源码只运行 `check:miniprogram:source`；
- release gate 强制：生成副本、非 QA、非本机试用、非源码工程、公开无凭据 HTTPS origin；
- staging runbook 明确“生成 HTTPS 副本 → 对生成目录跑 release gate → 再打开 DevTools”，禁止直接上传源码目录。

#### P1-16 Android 多余精确闹钟豁免权限 —— 已修复

Manifest 同时声明 `SCHEDULE_EXACT_ALARM` 与 `USE_EXACT_ALARM`，但代码实际通过可请求的精确闹钟权限工作，并在拒绝时自动降级到非精确调度。

修复：
- 删除未使用的 `USE_EXACT_ALARM`；
- 保留 `SCHEDULE_EXACT_ALARM`；
- 用户拒绝精确闹钟权限时仍使用 `inexactAllowWhileIdle`，提醒功能不被整体阻断。

#### P1-17 小程序基础库使用 trial —— 已修复

源码 `project.config.json` 原来使用 `libVersion: "trial"`，会跟随最新基础库，而正式候选没有必要承担灰度/最新能力变化风险。

修复：
- 源码基础库改为 `latest`（最新非灰度基础库）；
- release package gate 显式拒绝 `trial`；
- 新增回归用例，避免后续把体验/试用基础库重新带入正式候选。

正式发布仍应在微信开发者工具中记录最终实际基础库版本和编译结果；代码门禁不替代平台编译。

#### P1-18 main 分支无保护 / required checks —— 尚未自动修改，发布前必须收口

审核时 GitHub `main` 显示 branch protection 未启用，required status checks 为空。当前候选比 main 领先大量提交，如果最终通过直接 push/merge，可以绕过 CI。

处理建议：
- 合并必须走 PR；
- 合并前要求当前候选 exact HEAD 的 CI 全绿；
- 合并后要求 main exact commit 再跑 CI；
- 仓库管理员应启用 main branch protection / ruleset，至少要求 CI verify、flutter、backup-docker 成功并禁止直接绕过。

本轮连接器只有 branch-protection 读取能力，没有安全写入仓库管理策略，因此没有伪称已开启。

---

## 3. UI / 交互审核

### 首页

小程序与 Android 当前都已经形成四主入口：
- 药箱
- 用药计划
- 待处理
- 我的

药箱首页：
- 搜索、清除；
- 用途/人群/状态/排序四入口；
- 空态；
- 无结果态；
- 网络错误 + 重试；
- 保存成功后的回看入口；
- 录入主 CTA。

小程序四个筛选入口使用等宽 grid；Android 使用四等分 Row。布局结构没有发现明显的“按钮被挤没/主操作不可达”问题。

### 录入

当前设计原则正确：
- 拍照识别只生成草稿；
- 人工核对后才写库存；
- 手动录入始终可用；
- 同时只允许一个未完成药品草稿，避免多个页面并发覆盖；
- 照片写入有 reserved → ready ownership 状态；
- 写入/关闭/删除失败可恢复；
- 用户字段版本可阻止晚到 OCR 覆盖已手改内容；
- 日期、单位切换都有显式语义保护。

### 错误恢复

较好的部分：
- API ACK 与随后刷新失败分离；
- 计划创建/服药确认有幂等与显式重试；
- 会话/家庭切换有 identity fence；
- 本地存储失败不会直接丢草稿；
- 退出/换家庭会清理当前身份私有状态；
- 网络故障不再自动伪装为登录失效。

### 视觉与无障碍边界

本轮静态复核另发现 Android 首页状态卡使用 `FittedBox(scaleDown)`，会在系统大字体时主动缩小文字。已改为最多两行、保留系统文字缩放，并给整张状态卡补充可读的按钮语义标签。

已有自动化覆盖窄屏/大字、部分引擎渲染和标签不截断历史证据；但**当前 2026-10-07 精确候选没有在本轮重新做实体机逐页视觉截图审计**。因此以下仍需真机确认：
- 200% 字体下四入口与长药名；
- 原生输入法顶起；
- Android 系统 Back；
- 微信真机安全区；
- 相机/相册授权弹窗；
- 低端机长列表滚动与图片加载。

---

## 4. 数据与业务逻辑审核

### 已确认设计正确

- 有效期保存原始精度：年月不伪造某一天；
- 默认 30 天临期；
- 月精度当月到期、过完月才过期；
- 家庭“今天”按 Asia/Shanghai 计算，避免 UTC 凌晨偏一天；
- `numeric(14,3)` 数量经定点毫单位运算，避免 0.1 + 0.2 浮点误判；
- “未知数量”与“0=确定耗尽”分开；
- 已处理批次保留历史但不驱动当前库存；
- 包装期限与开封后期限取更早管理截止；
- 换算只有用户确认后生效；
- 写操作有版本冲突/事务边界；
- 计划创建和确认类操作有持久幂等语义。

### 仍需真实数据验证

- 真实药盒 OCR 名称/品牌/厂家/规格准确率；
- 说明书分区 OCR 与错误提示；
- 条码供应商真实覆盖率；
- 本机人工 catalog 目前是开发/本机能力，staging 默认仍走外部资料 provider；不能把本机资料库宣称为正式线上已部署能力。

---

## 5. 安全与隐私审核

### 当前较强的边界

- 会话明文 token 只返回客户端，服务端数据库只存 SHA-256；
- 每次业务请求重新检查当前家庭成员关系；
- 跨家庭访问自然 404；
- 客户端对晚到请求使用 session/identity generation fence；
- 私有照片路由先鉴权，再解析大 body；
- 照片文件只删除能证明由当前 scope/draft 精确拥有的路径，不做宽泛目录删除；
- 导出临时文件使用精确登记与身份边界；
- reminder 发送前重新检查成员、偏好、权限和发送租约；
- 发送结果不确定时不盲重发；
- staging API 只通过宿主 loopback port 暴露给 Nginx；
- Nginx 覆盖 X-Forwarded-*，而不是信任客户端自带值；
- 备份要求 API 停止并验证数据库 + 私有照片同维护窗口，生成校验和并可隔离恢复。

### 仍需发布侧完成

- Android 正式 keystore 生命周期和权限；
- 服务器 Secret 注入与文件权限；
- 生产域名证书续期；
- 真实微信 AppSecret/模板权限；
- 生产日志脱敏与留存策略；
- 目标主机实际备份恢复演练。

---

## 6. 代码质量与冗余

### 明显改善

本轮已经移除/收口：
- 小程序重复日期校验；
- 小程序两套 API 配置源；
- 多端库存/资料筛选口径漂移；
- 多处开发诊断直接展示给用户的问题。

### 仍存在的 P2 结构债务

当前若干文件职责明显偏大（数量为审计时近似规模）：
- `apps/miniprogram/pages/medicine-edit/medicine-edit.ts`：约 60+ KiB；
- `apps/flutter/lib/features/medicine/medicine_entry_api_page.dart`：约 60+ KiB；
- `apps/api/src/routes/medication-plans.ts`：约 60 KiB；
- `apps/flutter/lib/features/plan/plan_form_page.dart`：约 50 KiB。

这些文件已经有大量测试保护，当前建议**不要在 RC 前做大规模重构**。发布后再按“状态拥有者 / 表单状态 / 照片队列 / 识别适配 / 提交事务 / UI section”拆分，以降低回归风险。

本轮另删除了 Flutter 模型中无人使用且仍按旧“全部批次”语义计算的 `openingOrExpirySummary` getter，避免未来重新引入已处理批次污染。仍建议后续继续做死代码/重复派生逻辑清理，但不要在发布候选冻结前进行大面积结构重写。

Android pending 离线推导与服务端 pending 目前仍有两份实现，虽然本轮已通过契约和回归用例对齐规则，但长期仍可能漂移；建议后续提取共享规则或补强跨端契约测试。双端用户可见版本标签也仍为发布时手动维护，建议由发布脚本单源生成。

---

## 7. 部署与发布审核

### 已修

- Nginx 图片 body / 识别超时与 API 对齐；
- staging env 初始化可重复执行，不清人工配置；
- Android applicationId 注释改成稳定 ID 说明；
- 本机试用 Release 命令补上显式 Gradle 签名开关；
- README 不再把 unsigned release 描述成可直接正式发布；
- README / architecture 不再引用旧 736d762 / migration 029 作为当前状态；
- Android 四入口、当前候选版本与迁移 030 已同步文档。
- 小程序源码工程与正式 HTTPS 生成包已由不同门禁区分，源码目录明确禁止直接上传；
- Android Release 移除未使用的 `USE_EXACT_ALARM`，合成 `/demo/*` 只保留 Debug。

### 正式发布前硬 Gate

1. ✅ 精确候选 `21303bfe` GitHub CI 已全绿；合入 main 后仍需对 main 精确提交再跑一次；
2. main 合并后对 exact main commit 再跑 CI，并确认没有合并冲突/额外变更；
3. 目标 PostgreSQL 从当前版本应用到 migration 030；
4. HTTPS 域名 + Nginx + API health + 大照片上传实测；
5. Android：
   - applicationId 最终确认；
   - versionCode > 已安装版本；
   - 正式 release keystore；
   - 签名指纹备案；
   - `API_BASE_URL=https://...`；
   - 可升级安装；
6. 微信：
   - 实际 AppID / AppSecret code2session；
   - 合法 request/download 域名；
   - 订阅模板与 field map；
   - 真机相机/相册/扫码；
7. 两真实账号 + 两真实设备：
   - 建家庭/邀请/加入/移除；
   - 权限变化实时生效；
   - App 连接/撤销；
8. 提醒：
   - 微信订阅消息真实送达；
   - Android 前台/后台/锁屏/重启；
9. 导出/备份：
   - Markdown / CSV / PDF / JSON 系统分享；
   - staging 数据库 + 私有照片成对备份；
   - 全新隔离环境恢复并读回；
10. 最终 UI 真机走查并留证。

---

## 8. 最终建议

### 可以做

在**最终精确 CI 全绿**后，将本分支作为代码合并候选进入 main；合并后再次跑 exact main CI。

### 现在不能做

不能把“CI、Debug、unsigned Release、合成数据库测试通过”表述为“正式交付完成”，也不建议当前直接面向外部家庭发布。

### 发布顺序

1. 冻结最终 commit；
2. CI 全绿；
3. 合入 main；
4. 目标数据库 migration 030；
5. 部署 API + HTTPS；
6. 生成正式小程序包；
7. 生成正式签名 Android 包；
8. 单设备烟测；
9. 两账号两设备验收；
10. 消息 / OCR / 分享 / 备份恢复验收；
11. 才标记 V1_DELIVERED。

---

## 9. 本轮变更摘要

本次复核分支已实际修复或收口：
- 代理上传大小与识别超时；
- 已处理批次期限状态；
- 低库存/未知/待补资料跨端口径；
- 已归档筛选；
- 小程序认证异常跳转；
- 网络诊断用户文案；
- 重复日期校验、日期/时间组件；
- 照片草稿与 ownership 生命周期；
- 本机试用认证 route；
- QA 组件/文件能力 fail-closed；
- Android 初始化/配置用户文案；
- Android/小程序版本标签；
- Android versionCode/versionName；
- staging 配置重复执行保护；
- Android 构建/试用文档；
- README/架构当前状态。
- Android 待处理事项与 API / 小程序资料口径；
- Release demo 路由隔离；
- Android 精确闹钟权限最小化；
- 小程序 source/release 包门禁；
- Android 首页大字体状态卡；
- 未使用旧期限摘要死代码。

### 最终自动化结果

- 精确候选：`21303bfe358205036da4215d0872e8f3d8c182dc`
- GitHub Actions：run `37581999346`，**SUCCESS**
- `verify`：SUCCESS（npm ci / lint / typecheck / 全量 test / build / `check:miniprogram:source`）
- `backup-docker`：SUCCESS（隔离 staging 备份与恢复演练）
- `flutter`：SUCCESS（pub get / analyze / test / Debug APK / optimized unsigned Release APK）

该结果证明的是代码候选与仓库自动化门禁通过，不替代正式签名、真实微信、真实设备、HTTPS、目标库迁移与生产恢复验收。

### 集成注意

本轮审核期间连接到的本机 Codex 工作区仍存在未提交文件；本审核没有覆盖或清理这些本机改动。正式构建、合并和验收必须锁定远端审核分支的精确 commit，或先显式把本机工作区与该 commit 对齐并重新验证，不能从未知脏工作树直接产出发布包。
