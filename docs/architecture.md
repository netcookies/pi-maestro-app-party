# 架构

基于 **Bridge + Singleton Broker**：Host 负责 Mobile HTTP/WS、只读会话目录、JSONL/history 与 telemetry projection；Host 从不创建、附着或控制 Pi `AgentSession`。singleton Broker 负责所有 Desktop Plugin socket 和 live registry；Desktop Plugin/Broker 是唯一 live control path，Host 通过认证的 Broker uplink 消费不可回退的 projection。

```text
┌────────────── PC 端：Pi Host（Node 进程）─────────────────────────┐
│ MobileHostServer（HTTP + WS）                                    │
│ HostController → PiSessionCatalog + JSONL/history readers         │
│              → Desktop Broker projection（只读）                 │
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
│ 这里才拥有并控制 Pi AgentSession                                  │
└────────────────────────────────────────────────────────────────────┘
                   ▲
                   │ LAN WebSocket / HTTP
             移动端 Expo / React Native
```



## 组件职责

### Host（`apps/host`）

| 组件 | 职责 |
|---|---|
| `PiSessionCatalog` | 只读调用 `SessionManager.list()` 枚举已有持久化 JSONL；不创建或附着 `AgentSession` |
| `SessionQueryService` | 读取 exact target 的 JSONL/history、usage 与 snapshot；历史 target 始终只读 |
| `MaestroStateReader` | 读 `.pi/flow-schedule` store，投影 `maestro_state`（变化驱动推送） |
| `WorkspaceTelemetryReader` | 读 `~/.pi/teammate/workspaces/*/runtime/owners/*.json`，投影 `monitor_state` |
| `MobileHostServer` | HTTP（健康检查 / 快照 / 设置 / current diagnostics）+ WebSocket |
| `SessionDirectory` | Host projection 的 exact target 目录；不拥有运行时会话 |
| `DesktopBrokerHostIpc` | Host 独占 uplink：认证、snapshot staging、epoch/revision 校验 |
| `DesktopBrokerProjectedRegistry` | Host 对 Broker live registry 的原子 projection |
| `DesktopControlGatewayService` | 仅把 live command 转发到 exact Desktop target：capability、deadline、幂等 |

### Desktop Broker / Plugin（独立 live control plane）

| 组件 | 职责 |
|---|---|
| `DesktopBroker` | singleton 进程：独占 Plugin socket、live registry、命令/事件路由 |
| `DesktopPluginIpcServer` | Broker 侧 Plugin UDS：NDJSON、共享密钥、protocol v2 |
| `DesktopPluginRegistryStore` | 诊断快照持久化；不承担 live recovery |
| `DesktopPiSessionAdapter` | 在 TUI 进程内执行 operation（含 `set_model`），这里才接触真实 `AgentSession` |

### Mobile（`apps/mobile`）

| 组件 | 职责 |
|---|---|
| `HostClient` | WS 连接、自动重连（兜底默认地址）、token 鉴权 |
| `ExtensionUiQueue` | ask 弹窗队列（select / input / confirm / 多问题 / multiSelect） |
| `AppState` reducer | 事件流 → UI 状态（会话 / 时间线 / maestro / monitor） |
| Tabs | 会话（对话 + 历史搜索）/ Teammate / Monitor / 设置 |

## 会话目录、历史与 JSONL

`PiSessionCatalog` 仅调用 `SessionManager.list()` 枚举已有持久化记录。它不附着 `AgentSession`，也不产生 live owner。Host 的 `SessionQueryService` 对这些记录及 Desktop target 的 `sessionFile` 做只读 snapshot、usage、分页历史和搜索。

历史记录使用稳定的只读 exact target：

```ts
{
  sessionId: "<persisted session id>",
  endpointId: "history",
  normalizedCwd: "<normalized session cwd>",
  processGeneration: "persisted"
}
```

历史 target 的 `runtimeStatus` 是 `history`，控制能力为空；它不能被命令路由当作 live Desktop target。运行中的 Desktop target 则必须使用 Plugin 提供的完整四元组 `sessionId + endpointId + normalizedCwd + processGeneration`，不能按 `sessionId`、cwd、名称、PID、时间或“最新”回退。

JSONL 读取保持只读和有界：首次 snapshot 只取尾部消息，`load_more_history` 从 cursor 向前分页，`search_history` 扫描持久化文件并返回匹配片段；不会通过 JSONL 写入或创建会话。对已注册的 Desktop target，tail watcher 从当前文件末尾开始监听后续完整 JSONL message 行，按 exact target 发出 `timeline_item`；文件截断或替换（例如 compact）时执行有界 replay，并用 `timeline_snapshot` 校正，不按 token delta 或列表轮询 JSONL。

## 消息路由

Host 只有一个 live command path。所有需要作用于运行中 Pi 会话的命令都必须带完整 exact target，由 `SessionCommandService` 解析后进入 `DesktopControlGateway`，再经 Broker/UDS 到达 Desktop Plugin；Host 不维护第二个 AgentSession owner，也不按 `sessionId`、cwd、名称、PID、时间或“最新”目标回退。

```
Mobile → MobileHostServer → SessionCommandService
  → DesktopControlGateway（capability + deadline + 幂等）
  → authenticated Broker/UDS
  → Desktop Plugin → DesktopPiSessionAdapter → ExtensionAPI
```

`prompt`（新轮次）/ `steer`（介入当前流）/ `follow_up`（排队到本轮后）是投递语义，不是不同的 owner。Desktop Plugin 在自己的 TUI 进程中调用真实 Pi API；Host 只接收 Broker projection、读取 exact target 的 JSONL，并向 Mobile 广播投影事件。公开 `ExtensionAPI.sendUserMessage()` 是 fire-and-forget，因此消息命令成功时报告 `accepted`，后续 `agent_start` / `agent_end` 事件才证明 `running` / `idle`；可预见投递失败以结构化 `delivery_failed` 回传。详见 `docs/protocol.md` 的「命令路由」与「投递语义」。

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

```text
Pi TUI / Desktop Plugin（ask-user-question）
  → authenticated UDS → Singleton Broker
  → Host Broker uplink（exact target）
  → extension_ui_request 事件 → WS
  → ExtensionUiQueue 弹窗 → 用户作答
  → extension_ui_response 命令 → DesktopControlGateway → Broker/UDS
  → Desktop Plugin → originating Pi TUI 继续
```

## 为什么不用现成方案

- **remote-pi / SSH 面板**：TUI 透传，`ctx.ui.custom` 的 ask 面板在手机上不可见、不可答
- **一般聊天前端**：没有 maestro 状态流、teammate 遥测、extension_ui 协议
- 本项目把 TUI-only 控制、Broker 路由与 Host 的只读 projection 组合起来：Pi 运行时仍由 Desktop TUI 拥有，Host 负责移动端协议、JSONL/history 与状态读取
