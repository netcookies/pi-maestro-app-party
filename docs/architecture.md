# 架构

基于 **Bridge + Singleton Broker**：Host 负责 Mobile HTTP/WS 与 Host-owned AgentSession；singleton Broker 负责所有 Desktop Plugin socket 和 live registry；Host 通过认证的 Broker uplink 消费不可回退的 projection。

```text
┌────────────── PC 端：Pi Host（Node 进程）─────────────────────────┐
│ MobileHostServer（HTTP + WS）                                    │
│ HostController → SessionDirectory + DesktopBroker projection     │
│ Host-owned SdkSessionRunner / Monitor / Maestro readers           │
│                  │ authenticated UDS: desktop-broker-host.sock    │
└──────────────────┼────────────────────────────────────────────────┘
                   ▼
┌────────────────── Singleton Desktop Broker ───────────────────────┐
│ 独占 desktop-plugin.sock；内存 registry 是 live authority          │
│ 向 Host 推送 chunked snapshot / contiguous delta                  │
│ registry.json 仅诊断快照，不恢复 live transport                   │
└──────────────────┬────────────────────────────────────────────────┘
                   ▼ authenticated UDS
┌────────────────── 外部 Pi TUI：Desktop Plugin protocol v2 ────────┐
│ DesktopPiSessionAdapter → ExtensionAPI                             │
└────────────────────────────────────────────────────────────────────┘
                   ▲
                   │ LAN WebSocket / HTTP
             移动端 Expo / React Native
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
| `MobileHostServer` | HTTP（健康检查 / 快照 / 设置 / current diagnostics）+ WebSocket |
| `SessionDirectory` | Host 与 Broker projection 的 exact target 目录 |
| `DesktopBrokerHostIpc` | Host 独占 uplink：认证、snapshot staging、epoch/revision 校验 |
| `DesktopBrokerProjectedRegistry` | Host 对 Broker live registry 的原子 projection |
| `DesktopControlGatewayService` | Desktop target 控制：capability、deadline、幂等 |
| `DesktopBroker` | singleton 进程：独占 Plugin socket、live registry、命令/事件路由 |
| `DesktopPluginIpcServer` | Broker 侧 Plugin UDS：NDJSON、共享密钥、protocol v2 |
| `DesktopPluginRegistryStore` | 诊断快照持久化；不承担 live recovery |
| `DesktopPiSessionAdapter` | 在 TUI 进程内执行 operation（含 `set_model`） |

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
   └── desktop → DesktopControlGateway → Host Broker projection → Broker UDS → ExtensionAPI        （跨进程）
```

Desktop Plugin **不是** host runner 的替代模式，而是同一条链路的通道（gateway）+ 终点（plugin）。

**轴 2 — 投递语义**

`prompt`（新轮次）/ `steer`（介入当前流）/ `follow_up`（排队到本轮后），与 target kind 正交。

已知差异：投递确认层级不同，但命令投递方式一致。host 侧 `prompt` 在 streaming 时自动降级为 steer，并在 Promise 完成后报告 `observed`；desktop 侧以 `deliverAs:"steer"` 投递（Pi 仅在流式时读取该选项，故空闲走新轮次、流式中入队 steer），但公开 `ExtensionAPI.sendUserMessage()` 是 fire-and-forget，因此请求完成后只能报告 `accepted`，后续 `agent_start` / `agent_end` 事件才是运行生命周期证据。可预见投递失败以结构化 `delivery_failed` 回传，不返回假 `observed`。详见 `docs/protocol.md` 的「投递语义」与「投递失败」。

### Desktop Plugin 与 Broker

路径 owner 是固定的：Broker 独占 `~/.pi/maestro-mobile/ipc/desktop-plugin.sock`，Host 独占 `~/.pi/maestro-mobile/ipc/desktop-broker-host.sock`。Broker 内存 registry 是唯一 live authority；`desktop-plugin-registry.json` 只记录排序后的诊断 metadata，不能恢复 transport 或命令状态。

Broker 向 Host 发送带 `brokerInstanceId` 和单调 `revision` 的 chunked snapshot 与 contiguous delta。Host 只在完整 snapshot 收齐后原子替换 projection；epoch 改变、revision gap、断线或 Broker crash 都 fail closed，命令不自动 replay。

`/maestro-mobile status --current` 读取 Pi extension 的 symbol-keyed local runtime state，再调用认证的 `GET /api/desktop/current`，比较 Pi local、Plugin→Broker、Broker→Host 和 Host exact-target projection 四层状态。诊断 verdict 为 `synced`、`drift`、`target_missing`、`plugin_disconnected`、`broker_host_disconnected`、`host_unreachable`、`broker_flapping`；它是只读操作，不改变 Mobile UI。



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
