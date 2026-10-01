# 微信开发者工具模拟器实跑报告（2026-10-02）

> 触发：用户提供药箱专用 AppID（`wx1f6dd99d28aab8e5`）后，要求在本机微信开发者工具中完整跑一遍。
> 结论：**模拟器内全链路实跑通过**——真实 `wx.login` 换码（开发网关）→ 建家庭 → 录药 → 详情 → 创建用药计划 → 今日安排确认服药 → 计划详情历史 → 版本说明。console 无错误，数据库逐条核验一致。

## 一、环境与通路（本机首次打通）

| 组件 | 状态 |
|---|---|
| `wechatide` CLI | ✅ 可用（旧 `cli.bat` 走 `reg.exe` 被黑名单拦截；新的 `wechatide.cmd` skill 通道不受影响） |
| CodeBuddy 客户端授权 | ✅ 已在开发者工具内确认（`wechatide auth`，端口 45612） |
| 工具登录态 | ✅ `loginExpired:false`，登录用户 Jovi；`versionRelation:equal`（skill 0.3.11） |
| 项目导入 | ✅ `jovi-home-medicine-cabinet`（AppID `wx1f6dd99d28aab8e5`） |
| 本地 API | `scripts/dev-simulator-server.mjs`（本次新增）：真实 API 代码 + 真实 PostgreSQL（`medbox_dev`，迁移 001–018 全量落库）+ 开发网关（任意 code → 固定 openid） |
| 域名校验 | `project.private.config.json`（gitignored）`urlCheck:false`；联调期间 `services/config.ts` 临时指向 13300，**跑完已恢复 3000** |

注意：本机 3000 端口被**其他项目**的服务占用（返回 302 → /login，非本仓库 API），联调服务器改用 **13300**。

## 二、实跑步骤与证据（截图见 `assets/simulator-run/`）

| # | 步骤 | 结果 | 证据 |
|---|---|---|---|
| 1 | 6 个主页面整包编译打开 | 全部 `success:true` | — |
| 2 | 登录页渲染 | ✅「把家里的药，记在一起」 | 01 |
| 3 | 点击「使用微信登录」→ 真实 `wx.login` code 经开发网关换 token | ✅ 200（网络日志：真实 code `0b3fJb0w31…`，35ms） | 02 |
| 4 | 创建家庭「Jovi 的家」 | ✅ 成为管理员 | 03 |
| 5 | 首页四 Tab + 筛选 chips + 状态卡 | ✅（药箱/用药计划/待处理/我的） | 03 |
| 6 | 录入面板四入口 | ✅ 拍照/相册/手动/扫码（R2-c） | 04 |
| 7 | 手动录入「布洛芬缓释胶囊」保存 | ✅ 首页卡片出现，状态 chip 联动（待补资料 1） | 05 |
| 8 | 药品详情 | ✅ 批次快捷操作（修改余量/标记开封/新增批次）+ 折叠区（说明书与来源/个人备注/低库存）（R2-d） | 06 |
| 9 | 用药计划页 | ✅ **服药提醒卡诚实文案**：「模板尚未在药箱专用账号下配置；计划与今日安排仍可正常使用」（R4-b） | 07 |
| 10 | 创建计划（我自己 + 布洛芬 + 每次 1 粒饭后 + 每天 08:00） | ✅ 照护对象自动建立 | 08 |
| 11 | 今日安排懒物化出 08:00 实例（未确认） | ✅ | 09 |
| 12 | 点「已服用」→ 状态变 已服用，出现「改为已服用/改为跳过（纠正会保留操作历史）」 | ✅（R3 纠正链） | 10 |
| 13 | 全部计划（状态筛选：全部/进行中/已暂停/已结束）+ 暂停按钮 | ✅ | 11 |
| 14 | 计划详情：诚实改期提示 + 服药记录 `2026-10-02 08:00 已服用·家人` | ✅（R3 历史） | 12 |
| 15 | 我的页四分组（家庭与照护/提醒与设备/…） | ✅ | 13 |
| 16 | 版本说明 0.2.0-s0s1r1（3 条 notes） | ✅（R4-c） | 14 |

## 三、服务端核验

```sql
-- medbox_dev
布洛芬缓释胶囊 | 2026-10-02 | 08:00:00 | taken | taken | 2026-10-01 17:23:03+00
```

- `dose_occurrences` 懒物化 1 行（slot_id+dose_date 唯一），`dose_confirmations` 事件 1 条，与界面一致。
- 模拟器 console 终查：无 error/fail（已排除陈旧构建期的 3 条 auth/me 404）。

## 四、发现并修复的问题

1. **`dist/` 陈旧导致 `GET /api/v1/auth/me` 404**（真机页面报错「请求失败（404）」）：联调服务器首次用的是旧构建，源码路由早已存在。重新 `npm run build` 并重启后恢复。**教训：任何基于 `dist/` 的本地运行前先构建。**
2. 本机 3000 端口被其他项目占用——联调端口固定为 13300（脚本参数可改）。

## 五、复现方式

```bash
# 1. 启动开发库（已存在 medbox-pg-test 容器）并迁移
docker exec medbox-pg-test psql -U postgres -c "CREATE DATABASE medbox_dev"   # 首次
DATABASE_URL=postgres://postgres:medboxtest@127.0.0.1:55432/medbox_dev node apps/api/dist/migrate.js
# 2. 构建并启动联调服务器
cd apps/api && npm run build && cd ../..
DATABASE_URL=postgres://postgres:medboxtest@127.0.0.1:55432/medbox_dev node scripts/dev-simulator-server.mjs 13300
# 3. 小程序端：services/config.ts 指向 http://127.0.0.1:13300（跑完恢复 3000）；
#    project.private.config.json 设 urlCheck:false（gitignored）
# 4. 开发者工具内编译打开即可完整走查
```

## 六、边界与剩余

- 开发网关把任意 code 映射为同一 openid——**仅本机联调**，多账号/双手机仍需真实 AppSecret（code2session）。
- 真实订阅消息送达、真机预览二维码、上传体验版未做（需 AppSecret/模板 ID/发布授权）。
- 联调服务器跑完保持后台运行（13300），可直接在开发者工具继续手动走查；注意**重新编译前需把 API_BASE 再指到 13300**。
