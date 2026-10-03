# 本地微信小程序导入与编译验证

日期：2026-10-03（Asia/Shanghai）  
源码基线：`codex/flutter-ui-prototype` / `736d7623435e2a38e3ebb51859574d43dffa0120`

## 结论

**本地代码与模板编译通过，隔离项目生成并被微信开发者工具 CLI 接受打开；页面人工交互和小程序到本地 API 的完整联调未通过验证。** 本次没有向腾讯上传或发布小程序。

## 执行与结果

| 检查 | 结果 | 证据边界 |
|---|---|---|
| 小程序单元/运行时测试 | PASS：220 项通过，0 失败、0 跳过 | Node 合成/适配器测试，不是真实微信账号或设备。 |
| ESLint | PASS：`npm run lint --workspace @home-medicine/miniprogram` | 静态检查。 |
| TypeScript | PASS：`npm run typecheck --workspace @home-medicine/miniprogram` | `tsc --noEmit`，不检查真实微信运行时。 |
| 微信模板/样式编译 | PASS：`npm run check:miniprogram`，官方 `wcc`/`wcsc` 编译 51 个文件 | 本机安装了微信开发者工具编译器；不替代模拟器点击或手机验收。 |
| 隔离小程序目录 | PASS：`npm run prepare:mini -- --appid <药箱AppID> --api-base http://127.0.0.1:13301 --local` 生成 `.local-data/mini-local-<UUID>` | AppID 是客户端公开标识；生成目录不复制私有配置，不修改源 `project.config.json`。 |
| DevTools 导入 | CLI 返回 `IDE server has started` 和 `√ open` | 表示项目打开命令被接受；本次无法观察页面渲染或逐项点击，因此 UI 交互为 NOT_RUN。 |
| 本地 API 容器健康 | PASS：容器内 `GET /api/v1/health/ready` 返回 200，数据库 connected | 只证明容器网络内服务和数据库健康。 |
| Windows 到 API | BLOCKED：`127.0.0.1:13301` 已建立 TCP 连接但 HTTP 请求返回空响应；Windows 客户端拿不到 `/ready` 响应 | 小程序页面无法据此完成登录、家庭和数据 API 端到端流程。没有改 Docker 网络或系统代理。 |

隔离容器原已运行，本次未重建、停机或改动数据库。诊断发现 API 监听 `0.0.0.0:3000`，容器自身回环 readiness 为 200；Docker 映射为 `127.0.0.1:13301 -> 3000`，但本机 HTTP 转发没有返回响应。故当前只能把本地交付标为**编译和导入通过，接口联调待恢复**。

## 复现命令

~~~powershell
npm test --workspace @home-medicine/miniprogram
npm run lint --workspace @home-medicine/miniprogram
npm run typecheck --workspace @home-medicine/miniprogram
npm run check:miniprogram

$miniAppId = (Get-Content apps/miniprogram/project.config.json -Raw | ConvertFrom-Json).appid
$miniProject = node scripts/prepare-miniprogram.mjs --appid $miniAppId --api-base http://127.0.0.1:13301 --local
& "E:\AI_Tools\Other\WeChatDevTools\cli.bat" open --project $miniProject
~~~

本次另核对了提交 `736d762` 的 GitHub Actions 工作流：[run 37107940730](https://github.com/Jovifei/Medcial-box/actions/runs/37107940730) 显示状态 **Success**，包含 `verify` 和 `flutter` 两个作业。GitHub 注记了 Node 20 action 运行时弃用及 `ubuntu-latest` 后续迁移提示；这些注记未使本次运行失败。

## 后续

1. 先修复/恢复 Windows 到本地 API 的回环转发，再以隔离测试数据检查登录失败态、家庭入口和小程序 API 请求。
2. 在开发者工具模拟器中人工逐页核对页面状态；随后用两名真实账号和两台手机验收。
3. 真正小程序体验版上传、真实微信登录/提醒模板、ECS HTTPS 部署和数据库/图片恢复均须另行记录；本报告不表示这些项目已通过。