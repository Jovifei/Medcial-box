# 2026-10-28 本机 Docker Desktop 启动后异常记录

## 实际动作

本轮为了恢复隔离 Linux Docker 测试，先观察到引擎管道不存在、Windows Docker 服务为 Stopped、WSL docker-desktop 为 Stopped。随后本代理执行了 `Start-Process` 启动本机 Docker Desktop，使用隐藏窗口。没有通过本代理的工具点击 Docker 错误对话框中的任何按钮。

## 可见日志

Docker Desktop 日志显示本次启动时间为 2026-10-28 20:59:27（北京时间），后端于 20:59:41 退出。后端日志在 20:59:36 记录 `actionButtonClicked`，上下文为 `Reset to factory defaults`，随后记录 `resetting the application` 和 `application reset complete`。Jovi 随后确认是他点击的按钮；本代理没有点击。它发生在本代理发起启动后，不能单凭文字确定数据是否丢失。

日志记录启动失败是无法访问 Docker 自身运行目录中的 `sailor-ingest.sock`；重置过程记录删除 extensions、buildx、cli-plugins 和 Docker agent 数据目录的动作。这些记录不证明容器镜像或卷是否完整，后续需分开检查。

## 当前只读观察

- WSL 列表仍有 docker-desktop，状态 Stopped；Docker Linux 管道不可访问。
- `C:\Users\Admin\AppData\Local\Docker\wsl\disk\docker_data.vhdx` 仍存在，大小 121248940032 字节，最后修改时间为 2026-10-27 21:49:01。文件存在和时间不证明其内容可恢复或完整。
- 本轮未对该磁盘文件做写入、迁移、删除或恢复操作，未再次启动 Docker。生产服务器独立，本轮仅做过生产只读预检，没有生产停服、备份、迁移或部署。

## 后续

停止本机 Docker 重启、清理、重装与任何可能覆盖该 VHDX 的操作；需恢复时先保留现有文件并制定独立、可审查的恢复方案，不把文件存在视为数据完整。
