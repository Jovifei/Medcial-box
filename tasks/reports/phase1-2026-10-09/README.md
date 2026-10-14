# 第一阶段本机测试与独立代码审核

结论：**CHANGES_REQUIRED，第一阶段验收未通过；不进入真人使用或正式提审。** 已完成本机基础回归、R1-R7首轮独立审查和重点反例复现。范围内未执行项仍NOT_RUN/BLOCKED/SKIPPED，不称288条规格全测完。[逐项本机处置](local-case-dispositions.json)覆盖全部288条来源规格（子代理226，主代理62）；完整来源规格当前3PASS/10FAIL/275NOT_RUN（新增余量反例为独立LOCAL项，不硬套不匹配的原规格），未跑变体与本机局部证据分开。

计划ID20261008；实际执行时间2026-10-09（Asia/Shanghai）。冻结检出85bfe729f2089db2ee48040b450293511e8ce9c7，产品基线main f675416ced73b59144c1f3d327dcdc741608a84e。本报告后续提交只包含证据/测试驱动/账本，不改业务代码。小程序子树17dbc684f86008de4e387b40a36097606907d9ef。

## 实际测试

| 范围 | 本次结果 | 边界 |
|---|---|---|
| npm依赖/build/lint/typecheck | PASS | 联网npm ci首次ECONNRESET；现有缓存offline安装成功，未升级依赖 |
| 小程序运行时 | 389 PASS | 模拟平台与实际产品TS；不证明真人/相机/原生FS |
| API常规 | 256 PASS，14 SKIP | 14 PG根用例随后由13个独立PG套件补运行 |
| 工具 | 86 PASS，24 SKIP | Windows符号链接及Linux shell契约环境缺口，不称PASS |
| 严格PG | 13套，152 PASS，零SKIP | 新建独占容器/库，仅合成资料，逐文件进程和独有schema |
| 精确HEAD QA | 36 PASS，1 SKIP（37项） | 显式85bfe72生成；保留helper/tree/未知组件/原生负例；跳过为Windows dangling symlink能力 |
| Flutter | analyze PASS；706 PASS，15 SKIP | 跳过为errno1314符号链接；未改系统权限规避 |
| 官方离线模板/样式 | 27 WXML＋28 WXSS PASS | MCP单文件请求因没有GUI窗口失败；离线官方wcc/wcsc单独验证，不称模拟器或原生SDK通过 |
| 包 | source＋隔离HTTPS生成包门禁PASS | 622484bytes/124files；没有上传/提审；服务地址TLS握手仍失败 |
| Android | Debug＋optimized unsigned Release BUILD_PASS | 1.0.3/code6，未配置API，未安装；Release无分发签名，不能发布 |
| 合成成对恢复 | 4类表记录与1张合成照片PASS | 实际API+PG+PrivatePhotoStore、pg_dump/pg_restore与文件哈希；不是生产staging-backup.sh或用户数据恢复 |

子代理128/112/21/13/48等重复回归属于独立佐证，不加到主回归独立数量。反例驱动exit0表示“成功证明缺陷”，不是产品PASS。首个驱动准备失败与后续结果分开保存。原始日志、APK、数据库dump、合成图片在E:/Claude_allow/Download/medcial_box/phase1-20261008，Git仅保留必要结构化证据和可复现驱动。

## 已复现缺陷

详见[缺陷清单与最小修复交接](defects.md)，以下优先级为审核评定。

| ID | 优先级 | 确认事实 |
|---|---|---|
| AUD-14 | P0 | 详情页只改余量：盒/粒均变other，批号/有效期/位置清空；有效毫升小数2.345返回400；实际页面方法/解析器/路由/PG，UI边界替身 |
| AUD-01 | P0 | 保存库存提醒开/关均将两条有效批次软删除、条码变null、标签变空；HTTP200/toast成功；阈值本身正确，旧版本409仍有效 |
| AUD-02 | P1 | A家庭退出确认等待期间切身份，随后实际页面用B令牌发leave请求；API平台替身，不声称已实际退出真人B家庭 |
| AUD-03 | P1（组合故障） | 离线注销撤销失败＋持久删除失败后fresh模块冷加载旧token，实际PG /auth/me200；成功服务器注销对照401，未绕过撤销 |
| AUD-04 | P1 | 导出文件写入等待期间logout，实际页面仍dispatch旧家庭原生share调用；wx替身，不声称真实内容已发送 |
| AUD-05 | P1 | 旧计划页面卸载将A草稿写入B身份/家庭key；实际scope模块，不声称B真人已打开旧计划 |
| AUD-06 | P2 | JSON备份写/分享成功后没有unlink或归属清理登记，私有临时文件残留；FS替身 |
| AUD-07 | P1 | 合法1×1 PNG填充到4MiB−1/4MiB/+1，真实路由500/provider0；实际Regex栈溢出；Node24和Node22均复现，128bytes对照200 |
| AUD-08 | P2 | >6MiB JSON真实本地HTTP返回500，不保留413；provider0，属于错误映射问题 |
| AUD-09 | P1资源风险 | 两真实provider完整消费超过2MiB受控响应，缺整体读取上限；未证明真实OOM，阈值政策需在修复前确定 |
| AUD-10 | P2 | fetch成功后的响应体AbortError被当成invalid_json，丢失传输失败分类；不把合成断流冒充实际计时超时 |
| AUD-11 | P2 | context_limit/invalid_json/timeout/model_missing四种提示均被页面覆盖成同一通用错误；loading正常解除，人工药名保留 |
| AUD-13 | P1 | 照片201已提交后丢ACK，实际api.ts重试产生两条ready记录、两个同hash文件，配额70变140bytes；实际页面重试链仅源码核对 |
| AUD-12 | P2 | init=true（与staging配置一致）真实Linux入口SIGTERM退出143，实际Pool.end钩子未调用；无活跃发送排空证明 |

独立复审校验了AUD-01驱动；修正“删除行不存在也可能误判PASS”的测试断言并以v2复验，已软删除批次完整保持。另增加阈值目标值断言；核心丢失FAIL不变。其他页面探针由主代理重复运行确认。R3曾怀疑raw leafletText人工覆盖，但它是只读展示，已排除，不计入缺陷。

## 尚未执行/安全阻塞

- 原生微信FS、真实两微信身份/双手机、真实相机、真正通知到达/分享、设备保数据升级：阶段二NOT_RUN，不能转嫁为本机自动化PASS。
- 真实模型质量：没有冻结并标注的真实样本集；仅只读查询到qwen3.5:4b/9b，未调用模型、下载或更新，不评价识药准确率。
- 生产像素/图像解码、启动器已有服务身份/持续监督、活跃提醒排空：SOURCE_FINDING或驱动缺口；不直接运行固定Owner库/端口脚本。
- test-staging-backup-docker.mjs明确仅GitHub-hosted Linux；本机不伪造CI环境绕过门槛。独立合成恢复仅补充其部分目标。
- Windows符号链接相关跳过必须适合平台补验。当前没有更改用户系统权限。
- 计划status/confirm撤权竞态属于源码风险；追加PG验证被子代理自动安全审查拒绝，理由为可能网络安全风险。未换代理或父代理入口绕过，状态BLOCKED_AUTOMATIC_SAFETY_REVIEW，不能写成已复现。
- 当前HTTPS readiness检查TLS失败/HTTP000，真实服务版本和正式签名未验收；不修改DNS/VPN/代理。

## 资源与交接

所有PG反例和严格测试使用medbox-phase1独占容器/新schema；已校验ID、创建时间、标签、独占新卷并清理。所有新增HTTP监听已关闭；Linux/restore/Node22临时容器已清理；未停止其他项目，未清用户数据。Docker启动后既有容器按重启策略恢复；Ollama只读CLI自动启动其app/server，未请求推理或升级。

代码修复未实施，main未改，未重新安装或上传。修复前必须保留本轮失败和源SHA；取得授权后先库存/身份/导出，再图像/错误/资源与关闭链路，逐项保持同一断言复验并独立审查。新增审计驱动未接入现有CI，CI绿色不能证明这些缺陷已关闭。
