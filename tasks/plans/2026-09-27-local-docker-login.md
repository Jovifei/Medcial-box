# 本地 Docker 与微信登录验收

Jovi 确认顺序：先本机 Docker 部署、检查数据库和小程序登录；本地通过后再部署 ECS。本轮只操作本项目专属容器、卷、端口和 Git 忽略配置，不启动、停止或改动其他项目资源。

## 当前事实

- Docker Desktop Linux Engine 已可访问；其他项目容器正在运行。
- 本机 `3000` 端口已被占用，因此家庭药箱使用独立回环端口。
- 本项目需要 Node 22 和 PostgreSQL 17 镜像；本机目标标签尚未缓存。
- AppID 已知；微信 AppSecret 由 Jovi 在本机私有配置中填写，不进入聊天、源码或小程序包。

## 执行与验收

- [x] 创建本地 Git 忽略环境文件，生成独立数据库密码，填写已知 AppID；Jovi 已在本地填入唯一的微信 AppSecret，校验格式后仅重建本项目 API 容器。
- [x] 准备本项目独立 Compose 项目、卷和空闲回环端口；先核对解析后的配置，不触碰其他容器。
- [x] 准备需要的容器镜像和后端构建，启动本地 PostgreSQL 与 API。
- [x] 验证两个容器健康、迁移台账、`/live` 与 `/ready`；检查数据库不会暴露公网。
- [x] 使用已填入的 AppSecret 验证开发者工具真实微信 code 登录：后端 `/api/v1/auth/wechat` 返回 200，真实 PostgreSQL 新增用户与会话各 1。真机登录另列 `NOT_RUN`。
- [x] 更新 `tasks/todo.md`、`tasks/status.md` 与本地阶段验收报告；本地真实登录通过前不执行远端部署。

## 证据边界

本地 API 健康和 PostgreSQL 不等于微信登录通过。没有实际 `wx.login` 返回的 code、有效 AppSecret、微信开发者工具或真机，不标记真实登录 PASS。远端 ECS 部署保持 NOT_RUN。
