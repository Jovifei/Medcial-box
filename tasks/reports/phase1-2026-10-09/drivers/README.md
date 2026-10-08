# 复现驱动使用边界

保存的是实际使用的驱动，不改业务实现。部分保留本机绝对路径，需在相同冻结隔离检出或显式审查路径适配后执行；不得把新HEAD/旧dist套入旧结论。

PG驱动需先重新创建**全新独占**localhost PostgreSQL并核验容器ID/创建时间/标签/独占卷；读取本机私有private-resources.json内url/user/password，文件不入Git。上轮容器已清理、凭据已从资源记录移除，直接运行会因前置不足失败，不能指向原有Owner库替代。isolatedPostgres会创建和删除自己新schema，既有集成有TRUNCATE users CASCADE，必须专用数据库。

API dist必须先新鲜build。方法抽取/实际TS page harness只替换wx、网络和存储边界；PG驱动另说明实际路由和SQL。签名/模型/手机不由此验证。

对缺陷的assert脚本exit0表示复现成立，不是产品行为PASS；本轮product verdict在结果JSON/README明确FAIL。paired restore源脚本最初有SQL引用/目标重复的准备失败，已修正驱动并新路径重跑，旧失败JSON保留。源脚本文件hash在results.json；不应靠修改断言掩盖问题。

Linux驱动只绑定本轮checkout与新audit目录，网络仅共享本轮测试PG容器；空模型/消息配置，不访问第三方；init=true匹配staging compose。不要重用任何已存在项目容器或移除同名未知资源。
