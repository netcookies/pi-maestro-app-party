# Changelog

本文件记录 Maestro Mobile 的显著变更。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.1.0] — 2026-09-05

首个可用版本：在移动端完整使用 Pi Agent + pi-maestro-flow。

### 新增

- **SDK Host 架构**（`apps/host`）：`PiSdkRuntimeFactory` → `createAgentSession`，`SdkSessionRunner` 订阅事件投影时间线；`MobileExtensionUiBridge` 把 maestro ask 的 RPC 调用转为 `extension_ui_request` 事件
- **移动端 App**（`apps/mobile`，Expo / React Native）：HostClient（WS 连接 + 自动重连 + 兜底默认地址）、ExtensionUiQueue ask 弹窗、AppState 事件流 reducer
- **ask 闭环**：maestro `ask-user-question` 在远程环境完整可用（select / input / confirm / 多问题 / multiSelect）
- **会话管理**：168+ 历史会话列表（搜索 / 全部 / 活跃 / 历史）、会话内 model / thinking 切换、compact、重命名
- **Teammate Tab**：workspace owners（活的 Pi 会话）+ 每个 owner 下正在运行的 teammate agents（name / status / phase / outputTail 实时日志）+ flow-schedule 调度列表
- **Monitor Tab**：窗口状态总览（running / sleeping / disconnected + work active/idle）
- **Workspace Telemetry**：读取 `~/.pi/teammate/workspaces/*/runtime/owners/*.json`（pi-maestro-teammate 持久化合同），心跳新鲜度判活，5s 轮询变化驱动推送
- **协议命令**：`get_maestro_state` / `get_monitor_state` 主动拉取（修复后连接错过推送的问题）
- **Maestro 设置编辑**：读取 + 修改 host 侧 maestro 配置文件
- **部署**：launchd plist（macOS）、systemd unit（Linux）、Dockerfile

### 修复

- 未连接时 Tab 页不再抛 `HostClient not initialized` 错误页
- 自动重连兜底默认地址（不依赖 AsyncStorage 残留值）
- 会话页双重 header 与底部空白
- Teammate Tab 空状态判断包含 owners、`statusColor` 缺 theme 崩溃、重复 JSX 标签

### 已知限制

- Teammate/Monitor 数据来自 pi-maestro-teammate 的 owner 文件心跳（90s 无心跳判为不活跃）
- iOS 真机安装需 Apple Developer 签名；模拟器构建免签
- 默认无鉴权监听 `0.0.0.0`，公网暴露必须配置 `MAESTRO_MOBILE_TOKEN`

[0.1.0]: https://github.com/isulewli/pi-maestro-app-party/releases/tag/v0.1.0
