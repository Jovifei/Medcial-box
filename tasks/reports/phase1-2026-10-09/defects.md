# 已复现缺陷与修复交接

基线85bfe72（产品f675416），未改业务源代码。修复仅为候选建议，需业务修改授权；不新增功能或改产品目标。

| ID | 精确源码锚点 | 已执行证据 | 最小修复方向/必须保持的断言 |
|---|---|---|---|
| AUD-14 | medicine-detail.ts839；inputs.ts239、309；repositories/batches.ts260起 | quantity-panel-results.json | 数量更新必须保留单位/批号/expiry/位置及其他非目标字段；明确batch PUT完整/部分语义，复用完整batch快照构造或提供数量专用接口；盒/粒整数和ml小数都保持同断言 |
| AUD-01 | medicine-detail.ts562-572；inputs.ts439-469；medicines.ts183-185 | pg-threshold-v2-results.json | 库存提醒请求必须保留非目标字段与批次；明确PUT整体语义与省略/显式[]区别；开关、并发、rollback、旧软删批次原值保持 |
| AUD-02 | family-settings.ts67-71 | identity-probes＋parent rechecks | 在确认前捕获原会话/家庭代次，等待登录/弹窗后重新核验；旧意图不能dispatch新身份操作 |
| AUD-03 | api.ts101-125；session-scope.ts18-48；auth.logout | pg-logout-results.json | 持久身份失效失败需fail-closed或可恢复警告，不宣称已持久注销；离线+存储故障冷启动与服务撤销成功401对照均保留；不可声称保证服务端离线撤销 |
| AUD-04 | export-preview.ts84-87、186-194 | export-session-share-probe＋parent rechecks | 请求/文件租约绑定账号/家庭代次；native dispatch前与fallback await后重查；清理只删登记原件 |
| AUD-05 | plan-detail.ts99-101、379-381 | plan-draft-scope-probe＋parent rechecks | 草稿写入绑定页面创建时的ownerKey与scope，不能卸载时用新scope写旧内容；旧数据可隔离不全删 |
| AUD-06 | backup-restore.ts45-60 | backup-file-probe＋parent rechecks | 共用已有导出文件归属/租约/cleanup恢复模块；成功、取消、失败、中断均测；不删用户主动分享副本 |
| AUD-07 | routes/recognitions.ts29-30 | valid-image-results（Node24与Node22） | 用线性扫描/长度前置边界替代栈风险regex；合法4MiB图可以到provider，+1正确4xx且零调用 |
| AUD-08 | app.ts44-48 | http-results.json | 保留框架413/合理4xx并脱敏；inject和真实listenHTTP两层断言 |
| AUD-09 | medicine-recognition.ts26、139、181 | recognition-runtime/results.json | 冻结上游读取字节预算，流式累计拒绝/取消，不在整段text/json后才截断；正常、超限、断流、下一次正常均验 |
| AUD-10 | medicine-recognition.ts138-145、180-186 | recognition-runtime/results.json | JSON语法错误与body传输错误分别分类；已有timeout/failure规则贯穿body阶段，不将AbortError自动等同实际elapsedtimeout |
| AUD-11 | medicine-edit.ts1353-1354 | page-error-results.json | 使用已脱敏且可行动的分类提示；不露内部堆栈，人工字段、loading和重试正断言保留 |
| AUD-13 | api.ts241-252；medicine-edit.ts1820-1842；leaflet-photos.ts生成randomUUID处 | photo-upload-ack-loss-results.json | 稳定上传意图键＋服务端回执/负载绑定；ACK丢失或客户端持久失败后重试不新增照片/配额，不能仅按图像hash跨用途误去重 |
| AUD-12 | server.ts27-45 | linux-lifecycle-init-results.json | 为生产入口加入受控SIGINT/SIGTERM close链路并复核scheduler drain；池关闭hook实际触发。当前只证明空配置SIGTERM不调用pool.end，不证明活跃发送问题 |

文件路径以apps/miniprogram/pages、services及apps/api/src相应目录为准。节点行号以冻结源SHA为准；改动后重新定位，不沿用旧行号当新证据。

## 仅源码/部分观察风险

- 隐私告知“未保存草稿仅本机”与识别传输的表述不一致：medicine-edit.wxml32及medicine-edit.ts1266。需告知/数据流对照，未判法律违规或真实私照上传。
- 图像像素/解码预算：128bytes非法巨像素envelope可到stub provider，只证明路由未解码，不证明模型接受或内存耗尽。
- start-local-trials固定Owner资源和mode-only复用：未执行原库/原端口生命周期故障；不能直接去杀已有服务。
- plan status/confirm的授权读取与写入竞态：SOURCE_FINDING；自动安全审查阻止追加验证。无复现，不计入上述13项。
- CupertinoIcons字体构建警告：BUILD_WARNING；没有真机缺图证明。

## 修复后回归

先冻结包含源码补丁的新本地提交，再生成HEAD QA；不能拿本次85bfe72结果替代。复现驱动exit0只是证明旧缺陷，另建立以正确业务不变量为目标的常规回归；不要简单删除旧探针或变更期望把FAIL变绿。严格PG、整小程序、API、工具、Flutter及生成包正反门禁都复验；真实SDK/真人/正式签名分别等待验收。
