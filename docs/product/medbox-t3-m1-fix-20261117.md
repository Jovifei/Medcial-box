# T3 首项修复与 1.2.2 小程序候选回执（2026-11-17）

- 依据：小药箱最终方案 v1.0（`docs/product/execution-plan-ux-m1-m5-20261116.md`）§2 T3「只修最卡前两处」与 T1 映射表中唯一确认的源码缺口（M1：刷新失败清空列表）。
- 执行工作区：小程序独立工作区 `E:\project\medcial_box-miniprogram`，分支 `codex/miniprogram-ui-integration-20261109`，HEAD `acc94f2d0e8129c962cadf58c9683495a53a7ab1`（未推送）。
- 说明：T2 真机四步与 T4 五家庭试点依赖业主提供的账号、第二台设备与体验资格，本轮未执行；本轮只完成本地可执行代码项与微信上传。

## 1. 修复内容（M1）

- 首页 `pages/index/index.ts` 刷新失败时，若当前家庭已有成功加载的列表，保留 `allItems/items` 与筛选计数，设置 `errorStale=true`，仅显示降级提示；首次加载失败仍进入原有不可用状态。
- `pages/index/index.wxml` 错误卡区分「暂时无法加载药箱」与「暂时无法更新药箱」，保留「重新连接」入口。
- 回归：`test/home-loading-state.test.mjs` 新增 2 项——刷新失败保留旧列表并标记 stale；成功后清除 stale 并替换为新列表。

## 2. 版本与候选身份

| 项 | 值 |
| --- | --- |
| 修复提交 | `cd0dd85`（修复小程序首页刷新失败清空库存展示（M1）） |
| 版本提交 | `acc94f2`（递增版本到 1.2.2（Android build 21）） |
| 小程序树 | `0b09793f7b9a45414531e05d9c0f7d82e0932cc2` |
| 仓库树 | `71ddd66aa2853a4975c488e01688a6713235db48` |
| 版本 | 1.2.2 / Android build 21 / candidate |
| HTTPS 候选 | `.local-data/mini-staging-cac82c4d-167f-4365-a84b-20fdf0ccd828`，137 文件、892,909 字节，API 基址 `https://medbox.joviluma.com` |

## 3. 验证结果（本轮实跑）

- `npm test`（apps/miniprogram）：**761 pass / 0 fail / 0 skip**。
- 根 `npm run lint`：通过，版本一致性 `1.2.2 / Android 21`。
- 根 `npm run typecheck`：三个工作区全部通过。
- `npm run prepare:mini:qa` + `npm run test:mini:qa`：**42 pass / 1 skip**（既有条件跳过）。
- `npm run check:miniprogram:source`：137 文件、893,048 字节，通过。
- 候选包 `check-miniprogram-package.mjs`（release 模式）：137 文件、892,909 字节，通过。
- 官方 `wcc` / `wcsc`（开发者工具 wcc-exec）对候选 59 个 WXML/WXSS 文件编译：**0 失败**。

## 4. 微信上传与预览

- 开发者工具登录态：`loginExpired=false`，用户 Jovi。
- 上传版本 `1.2.2`，描述「1.2.2候选：首页刷新失败保留上次库存并提示重试（M1）；版本元数据同步 1.2.2」。
- 上传回执：`execution_success`，包体 **697,677 字节**。
- 开发者手机预览推送：`success`，同一包体 697,677 字节。

## 5. 边界与未完成

- 本轮未改 API、数据库、家庭数据；未部署服务端；未合并 `main`；未使用真实药品/家庭数据。
- 未执行：T2 双机双账号真机四步（邀请、录入与找药、识别失败回填、导出与撤权）、T4 五家庭七天试点、体验版设置与平台审核。
- 体验版/正式发布仍需 Jovi 在微信公众平台操作；真机验收需按 T2 就绪清单提供第二台设备、第二微信账号与测试家庭。
- App 分支 `codex/app-ui-integration-20261109` 仍为 `1.2.1 / build 20`；本次仅交付小程序 1.2.2，Android 构建与安装不在本轮范围。