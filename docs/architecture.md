# 架构

基于 **Bridge 模式 + 选择性缝合**：以 `pi-mobile` 的 SDK Host 架构为基底，复用 `pi-maestro-flow` 的 teammate/monitor 能力，解决 maestro `ask-user-question` 在远程环境失效的问题。

```
┌────────────── PC 端：Pi Host（Node 进程）────────────────┐
│                                                          │
│  maestro-mobile-host (apps/host)                         │
│  ├─ PiSdkRuntimeFactory   → createAgentSession           │
│  ├─ SdkSessionRunner      → 订阅事件 + 投影              │
│  ├─ MobileExtensionUiBridge → ask 桥接 (extension_ui)    │
│  ├─ MaestroStateReader    → 读 flow-schedule store       │
│  ├─ WorkspaceTelemetryReader → 读 teammate owners 状态   │
│  └─ MobileHostServer      → HTTP + WS 直连               │
│                        │                                 │
└─────────────────────────┼────────────────────────────────┘
                          │ WebSocket (LAN 直连)
┌─────────────────────────▼────────────────────────────────┐
│  移动端：Expo / React Native (apps/mobile)               │
│  ├─ HostClient      → WS 连接 + 重连                     │
│  ├─ ExtensionUiQueue → ask 弹窗队列                      │
│  ├─ AppState        → 事件流 → UI 状态 reducer           │
│  └─ Tabs            → 会话 / Teammate / Monitor / 设置   │
└──────────────────────────────────────────────────────────┘
```

## 组件职责

### Host（`apps/host`）

| 组件 | 职责 |
|---|---|
| `PiSdkRuntimeFactory` | 通过 `createAgentSession` 创建 Pi agent 会话 |
| `SdkSessionRunner` | 订阅 agent 事件流，投影为 `timeline_item` / `timeline_delta` |
| `MobileExtensionUiBridge` | maestro ask 的 RPC 调用 ↔ `extension_ui_request` 事件桥接 |
| `MaestroStateReader` | 读 `.pi/flow-schedule` store，投影 `maestro_state`（变化驱动推送） |
| `WorkspaceTelemetryReader` | 读 `~/.pi/teammate/workspaces/*/runtime/owners/*.json`，投影 `monitor_state` |
| `MobileHostServer` | HTTP（健康检查 / 快照 / 设置 API）+ WebSocket 直连 |

### Mobile（`apps/mobile`）

| 组件 | 职责 |
|---|---|
| `HostClient` | WS 连接、自动重连（兜底默认地址）、token 鉴权 |
| `ExtensionUiQueue` | ask 弹窗队列（select / input / confirm / 多问题 / multiSelect） |
| `AppState` reducer | 事件流 → UI 状态（会话 / 时间线 / maestro / monitor） |
| Tabs | 会话（对话 + 历史搜索）/ Teammate / Monitor / 设置 |

## Workspace Telemetry 合同

Teammate / Monitor Tab 的数据来自 pi-maestro-teammate 的 owner 持久化文件：

```
~/.pi/teammate/workspaces/<workspaceId>/runtime/owners/<ownerId>.json
  { workspaceId, normalizedCwd, ownerId, pid, sessionId, publishedAt,
    contextPressure, agents[], settled[], backgroundJobs[] }
```

- 每个 owner = 一个活的 Pi 会话（workspace owner claim 持有者）
- 心跳新鲜度（90s 无心跳判不活跃）判活；`agents[]` 即正在运行的 teammate dispatch（含 name / status / phase / outputTail）
- host 5s 轮询，变化时推 `monitor_state`；App 进页面时主动 `get_monitor_state` 兜底（修复后连接错过推送）

## ask 闭环数据流

```
Pi agent (ask-user-question)
  → RPC mode: ctx.ui.select/input/confirm
  → MobileExtensionUiBridge
  → extension_ui_request 事件 → WS
  → ExtensionUiQueue 弹窗 → 用户作答
  → extension_ui_response 命令 → WS
  → RPC resolve → Pi agent 继续
```

## 为什么不用现成方案

- **remote-pi / SSH 面板**：TUI 透传，`ctx.ui.custom` 的 ask 面板在手机上不可见、不可答
- **一般聊天前端**：没有 maestro 状态流、teammate 遥测、extension_ui 协议
- 本项目在 **SDK 层**缝合：host 进程内嵌 agent session，事件与 UI 调用都是一等协议公民
