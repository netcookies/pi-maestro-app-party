# Changelog

本文件记录 Maestro Mobile 的显著变更。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.2.14] — 2026-09-11

### 修复与加固

- **WS 入站隔离**：单连接超限（>8MB）拦截抛出的 `RangeError`，防止宿主进程因未捕获异常退出（exit 99），仅断开问题连接。
- **出站背压收敛**：收敛裸 `ws.send` 为单一发送出口，引入软高水位（1MB）、硬上限（32MB）与 5s 宽限期，限制队列驻留内存。
- **心跳机制**：容忍单次 pong 漏答（连续 2 次无响应才断连），避免高负载下健康连接被误踢。
- **参数对齐**：修复 `sendError` 16 处 `in_reply_to` 误传问题，解决命令出错时客户端等待 30s 的现象。
- **死代码清理**：移除无生产调用的 `ws-command-handlers.ts` 与 `jsonl-replay.ts`，并在 `build.sh` 中添加 `rm -rf dist` 防止产物残留。
- **移动端与协议加固**：
  - 断连时立即以 `connection_lost` 标记未决命令，保留草稿。
  - 重连退避加入向下 Jitter，避免并发重连尖峰。
  - `validateClientCommand` 校验 `id` 类型。
  - 弹窗终态条目按容量单趟修剪，防止长期运行占用内存。
  - 优化 Origin 校验解析，支持多形态配置。

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

[0.1.0]: https://github.com/netcookies/pi-maestro-app-party/releases/tag/v0.1.0
