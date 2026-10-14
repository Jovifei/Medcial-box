# 主线整合与清理 · 2026-10-14

Jovi已明确授权功能合并到main并处理冗余分支、旧文件。本轮在E:\project\medcial_box执行，不新建C盘worktree，不部署，不更改家庭、成员、照片、私有配置或凭据。

## 整合依据
- 起点PR5/本地49dc9e7e4583d97d3f251a1b606e1dc2e34a2336，origin/main f675416，相差140个祖先提交。
- PR3的17f0854、PR4的ef11502及旧two-stage-audit都已包含；统一通过最新候选进入main，避免把旧分支重复merge。
- 旧local-delivery-handoff分支有9个独有提交（含merge），最后巨型提交含583项生成/归档产物及照片路径。已查对应trial鉴权、识别错误和catalog实现，无必须提取的额外功能证据。它只作本地归档，不整包合入或发布。
- 本轮开始43份dirty/untracked文件已复制并核SHA256，全部Git refs与linked-worktree清单及all-refs.bundle保存在E:\Claude_allow\Download\medcial_box\consolidate-20261014。没有reset/clean/stash、强推或覆盖冲突。

## 修正与清理
- 底部导航使用25条路由明确fallback，有栈时按最近主tab高亮；attached/show刷新。保留原native按钮、busy、草稿保留、失败留页和家庭隔离。
- 四入口25%等分、单行居中、最小96rpx、安全区及编辑页保存栏共存；移除无依据!important。默认文字#52685c与原生tabBar一致。
- 删除未被调用的inferPurposeTagsFromText/inferPurposeCategory，避免已关闭的关键词猜用途回流。结构化识别标签和人工确认保留。
- 开发API默认保持loopback，线上HTTPS配置由prepare-miniprogram生成。不能通过让合成测试访问真实药箱服务来消除连接报错。
- 删除scripts/fixtures下4个完全未引用、已不符合真实产物门禁的声明式JSON。有效损坏/缺文件/丢内容/归属/迁移负例、QA adapters及审计driver/hash保留。
- 本机reports、未核验的medicine-catalog-local.json和未审核运维runner保留并显式排除Git；它们不是产品代码，不加入main，不擅自停止GPU或删除socket。
- 当前状态统一到tasks/status.md及README。18–23是历史接力记录，不能把其中旧“不合main”限制或旧测试计数当作当前结果。

## 验证口径
新组件VM覆盖25路由/最近tab/show/异常栈/草稿guard/颜色与布局；本机整合验证、精确mini树及GitHub最终CI须针对本次候选，不能继承49dc计数。父代理与只读独立审查确认无新增wx/fs/network/component类型、照片生命周期helper无改动。仅登记经审查的精确mini树47da77d6837a751426aa81cbf29b77646c2f2896，未知能力负例不放宽。

合并采用保留完整历史的主线整合；精确提交、CI链接及已删除分支的最后SHA记录在本次GitHub集中回执和本机consolidate备份中。新main必须包含所有保留功能，E原目录最终使用main；删除分支前核其HEAD为main祖先，不删除未处理的独有历史。

## 当前仍未完成
1. 2026-10-14只读检查HTTPS health/ready为ok/databaseconnected，服务器仍medbox-api:pr3-1867792；最新源码未因此部署。旧部署脚本准备自动审批拒绝仍BLOCKED，不改工具/拆命令重做。
2. 手机与服务端版本/迁移一致后才可保数据更新；两账号双设备邀请/加入/显式切家庭、首页出口、拍照到可编辑待确认草稿仍需实际验收。两个现有家庭及数据不删不合并。
3. 真实消息送达、系统分享、正式Android签名/同签名升级和目标环境成对恢复未全验。Flutter未因小程序1.0.4而变成同版本UI。
4. 旧额外status/confirm在途撤权实验保持BLOCKED；源码/正常CI通过不验证或解除该实验。旧工作区创建能力拒绝不再重试。
5. 旧原ChatGPT集中复审结论此前未确认；本次代码和主线合并授权来自Jovi，不把已送达请求当作独立批准。

本次完成标准是代码主线归一及确证冗余清理，项目仍PARTIAL；main合并不等于正式上线或完整家庭试用交付。
