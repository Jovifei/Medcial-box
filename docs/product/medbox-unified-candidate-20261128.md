# 小药箱统一候选复测记录

本轮由 Jovi 授权整合最新小程序、App 已有功能及说明书补丁，补齐 UI 和 Android 测试依赖。本文记录本地实际运行结果，正式合并、部署、微信上传和真机验收分别保留门槛。

## 候选与工作区

- 程序候选为 cb30fe1ca6cd32a89d9c68756f06e6d45e73ee8d，完整树 f977c0f5fa6b850568f7c6ae089dd606bb3c09d0。
- 小程序树 95620238e3e5904fb1b4820e26a0076978ecfc27，Flutter 树 b4652f51013c2fae52e68f70edd778de2d954c60，API 树 c51e2999c070abfad7de00e104d9c4f57e518e6c。
- 新候选保持 1.2.5 / Android build24 / candidate，未分配新正式版本。
- 独立目录为 E:\AI_Tools\Codex\worktrees\medbox-unified-20261128-0f3fc479\source。原 App 与小程序工作区及未提交改动均保留。
- [PR #18](https://github.com/Jovifei/Medcial-box/pull/18) 汇总变更编号 MEDBOX-20261128-01 至06。原功能来源为小程序9ce0594、App88191bb和主线d64ba124。
- 收尾文档提交不改变上述程序子树；最终 PR HEAD 与程序候选的对应关系由外层 candidate-manifest.json 固定，禁止把文档提交描述成重新构建了二进制。

## 修复和独立审查

空说明书显示“说明书未提取，可重拍或手动填写。”，保留手填内容和既有识别结果；重开小程序草稿可恢复新旧空结果提示，兼容照片移除和旧数据缺 warnings。识别只生成建议，人工确认前不创建库存。

小程序计划页在320px和双倍字号下将完整日期独占一行，两个切日按钮各保留48px触控范围；底部原有可缩放留白保留。320/390px、100%/200%四组几何检查通过，滚到列表底部时末项和安全提示可访问。浮动按钮在其他滚动位置可能覆盖经过它后方的可滚动内容，未宣称所有滚动位置均无覆盖。App 计划页四项 Widget 用例通过，未为没有复现的问题扩改 App 业务布局。

独立只读复核上述说明书、草稿、CSS与TokenHub合并差异，在指定范围未发现有足够源码证据的新增P1/P2。QA云接口模拟另经作者加固和主代理独立验证，只接收固定合成请求，原生能力哨兵零调用。它是审核固定源码的测试插桩工具，不能作为通用不可信JavaScript沙箱。

## 实际测试结果

| 检查 | 本轮结果 |
| --- | --- |
| 小程序全量 | 803通过，0失败，0跳过 |
| API全量 | 563通过，0失败，0跳过，使用新建专用空PostgreSQL17.11 |
| Flutter全量 | 927通过，0失败，19跳过 |
| Flutter analyze | 退出0，无问题 |
| 根 lint / typecheck / build | 均退出0 |
| 最终工具门禁 | 235通过，0失败，30跳过 |
| 精确小程序树QA | 生成与验证通过，受限云模拟启用 |
| 微信官方编译 | 29个WXML及30个WXSS全部退出0 |
| Android原生 lint | 实际 :app:lintDebug 退出0，含全部插件测试lint模型；33.8秒，日志android-lint-completed.log |
| 隔离Android APK构建 | 退出0，版本/构建号/签名实际读回 |
| GitHub同SHA CI | verify、backup-docker、flutter、candidate-delivery四项通过 |
| API镜像隔离启动 | 37项迁移，live/ready均200，版本与SHA一致 |

Flutter的19项跳过与Windows工具的30项跳过未计为通过。工具跳过主要是符号链接限制及Linux shell契约，Linux相关项由本候选backup-docker CI另行运行。Android lint 会构建插件的单元/设备测试lint模型，不能将其记成已经运行设备测试。

固定程序提交的 [CI run 46167554314](https://github.com/Jovifei/Medcial-box/actions/runs/46167554314) 四项均成功。收尾文档后的最终PR HEAD须再取同提交检查结果，不能用旧提交CI替代。

Android本地生成配置的两个PropertyEscape错误已修复，保留1.2.5/build24，SDK与Flutter路径实际指向未变。重新执行App lint分析和报告后，XML为0错误、3警告。三项警告为旧v21资源目录、旧ic_launcher未使用及启动图标方形填充，列为后续维护项。原失败与增量旧报告均保留。

Android依赖的固定版本未改动，未关闭任何测试或质量门禁。缺少的Mockito、AndroidX、Robolectric、Kotlin测试变体及传递依赖先进入获准下载目录，再经官方校验值核对后导入本轮E盘Maven仓库；清单保存GAV、来源、摘要与路径。所有测试使用进程级E盘临时目录和缓存。AGP/Kotlin旧插件弃用提示仍存在，未为消除提示扩改依赖版本。

## 数据库隔离和部署试验

API全量使用新建tmpfs空库。测试前确认用户表为零、无额外schema，应用角色无superuser、createdb、createrole、replication或bypassrls权限。563项结束后残留用户表及测试schema为零，专用容器已回收。

另用已构建API镜像与第二个新建空库做启动试验。PostgreSQL使用Docker none网络，API共享该容器网络命名空间，外部无出口、无宿主端口发布。启动自动应用37项迁移，live/ready返回1.2.5与cb30fe1完整SHA，家庭、药品、批次三表均零。该试验的容器已回收，无照片、账号或正式数据。首次试验因本机Docker默认地址池耗尽未启动网络，随后改用none网络；一次断言误用了batches表名，修正为medicine_batches后完整复跑，原失败日志保留。

API镜像使用缓存node22-alpine基础镜像和根锁文件的166个已验证npm缓存包，以network=none构建。外层缓存构建配方只增缓存挂载和npm离线标志，源码Dockerfile未修改。未以构建成功声称生产已部署。

## 已核验产物

| 产物 | 身份与用途 |
| --- | --- |
| Android隔离测试包 | JF-medbox-1.2.5-build24-isolated-cb30fe1.apk，219913440字节 |
| APK SHA-256 | 5ce544c4be22735d57079cab130f9c8a464f3c590bc831c3aa3dd9e08b57dec3 |
| APK包名 | com.joviluma.home_medicine_flutter |
| APK签名SHA-256 | 9ab144e824abf26a5941819abb06831288c36a8bfe622657e3dc9d88281fc774，与现有build20测试包相同 |
| App运行配置 | Debug、LOCAL_APP_TRIAL=true、API http://127.0.0.1:13307 |
| 小程序候选 | artifacts/miniprogram-final/project，HTTPS地址medbox.joviluma.com，仅生成及编译，未上传/真实访问 |
| API源码构建上下文 | api-build-context-cb30fe1.tar.gz，SHA-256 e0c953dcb949b34ae08692009ee833213a8965d518bc6cf460861a2f429f5672 |
| API镜像 | medbox-api-candidate:cb30fe1ca6cd，sha256:3256cc12ad44cec45d13908b9ffb40d4fbd8dad82d3e78f730bf904c78f88740 |

产物位于上述独立目录的父目录artifacts，证据在父目录evidence和logs。debug.keystore仅使用已有文件参与签名，未复制、导出或生成新密钥。手机端现有包1.2.1/build20仅只读查询，未执行安装、卸载或清除数据。旧的1.0/build1误配置产物已标记为失败证据，不可安装。

安装测试包要求独立的local-app-trial服务和USB反向转发，仅指向当次已确认的空测试库。外层manual-qa/start_isolated_app_test.py已准备该入口，--smoke实跑通过空库、角色、37项迁移、试用标记和零业务行断言，随后回收。识别、登录与资料查询使用合成适配器，fetch明确拒绝外部HTTP；它本身不运行adb。独立审查提出的监听前门槛和中断回收问题已修复；正常烟测和“创建成功但CLI未返回ID”的受控故障均验证回收完成。强杀或Docker延迟创建仍须按本次随机标识复核，未宣称所有异常均可自动回收。现有dev:local-trials启动器会复用旧库并选择本机Ollama，本轮未运行它，也不能把它直接当本轮空库入口。服务缺少local-app-trial标记时App会拒绝该试用登录。不得连接正式库进行试装。

## 未完成项与后续顺序

| 优先级 | 待完成 | 进入条件与验收 |
| --- | --- | --- |
| P0 | 最终PR的独立审批与主干合并 | 最终HEAD必过检查、原改动归属保全、Owner人工门槛；合并后取实际SHA重新出包 |
| P0 | 真实说明书识别→人工确认→隔离入库→回读 | 获准测试文件和预期字段；每次重新确认专用空库、受限角色/schema；确认前库存零写入 |
| P0 | 手机安装及微信双平台走查 | 先准备隔离local-app-trial服务；同签名保数据升级、新装、重启、权限拒绝、大字体/键盘/安全区、双账号隔离与弱网 |
| P0 | 真实部署准备及平台门槛 | 备份恢复/回滚证据、告警触达、微信隐私/合法域名/体验资格、部署目标和正式签名，按既有人工作业授权 |
| P1 | 云端失败自动转4070 | 当前TokenHub只有同供应商第二模型，Ollama仅可显式选择；自动GPU回退未实现且通道运行未验，不得承诺持续可用 |
| P2 | 项目管理台上报 | 新共享克隆被bound_report判为未登记仓库，保留失败证据；不得冒用原工作区身份上报或擅改登记 |

本轮真实药品识别模型调用次数为零。合成识别与隔离数据库测试不能替代真实供应商、药品字段准确率或4070通道验收。生产、正式库、家庭库存及账号未访问或更改。

## 证据与回退

外层根目录identity.json和evidence中的candidate-manifest.json、apk-manifest.json、api-image-cached.json、api-image-isolated-smoke.json、isolated-pg.json、official-final-mini.json、flutter-full-summary.json及github检查记录固定实际身份。logs保留失败和成功运行，依赖清单在android-support/dependency-manifest.json，UI几何和两张截图在evidence/ui。

功能回退通过新提交逐项引用原变更编号，禁止改写共享历史。部署回退仍使用实际部署时确认的旧镜像与备份；本轮没有生产变更。原工作区和既有数据均保持原状。
