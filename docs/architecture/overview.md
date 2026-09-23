# 技术架构与接口边界

## P0 选型

- 客户端：微信原生小程序、TypeScript，账号批准后用实际 AppID 预览与登录。
- API：Node.js 22、Fastify 5、PostgreSQL 17；同一 API 服务负责微信身份交换、授权检查、数据、图片代理和 Markdown 生成。
- 部署：Docker Compose，用 PostgreSQL named volume 保存数据库；照片的独立持久化目录和备份策略在 P4 服务器设计时配置。
- 契约：`packages/contracts` 发布共享 TS 类型；运行期边界校验由 API 实现阶段增加。
- P0 外部适配器：无真实服务调用。百炼视觉模型和极速数据药品查询作为服务端适配器的首选候选，在 P2 确认可用性、地区与费用后接入。

## 业务边界

- `family`／`membership`／`invite` 表示一个共享家庭和成员授权。
- `medicine` 保存产品身份与分字段的说明书摘要（用途、包装用法、禁忌、注意事项、来源、核验状态）；`medicine_batch` 保存包装、批号、有效期、数量、单位及存放位置。
- `dosage_note` 表示由用户填写的个人使用备注，不从说明书推导。
- 每条可修改记录含版本；写入时带预期版本，陈旧更新返回冲突，让界面重新读取后再确认。
- 每次 API 数据读取与更改必须以已验证会话的家庭成员关系做边界检查。客户端传来的家庭 ID 本身不是授权凭证。
- 数量和日期有显式“未知”状态。未来 API 可使用版本控制字段或 ETag；当前 P0 只实现运行健康检查。

## 识别与资料来源

未来 API 接收用户上传的照片，并创建待确认草稿。识别适配器把图像字段抽取成候选值；药品目录适配器按批准文号优先，结合厂家和规格展示可能匹配项。匹配项和说明书来源分别显示，用户确认／修改后才保存。若药品说明书未公开、接口不可用或匹配有歧义，允许补拍说明书或手工维护库存，且将缺失、未核验、用户确认、来源匹配区分开。

百炼密钥、药品 API 密钥、微信 AppSecret 只能由 API 容器读取。图片采用私有目录；后端授权后通过受控端点访问，不暴露静态公开 URL。日志不写入图片内容、会话密钥和家庭剂量信息。

## 当前与预留 API

### P0 已实现

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/v1/health/live` | API 进程存活，不依赖数据库。 |
| GET | `/api/v1/health/ready` | 执行 `SELECT 1`；连接失败返回 503，错误细节不泄漏。 |

### 后续阶段预留

- `/api/v1/auth/wechat`：服务端通过微信登录凭证换取平台用户标识，再签发本应用短期会话。
- `/api/v1/families` 与 `/api/v1/families/invitations`：家庭创建、邀请和成员管理。
- `/api/v1/medicines`、`/api/v1/medicines/{id}/batches`：资料、批次和带版本的更新。
- `/api/v1/recognition/drafts`：上传图片、识别和药品目录检索形成草稿，确认与写入分开。
- `/api/v1/exports/markdown`：按权限和导出开关生成 UTF-8 文本，默认包括已确认的说明书摘要；个人剂量备注需单独选择。

小程序把返回文本写入本地临时文件，再用 [`wx.shareFileMessage`](https://developers.weixin.qq.com/miniprogram/dev/api/share/wx.shareFileMessage.html) 分享；文本复制作为替代路径。该微信 API 使用本地／临时文件路径。Markdown 后缀支持性尚未以真实客户端验证，P3 验收须记录微信系统版本与结果。

预留接口要在对应阶段定稿。本阶段不宣称实现了这些接口。

## 数据库迁移

API 在启动前按文件名顺序应用 `apps/api/db/migrations/` 内的 SQL。应用在 PostgreSQL 事务与 advisory lock 内执行每个迁移，并保存 SHA-256 校验值；已应用迁移内容改变时拒绝启动。初始化 SQL 可安全重复创建迁移台账。Docker PostgreSQL 首次建卷时执行 bootstrap；后续升级由 API 迁移 runner 执行。

## 信任与失败边界

- Readiness 只确认数据库可查询；不代表小程序登录、模型识别或药品数据 API 已验收。
- `/live` 报告进程状态；`/ready` 报告是否能接入数据库。数据库异常只返回通用 503。
- 第三方药品信息只是参考；说明书不完整或身份有歧义时保持待核验，绝不从模糊匹配生成用法。
- P0 的单元测试使用合成数据库依赖，不冒充 PostgreSQL 联通证据。
