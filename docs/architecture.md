# 架构

基于 **Bridge 模式 + 选择性缝合**：以 `pi-mobile` 的 SDK Host 架构为基底，复用 `pi-maestro-flow` 的 teammate/monitor 能力，解决 maestro `ask-user-question` 在远程环境失效的问题。

```
┌────────────── PC 端：Pi Host（Node 进程）────────────────┐
│                                                          │
│  maestro-mobile (apps/host)                         │
│  ├─ PiSdkRuntimeFactory   → createAgentSession           │
│  ├─ SdkSessionRunner      → 订阅事件 + 投影              │
│  ├─ MobileExtensionUiBridge → ask 桥接 (extension_ui)    │
│  ├─ MaestroStateReader    → 读 flow-schedule store       │
│  ├─ WorkspaceTelemetryReader → 读 teammate owners 状态   │
│  ├─ SessionDirectory       → exact target 注册表         │
│  ├─ DesktopControlGateway  → Desktop target 控制通道     │
│  └─ MobileHostServer      → HTTP + WS 直连               │
│                        │                                 │
│                        │ UDS（~/.pi/maestro-mobile/ipc/） │
│  ┌─────────────────────▼─────────────────────────────┐   │
│  │ 外部 Pi TUI 进程（Desktop Plugin extension）         │   │
│  │  └─ DesktopPiSessionAdapter → ExtensionAPI          │   │
│  └─────────────────────────────────────────────────────┘   │
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
| `SessionDirectory` | exact target 注册表（`sessionId + endpointId + normalizedCwd + processGeneration`），区分 host/desktop 与 capability |
| `SessionCommandService` | 命令唯一分叉点：按 target kind 选择 Host runner 或 Desktop gateway |
| `DesktopControlGatewayService` | Desktop target 控制通道：capability 校验 + deadline + 幂等 |
| `DesktopPluginIpcServer` | UDS 服务端：NDJSON 帧、共享密钥认证、registry 持久化 |
| `DesktopPiSessionAdapter` | 在 TUI 进程内执行 operation（含 `set_model`），校验 exact target 与 capability |

### Mobile（`apps/mobile`）

| 组件 | 职责 |
|---|---|
| `HostClient` | WS 连接、自动重连（兜底默认地址）、token 鉴权 |
| `ExtensionUiQueue` | ask 弹窗队列（select / input / confirm / 多问题 / multiSelect） |
| `AppState` reducer | 事件流 → UI 状态（会话 / 时间线 / maestro / monitor） |
| Tabs | 会话（对话 + 历史搜索）/ Teammate / Monitor / 设置 |

## 消息路由：两个正交的轴

**轴 1 — target kind（谁拥有 AgentSession）**

`SessionCommandService.execute()` 是唯一分叉点：

```
Mobile → MobileHostServer → SessionCommandService
   ├── host    → SdkSessionRunner.prompt/steer/followUp/setModel   （进程内）
   └── desktop → DesktopControlGateway → UDS → ExtensionAPI        （跨进程）
```

Desktop Plugin **不是** host runner 的替代模式，而是同一条链路的通道（gateway）+ 终点（plugin）。

**轴 2 — 投递语义**

`prompt`（新轮次）/ `steer`（介入当前流）/ `follow_up`（排队到本轮后），与 target kind 正交。

已知差异：无。host 侧 `prompt` 在 streaming 时自动降级为 steer；desktop 侧以 `deliverAs:"steer"` 投递（Pi 仅在流式时读取该选项，故空闲走新轮次、流式中入队 steer），两条路径语义已对齐。投递失败以结构化 `delivery_failed` 回传，不再返回假成功。详见 `docs/protocol.md` 的「投递语义」与「投递失败」。

## Desktop Plugin（跨进程 TUI 控制）

外部 Pi TUI 启动时加载 `dist/plugin/desktop-plugin-extension.js`，作为 UDS 客户端连回 Host：

```
~/.pi/maestro-mobile/ipc/desktop-plugin.sock   NDJSON 帧，0600
~/.pi/maestro-mobile-ipc-secret               共享密钥（timingSafeEqual）
~/.pi/maestro-mobile/ipc/desktop-plugin-registry.json  注册表快照
```

- 身份：exact target 四元组；禁止 cwd/名称/PID/时间推断
- 能力：插件自报 capability，Host 执行前校验；缺 `set_model` 返回结构化 `capability_mismatch`
- 模型双向同步：Mobile `set_model` → gateway → `ExtensionAPI.setModel()`；TUI `model_select` → `desktop_plugin_event` → `session_updated`
- 断线：插件每 1s 重连；重连成功后重发当前模型；事件早于会话打开时按 target 暂存后补发

完整字段与帧类型见 `docs/protocol.md#desktop-plugin-协议`。

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
