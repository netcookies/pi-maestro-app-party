# 协议

WebSocket 消息契约（`packages/shared/src/protocol.ts` 为唯一权威源，本文是 人读摘要）。
跨进程插件契约见 [Desktop Plugin 协议](#desktop-plugin-协议)（`packages/shared/src/desktop-plugin-protocol.ts`）。

版本常量：`MOBILE_PROTOCOL_VERSION = 2`、`MOBILE_RELEASE_VERSION = 0.4.0`、`DESKTOP_PLUGIN_PROTOCOL_VERSION = 2`、`DESKTOP_BROKER_PROTOCOL_VERSION = 1`。

Desktop Plugin v1 不再兼容：旧 TUI 必须 reload/restart 后使用 v2；Host 不提供 direct Plugin socket 或 fallback。Broker 是 Plugin live registry 的唯一 owner，Host 只消费认证的 projection。

版本只在 **breaking wire change**（破坏性线协议变更）时递增。可选字段和新事件若能通过 capability/`supportedEvents` 协商且旧端可以安全忽略，则保持当前协议版本。`runtime_status` 属于 v2 内的协商式增量；`0.4.0` 是产品 release version，不是协议版本。

## 会话状态模型

`HostSessionSummary` 的状态由三个**正交维度**组成，任何一个维度都不能替代另外两个：

| 维度 | 字段 | 回答的问题 |
|---|---|---|
| 运行生命周期 | `runtimeStatus` | 当前是否存在已确认的运行端点，以及它是否正在执行 |
| UI 归属 | `presentation.visibility` | 此项应出现在 Sessions、Monitor，还是隐藏 |
| 控制权限 | `presentation.control` | Mobile 是否以及如何控制这个 exact target |

`runtimeStatus` 的定义：

| 值 | 语义 |
|---|---|
| `running` | 已确认的运行端点正在执行 agent turn |
| `idle` | 已确认的运行端点在线且可接收下一轮 |
| `sleeping` | telemetry 仍知道该端点，但端点已断开；用于只读监控，不代表可控制 |
| `history` | 只剩持久化会话记录，没有确认到运行端点 |

Sessions 页的 **Current** 是派生视图，不是第五种运行状态：

```ts
runtimeStatus !== "history"
  && presentation.visibility === "session_list"
```

它表示当前仍有运行端点或 telemetry 记录的会话，允许把三种运行状态放在同一列表中观察：

- `running`：正在执行，Mobile 卡片显示绿色；
- `idle`：在线待命，Mobile 卡片显示蓝色；
- `sleeping`：端点已断开但仍有只读 telemetry，Mobile 卡片显示黄色；
- `history`：仅持久化历史记录，不进入 Current，只在 All 中显示。

Current 不代表控制权限。`sleeping + readonly` 仍不可操作；Mobile 必须继续以 `presentation.control` 判断按钮能力。
硬性不变量：

1. `visibility` 是页面归属的唯一权威；不得用运行状态代替。
2. `control` 是控制授权的唯一权威；不得从 `runtimeStatus`、cwd、PID、名称或时间推断。
3. Desktop Plugin socket 注册成功即证明运行端点在线，初始状态至少为 `idle`；`agent_start` / `agent_end` 更新为 `running` / `idle`。
4. Desktop Plugin 断线并注销后，历史索引才投影为 `history`。
5. `sleeping` 来自断开的 workspace telemetry，只能搭配 `readonly` 投影；可以进入 Current 观察，但不能进入控制授权。

这些规则的机器权威位于 `packages/shared/src/protocol.ts`；Host 负责生成一致组合，Mobile 只消费组合，不重新推断身份或控制权。

## HostEvent（host → 移动端）

| 类型 | 说明 |
|---|---|
| `host_status` | 连接状态 |
| `session_updated` | Host runner 会话状态变化 |
| `session_summary_updated` | exact target 的列表卡片摘要 patch（runtime、活跃时间、消息数、终态 usage/context） |
| `timeline_item` / `timeline_delta` | 对话/工具时间线（增量） |
| `extension_ui_request` / `extension_ui_cleared` | ask 弹窗（select/input/confirm） |
| `maestro_state` | flow-schedule 调度投影（变化驱动推送） |
| `monitor_state` | workspace owners + teammate agents 状态（5s 变化驱动推送） |
| `command_error` / `error` | 错误 |

## ClientCommand（移动端 → host）

| 命令 | 说明 |
|---|---|
| `open_session` / `close_session` | 打开新会话 / 关闭当前 |
| `prompt` / `steer` / `follow_up` / `abort` | 发消息 / 打断注入 / 追问 / 中止 |
| `set_model { sessionId, modelId, provider? }` | 切换模型（`provider` 用于区分跨 provider 同名 id） |
| `set_thinking` / `compact` / `rename_session` | 思考深度 / 压缩会话 / 重命名 |
| `list_models` / `list_skills` | 列出模型 / 已加载 skills |
| `load_more_history` / `search_history` | 历史翻页 / 历史搜索 |
| `get_snapshot` / `get_session_usage` | 拉取快照 / 会话用量 |
| `extension_ui_response` | ask 弹窗作答回传 |
| `get_maestro_state` / `get_monitor_state` / `get_maestro_settings` / `update_maestro_settings` | 主动拉取或更新状态（兜底错过推送） |

## 命令路由：按 target kind 分叉

同一个 `prompt`/`set_model` 命令，最终由**谁拥有该 AgentSession** 决定执行路径
（`apps/host/src/application/session-command-service.ts`）：

| target kind | 拥有者 | 执行路径 |
|---|---|---|
| `host` | Host 进程内 `SdkSessionRunner` | 直接调用 `runner.prompt()/steer()/followUp()/setModel()` |
| `desktop` | 外部 TUI Pi 进程 | `DesktopControlGateway` → UDS → `DesktopPiSessionAdapter` → `ExtensionAPI` |

`DesktopControlGateway` 与 Desktop Plugin **不是两种并列模式**，而是同一条链路的通道与终点：gateway 负责 capability 校验、deadline 与幂等，plugin 负责在 TUI 自己的进程里调用真实 Pi API。

### 投递语义

`prompt` / `steer` / `follow_up` 是独立于 target kind 的第二个维度（新轮次 / 介入当前流 / 排队到本轮后）。

两条路径的 streaming 语义已对齐：

| 路径 | 流式（streaming）时的行为 |
|---|---|
| host（进程内 runner） | `prompt` 自动降级为 `runner.steer()` |
| desktop（跨进程 UDS → TUI） | `prompt` 以 `deliverAs: "steer"` 投递；Pi 仅在流式时读取该选项，故空闲走新轮次、流式中入队 steer |

> 为何 desktop 侧无需判断状态：Pi 的 `prompt()` **只在 `isStreaming` 为真时**才读取 `streamingBehavior`，
> 传 `"steer"` 是幂等的（空闲时被忽略）。这避开了「判断时空闲、投递时已流式」的竞态。

### 投递确认语义

Desktop Plugin 的 UDS `desktop_plugin_receipt` 仅表示 Host 请求已到达 Plugin；对于 `prompt` / `steer` / `follow_up`，Pi 的公开 `ExtensionAPI.sendUserMessage()` 返回 `void`，因此 Plugin 结果使用 `accepted`，表示已调用 Pi API，但尚未证明 AgentSession 已开始处理。只有后续 `agent_start` / `agent_end` 事件才能证明 `running` / `idle` 生命周期；不得把 fire-and-forget 调用直接报告为 `observed`。

`set_model` 和 `abort` 仍在各自 Promise 或同步动作完成后报告 `observed`。异步调用若发生可捕获的前置失败，仍返回 `failed` 和结构化错误码；断连或超时返回 `unknown`。

### 投递失败（`delivery_failed`）

Pi 的 `ExtensionAPI.sendUserMessage` 返回 `void`，失败被 SDK 吞进 `emitError`，调用方无法 `await` 或 `catch`。
因此 Desktop Plugin 在投递前做预检，把可预见的失败变成结构化结果；预检通过后返回 `accepted`，**不再把调用返回当作 `observed`**：

```json
{ "status": "failed", "error": { "code": "delivery_failed", "message": "no_model_selected" } }
```

- `code` 是稳定的机器可判别值（`delivery_failed`）；具体原因在 `message`。
- 当前原因：`no_model_selected`（未选模型）、`missing_model_auth`（模型未配置凭据）。
- 该错误经 `command_result` 回传 Mobile（`ok:false`），移动端映射为可读文案并展示（不再只保留草稿）。

注：`sendUserMessage` 以 `expandPromptTemplates:false` 绕过扩展命令解析，因此以 `/` 开头的文本是**合法消息**，不得拦截。

## 连接

```
ws://<host>:4739/ws?token=<MAESTRO_MOBILE_TOKEN>
```

- 握手：客户端发 `protocol_hello { protocolVersion: 2, clientVersion, requestId, capabilities[], releaseVersion? }`，Host 回 `protocol_ready`
- token 未配置时开放连接（仅建议内网）
- 断线自动重连 + 指数退避；重连后 App 主动拉取快照与状态兜底
- WS 握手 Origin 白名单：loopback 变体 + 绑定 host + 同源 Host 头；非浏览器客户端（无 Origin）放行后仍由 token 把关

## HTTP API（调试用）

| 路由 | 说明 |
|---|---|
| `GET /api/health` | 健康检查 |
| `GET /api/status` | Host 版本 / 运行时间 / 会话数量 |
| `GET /api/desktop/current` | 认证的四层 Desktop 状态诊断；可用 `sessionId`、`endpointId`、`normalizedCwd`、`processGeneration` 四个参数做 exact target 筛选 |
| `GET /api/sessions` | 会话列表（支持 `cwd`/`query`/`limit`/`cursor`/`projectCwds`） |
| `GET /api/maestro` | Maestro 调度状态 |
| `GET /api/maestro-settings` | maestro 设置文件总览 |
| `GET /api/workspace-telemetry` | Monitor 投影（窗口状态） |
| `GET /api/pair-ips` / `GET /api/pair-short` | 配对候选 IP / 短码换 token |
| `GET /api/file` | 图片只读预览（绝对路径 + 扩展名 + 大小限制） |
| `GET /api/extension-ui/pending` | 待处理 ask 计数 |
| `GET /api/live-sessions` | 已弃用，返回 410（不属于 Protocol v2） |

---

## Desktop Plugin 协议

Host ↔ 外部 Pi TUI 进程之间的 UDS 契约。Plugin 连接的是 singleton Broker，而不是 Host。**传输**：Unix domain socket（Broker 默认独占
`~/.pi/maestro-mobile/ipc/desktop-plugin.sock`，Host 独占 `~/.pi/maestro-mobile/ipc/desktop-broker-host.sock`，权限均为 `0600`），NDJSON 单行帧，默认最大 1 MiB，
握手超时 5s，请求超时 2s。**认证**：共享密钥 `~/.pi/maestro-mobile-ipc-secret`（`timingSafeEqual` 比较）。

### Broker 拓扑与诊断

Broker 独占 Plugin socket，内存 registry 是唯一 live authority；`desktop-plugin-registry.json` 仅为诊断快照，不能恢复 live transport。Host 通过 `desktop-broker-host.sock` 接收带 `brokerInstanceId`（epoch）和单调 `revision` 的 chunked snapshot / contiguous delta。Host 只有在完整 snapshot 收齐后才原子安装 projection；epoch 变化、revision gap、断线和 Broker crash 都 fail closed，已 dispatch 的命令不 replay。

`/maestro-mobile status --current` 是只读诊断，比较 Pi local、Plugin→Broker、Broker→Host、Host exact-target projection 四层状态。verdict：`synced`、`drift`、`target_missing`、`plugin_disconnected`、`broker_host_disconnected`、`host_unreachable`、`broker_flapping`。诊断 endpoint `/api/desktop/current` 需要 Bearer token，并支持完整四元组筛选，不能仅按 session ID 或 cwd 匹配。



所有请求与事件都必须匹配完整四元组，禁止依据 cwd、名称、PID、时间或“最新”推断：

```ts
interface DesktopPluginTarget {
  sessionId: string;
  endpointId: string;
  normalizedCwd: string;
  processGeneration: string;
}
```

### Capability

`prompt` | `steer` | `follow_up` | `abort` | `set_model` | `ask-user-question`

插件在 `desktop_plugin_hello` 中自报能力；Broker 在 live registry 中登记，Host 执行前校验。
**旧插件缺少 `set_model` 时返回结构化 `capability_mismatch`，不静默降级、不回退到 Host runner。**

### Operation（Host → Plugin）

| operation | 载荷 |
|---|---|
| `prompt` | `message`, `images?` |
| `steer` / `follow_up` | `message` |
| `abort` | — |
| `set_model` | `provider?`, `modelId` |

`set_model` 由插件在**自身进程**用 `ctx.modelRegistry.find(provider, modelId)` 解析后调用
`ExtensionAPI.setModel(model)`；解析失败返回 `model_change_failed`（不伪造成功）。

### Event（Plugin → Host）

```ts
{ type: "desktop_plugin_event", event: "model_select", model: DesktopPluginModel }
{ type: "desktop_plugin_event", event: "runtime_status", runtimeStatus: "running" | "idle" }
{ type: "desktop_plugin_event", event: "session_summary", summary: {
    runtimeStatus: "running" | "idle", activeSince?, lastActivityAt?, messageCount?, usage?, context?
  } }
```

`DesktopPluginModel = { provider, id, name, reasoning, vision }`。

- `model_select`：TUI 内用户切换模型时上报；插件（重）连成功后也会重发当前模型。
- `runtime_status`：仅表示 runtime 状态切换；`agent_start` 上报 `running`，`agent_end` 上报 `idle`。重复状态不广播。
- `session_summary`：按语义节点发送 exact-target 卡片 patch。runtime/`activeSince`/`lastActivityAt` 在状态切换时更新；`messageCount` 与最终 token usage 在 `message_end` 更新；context 在 `message_end`、`agent_end` 或 compact 后更新。不会按 token delta 发送，也不会为列表常驻轮询 JSONL。
- Host 侧按 exact target 更新对应投影，并广播 `session_summary_updated`；Mobile 只 patch 当前已加载且 targetKey 匹配的卡片。断线时 Host 发送 `sleeping` patch，之后注销 target。
- 模型事件**先于** `openSession` 到达时按 target 暂存，会话打开后补发（不丢事件）。

`runtime_status` 与 `session_summary` 都是 v2 内的协商式增量，而不是无条件扩展：新版 Host 在
`desktop_plugin_ready.supportedEvents` 声明支持，Plugin 只有看到对应事件才发送。
旧 Host 省略该字段时新版 Plugin 不发送未知事件，连接保持可用；旧 Plugin 也可忽略新版
`ready` 的附加字段。

### 帧类型

| 方向 | 帧 |
|---|---|
| Client → Host | `desktop_plugin_hello`、`desktop_plugin_request`、`desktop_plugin_event`、`desktop_ask_request`、`desktop_ask_response`、`desktop_plugin_goodbye` |
| Host → Client | `desktop_plugin_challenge`、`desktop_plugin_ready`、`desktop_plugin_receipt`、`desktop_plugin_result`、`desktop_plugin_error` |

`desktop_plugin_error.code` ∈ `authentication_failed` | `protocol_version_unsupported` |
`release_version_unsupported` | `invalid_frame` | `deadline_exceeded` | `capability_mismatch` |
`target_mismatch` | `disconnected`。

### 数据流：模型双向同步

```
Mobile set_model {modelId, provider?}
  → MobileHostServer → SessionCommandService（按 target kind 分叉）
  → DesktopControlGateway（capability + deadline + 幂等）
  → UDS desktop_plugin_request(set_model)
  → DesktopPiSessionAdapter → ExtensionAPI.setModel()      # TUI 真实切换

TUI 用户切换模型 → ExtensionAPI model_select 事件
  → UDS desktop_plugin_event(model_select)
  → HostController.syncDesktopModel（按 exact target）
  → SdkSessionRunner.syncExternalModel（更新 snapshot，不改 SDK session）
  → 广播 session_updated → Mobile 刷新
```
