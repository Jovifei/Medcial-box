# 拍照优先录入：本地阶段证据

Jovi 的本地试用指出原录入页字段过多。当前实施工作树仍为 `codex/phone-trial-readiness`；本报告只使用合成图，不包含真实家庭药品或云端照片调用。

## 已验证

- 新录入页将拍照／相册放首屏，名称为唯一必填；批次数量和有效期默认未知。常用单位、日期精度和用途分类可点选，规格、厂家、批准文号、批次号、位置、包装换算及说明书收起。识别结果填草稿，必须再点保存。第二张照片只补空字段或未知日期，保留先前识别值和用户编辑。
- 后端 `POST /api/v1/recognitions/medicine` 校验登录与家庭权限、JPEG/PNG 魔数、Base64 和 4 MB 上限；仅调用配置的识别适配器，不写数据库或持久化原图。缺服务时返回安全 503，前端可继续快速录入。
- 本机 Docker API 显式选择 Ollama `qwen3.5:0.8b`，从容器访问 `host.docker.internal:11434`，无额外模型 API Key。无鉴权调用识别端点返回 401，`/ready` 仍 PASS。
- 合成药盒正面图 `E:\Claude_allow\Download\medcial_box\fixtures\synthetic-medicine-label.png` 最终识别出药名、规格、厂家、批次和 `2027-12` 月精度有效期，未把警示文字当用途；合成侧面图 `synthetic-expiry-side.png` 仅识别日期、名称为 null。热态分别约 5.6 秒、4.3 秒。首次冷启动曾超时；缩小上下文为 8192 后重测通过。早期提示词曾把警示标题误作药名／用途，经提示词约束后合成结果正确，不能据此推断真实药盒准确率。
- `node --test apps/api/test/recognitions.test.mjs` 6/6 PASS；`node --test apps/api/test/medicine-entry-validation.test.mjs` 3/3 PASS，覆盖未知与零、非法小数／尾缀、无效日期和闰日。`npm run typecheck`、`npm run lint` PASS；全仓 `npm test` API 119 通过、1 跳过（默认无测试库连接），工具 3/3 通过。此前真实 PostgreSQL 17 集成测试已独立通过，本轮未重复。

## 尚待完成

- 开发者工具里实际选择图片、草稿呈现、核对和保存尚未核对；真机相机、真实药盒、两账号与 Markdown 分享 `NOT_RUN`。
- 设备日志已证明一次真实识别按钮点击发出请求，但 Ollama 失败后 API 返回 503（耗时约 6.5 秒），此前页面只依赖 Toast，用户看不到持久结果。已增加表单内识别状态面板、统一错误提示；后端增加 JPEG 结束标记／PNG IEND／最小长度检查，异常图片不再直接送入模型。
- 失败根因已进一步确认：Ollama 0.34.2 的 `qwen3.5:4b` 视觉 runner 在图像编码阶段记录 `cudaMalloc failed`、`GGML_ASSERT(ctx->mem_buffer != NULL)` 并返回 HTTP 500。已拉取同系列 `qwen3.5:0.8b`，用同一张合成药盒图片、`num_ctx=2048`、`num_batch=128` 复测返回 HTTP 200，字段识别正确；本地默认模型已切换到 0.8B。
- 开发者工具重新编译后再次点击识别，实际请求返回 HTTP 200，耗时约 4.9 秒；本地 Ollama 显示 0.8B 100% GPU。数据库 medicines/batches 仍为 0，证明结果仍停留在待确认草稿阶段。
- 微信开发者工具 CLI 尝试打开本地项目时返回 `IDE service port disabled`；当前桌面控制接口没有可用的 Windows 原生窗口绑定，因此这一步需要用户在开发者工具“设置 → 安全设置”手动打开服务端口。打开后可继续 CLI 编译/打开验证；在此之前不把页面交互标记为 PASS。
- 本机 Ollama 正监听 `:::11434`，Windows 防火墙存在针对 Ollama 的 Public 入站 Allow 规则。本轮未改动这些规则；仅使用合成图片。在真实家庭药盒照片进入此服务前须限制访问，避免把当前本机模型入口当作私有服务。
- 远端 ECS 为 2 vCPU／2 GiB，无本机 4070 SUPER。需在服务器上压测 CPU OCR 或显式选云端模型；不能用公网暴露本机 Ollama 端口来替代。价格与架构选择见 `docs/architecture/recognition-provider-decision-2026-09-27.md`。
