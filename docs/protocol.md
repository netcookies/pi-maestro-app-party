# 协议

WebSocket 消息契约（`packages/mobile-sdk/src/protocol.ts` 为唯一权威源，通过 `@maestro-mobile/mobile-sdk/protocol` 导出；`packages/shared/src/protocol.ts` 仅保留兼容转发，本文是人读摘要）。Host 负责移动端 transport、只读会话/历史读取与状态 projection；Host 从不创建、附着或控制 Pi `AgentSession`。
跨进程插件契约见 [Desktop Plugin 协议](#desktop-plugin-协议)（`packages/shared/src/desktop-plugin-protocol.ts`）。

版本常量：`MOBILE_PROTOCOL_MAJOR = 2`、`MOBILE_PROTOCOL_REVISION = 0`、`MOBILE_SDK_VERSION = 1.0.0`、`DESKTOP_PLUGIN_PROTOCOL_VERSION = 2`、`DESKTOP_BROKER_PROTOCOL_VERSION = 1`。产品版本以 `packages/mobile-sdk/src/release.ts` 的 `MOBILE_PRODUCT_VERSION` 为准，仅用于诊断与 legacy bridge，不要求 Host 与 App 产品版本相等。

Desktop Plugin v1 不再兼容：旧 TUI 必须 reload/restart 后使用 v2；Host 不提供 direct Plugin socket 或替代控制路径。Broker 是 Plugin live registry 的唯一 owner，Desktop Plugin/Broker 是唯一 live control path，Host 只消费认证的 projection。

版本只在 **breaking wire change**（破坏性线协议变更）时递增。可选字段和新事件若能通过 capability/`supportedEvents` 协商且旧端可以安全忽略，则保持当前协议版本。`runtime_status` 属于 v2 内的协商式增量；产品 release version 与 SDK version 均不是协议兼容门禁。

## 代码职责边界

变更前先追踪生产者、协议、SDK 和消费者，确定唯一 owner，再修改所属层。

| 层 | 职责 | 约束 |
|---|---|---|
| Mobile 协议 | wire 类型、校验、错误码、exact target、版本与 capability 语义 | 唯一实现位于 `mobile-sdk/protocol`，不依赖 Host 或 App |
| Mobile SDK | 平台无关 transport、握手、重连、deadline、请求关联与通用数据流恢复 | 不依赖 React、Expo、AsyncStorage 或 Node 专有实现；保留结构化错误 |
| Host | 服务端认证、限流、权威 projection、只读历史与 Broker gateway | 保留服务端安全门禁，不补造客户端身份或控制权 |
| App | 平台适配、UI、i18n、本地偏好/草稿/诊断与视图派生 | 消费协议校验与 SDK，不自写握手、重连或 wire schema |
| Desktop Plugin/Broker | Desktop 契约与 live authority | 契约仍位于 `packages/shared`，保持 exact target 与单一控制路径 |

通用契约缺失先补协议，可复用客户端语义放 SDK；展示问题留在 App。兼容 facade 可保留，禁止另建类型或校验器副本。测试在责任层验证，并覆盖直接受影响的消费者。

当前迁移债务：App 的 snapshot/live 衔接、wire watermark 与恢复代际尚未全部迁入 SDK，迁移时须保留页面加载取消和 React 投影语义。

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

这些规则的机器权威位于 `packages/mobile-sdk/src/protocol.ts`；Host 负责生成一致的 projection，Mobile 只消费组合，不重新推断身份或控制权。

## 会话归属与 exact target

Host 的 live ownership 是 TUI-only：Desktop Plugin 在 Pi TUI 进程内拥有并控制 `AgentSession`，Broker 是唯一 live registry 和命令路由 authority，Host 只保留 Broker projection 与 JSONL/history reader。Host 端的 `PiSessionCatalog` 仅调用 `SessionManager.list()` 列出已有持久化 JSONL，不创建或附着会话。

每个 live Desktop 命令和事件都必须匹配完整四元组：

```ts
interface DesktopPluginTarget {
  sessionId: string;
  endpointId: string;
  normalizedCwd: string;
  processGeneration: string;
}
```

历史记录也有 exact target，但它是只读 sentinel：`endpointId: "history"`、`processGeneration: "persisted"`，并使用持久化记录的 `sessionId` 和规范化 cwd。历史 target 的 `runtimeStatus` 为 `history`、没有控制能力；不得把它升级为 live target。任何 live command 都禁止按 `sessionId`、cwd、名称、PID、时间或“最新”选择目标，也不得在 Desktop target 缺失时回退到 Host session。

## 历史与 JSONL 读取

Host 对 JSONL 只读。首次 snapshot 只加载尾部消息；`load_more_history` 按 cursor 从尾部向前分页，`search_history` 从持久化文件搜索并返回匹配片段。已注册 Desktop target 的 JSONL tail watcher 从当前文件末尾开始，后续完整 message 行按 exact target 发送 `timeline_item`；文件截断或替换（如 compact）时触发有界 replay 和 `timeline_snapshot` 校正。Host 不通过 JSONL 写入、创建或附着会话，不按 token delta 或列表常驻轮询 JSONL。


## HostEvent（host → 移动端）

| 类型 | 说明 |
|---|---|
| `host_status` | 连接状态 |
| `session_updated` | exact target 的只读 snapshot 状态变化 |
| `session_summary_updated` | exact target 的列表卡片摘要 patch（runtime、活跃时间、消息数、终态 usage/context） |
| `timeline_item` / `timeline_delta` | 对话/工具时间线（增量） |
| `extension_ui_request` / `extension_ui_cleared` | ask 弹窗（select/input/confirm） |
| `maestro_state` | flow-schedule 调度投影（变化驱动推送） |
| `monitor_state` | workspace owners + teammate agents 状态（5s 变化驱动推送） |
| `command_error` / `error` | 错误 |

## ClientCommand（移动端 → host）

| 命令 | 说明 |
|---|---|
| `open_session` / `close_session` | 已保留的兼容 envelope；Mobile 不发送 `open_session`，Host 对二者确定性拒绝（分别为 `session_creation_disabled` / `session_close_disabled`） |
| `prompt` / `steer` / `follow_up` / `abort` | 发消息 / 打断注入 / 追问 / 中止；均要求完整 exact target，并经 Desktop Broker gateway |
| `set_model { sessionId, modelId, provider? }` | 切换模型；除载荷外仍要求完整 exact target，`provider` 用于区分跨 provider 同名 id |
| `set_thinking` / `compact` / `rename_session` | `set_thinking` 经 Desktop Broker gateway；`compact` / `rename_session` 当前由 Host 以 `unsupported_command` 拒绝 |
| `list_models` / `list_skills` | 通过 Desktop Broker gateway 查询 exact Desktop target 的模型 / 已加载 skills |
| `load_more_history` / `search_history` | 对完整 exact target 做只读历史翻页 / 历史搜索 |
| `get_snapshot` / `get_session_usage` | 对完整 exact target 拉取只读 snapshot / 会话用量 |
| `extension_ui_response` | 对完整 exact target 回传 ask 答案，经 Desktop Broker gateway 到达 originating Plugin |
| `get_maestro_state` / `get_monitor_state` / `get_maestro_settings` / `update_maestro_settings` | 主动拉取或更新状态（兜底错过推送） |

## 命令路由：Desktop Broker gateway 是唯一 live path

Host 只有一个 live command path。所有需要控制运行中 Pi 会话的命令都必须带完整 exact target。`SessionCommandService` 先通过 `SessionDirectory` 校验四元组，再把命令交给 `DesktopControlGateway`；之后只能沿认证的 Host↔Broker uplink、Broker live registry/UDS 到达 Desktop Plugin。Host 没有第二个 session owner，也不会按 session ID/cwd/name/time 选择替代目标。

```text
Mobile
  → MobileHostServer
  → SessionCommandService
  → DesktopControlGateway（capability + deadline + 幂等）
  → authenticated Broker/UDS
  → Desktop Plugin → DesktopPiSessionAdapter → ExtensionAPI
```

`DesktopControlGateway` 与 Desktop Plugin 是同一条链路的 gateway 与终点：gateway 负责 capability 校验、deadline、幂等及结构化错误；Broker 负责 live registry、transport 与事件路由；Plugin 在自己的 TUI 进程中调用真实 Pi API。历史 target 只能用于 Host 的只读 history/snapshot/usage 查询，不能进入 live command path。

`open_session` / `close_session` 仅为协议兼容保留。Host 不创建、附着或关闭 `AgentSession`，收到这两个 envelope 时分别返回 `session_creation_disabled` / `session_close_disabled` 的 `command_result`（`ok:false`, `status:"failed"`）；Mobile 不发送 `open_session`。

### 投递语义

`prompt` / `steer` / `follow_up` 表示新轮次、介入当前流、排队到本轮后。Desktop 路径的 streaming 语义如下：

| 路径 | 流式（streaming）时的行为 |
|---|---|
| Desktop Broker → TUI | `prompt` 以 `deliverAs: "steer"` 投递；Pi 仅在流式时读取该选项，空闲走新轮次、流式中入队 steer |

> Pi 的 `prompt()` **只在 `isStreaming` 为真时**才读取 `streamingBehavior`；传 `"steer"` 是幂等的（空闲时被忽略），从而避免判断时与投递时之间的竞态。

### 投递确认语义

Desktop Plugin 的 UDS `desktop_plugin_receipt` 仅表示请求已到达 Plugin；对于 `prompt` / `steer` / `follow_up`，Pi 的公开 `ExtensionAPI.sendUserMessage()` 返回 `void`，因此结果使用 `accepted`，表示已调用 Pi API，但尚未证明 AgentSession 已开始处理。只有后续 `agent_start` / `agent_end` 事件才能证明 `running` / `idle` 生命周期；不得把 fire-and-forget 调用直接报告为 `observed`。

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
| `GET /api/sessions` | 只读 `PiSessionCatalog` 会话列表（底层 `SessionManager.list()`；支持 `cwd`/`query`/`limit`/`cursor`/`projectCwds`） |
| `GET /api/maestro` | Maestro 调度状态 |
| `GET /api/maestro-settings` | maestro 设置文件总览 |
| `GET /api/workspace-telemetry` | Monitor 投影（窗口状态） |
| `GET /api/pair-ips` / `GET /api/pair-short` | 配对候选 IP / 短码换 token |
| `GET /api/file` | 图片只读预览（绝对路径 + 扩展名 + 大小限制） |
| `GET /api/extension-ui/pending` | 待处理 ask 计数 |
| `GET /api/live-sessions` | 已弃用，返回 410（不属于 Protocol v2） |

---

## Desktop Plugin 协议

Broker ↔ 外部 Pi TUI 进程之间的 UDS 契约；Host 通过独立的 Broker uplink 接收 projection 并提交 gateway 请求。Plugin 连接的是 singleton Broker，而不是 Host。**传输**：Unix domain socket（Broker 默认独占
`~/.pi/maestro-mobile/ipc/desktop-plugin.sock`，Host 独占 `~/.pi/maestro-mobile/ipc/desktop-broker-host.sock`，权限均为 `0600`），NDJSON 单行帧，默认最大 1 MiB，
握手超时 5s，请求超时 2s。**认证**：共享密钥 `~/.pi/maestro-mobile-ipc-secret`（`timingSafeEqual` 比较）。

### Broker 拓扑与诊断

Broker 独占 Plugin socket，内存 registry 是唯一 live authority；`desktop-plugin-registry.json` 仅为诊断快照，不能恢复 live transport。Host 通过 `desktop-broker-host.sock` 接收带 `brokerInstanceId`（epoch）和单调 `revision` 的 chunked snapshot / contiguous delta。Host 只有在完整 snapshot 收齐后才原子安装 projection；epoch 变化、revision gap、断线和 Broker crash 都 fail closed，已 dispatch 的命令不 replay。

`/maestro-mobile status --current` 是只读诊断，比较 Pi local、Plugin→Broker、Broker→Host、Host exact-target projection 四层状态。verdict：`synced`、`drift`、`target_missing`、`plugin_disconnected`、`broker_host_disconnected`、`host_unreachable`、`broker_flapping`。诊断 endpoint `/api/desktop/current` 需要 Bearer token，并支持完整四元组筛选，不能仅按 session ID 或 cwd 匹配。



所有请求与事件都必须匹配完整四元组，禁止依据 cwd、名称、PID、时间或“最新”推断；历史记录使用 `endpointId: "history"` 与 `processGeneration: "persisted"` 的只读 target：

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

插件在 `desktop_plugin_hello` 中自报能力；Broker 在 live registry 中登记，Host 在进入 gateway 前校验。旧插件缺少 `set_model` 时返回结构化 `capability_mismatch`，不静默降级、不回退到其他 owner。

### Operation（Host/Broker → Plugin，经 Broker）

| operation | 载荷 |
|---|---|
| `prompt` | `message`, `images?` |
| `steer` / `follow_up` | `message` |
| `abort` | — |
| `set_model` | `provider?`, `modelId` |

`set_model` 由插件在**自身进程**用 `ctx.modelRegistry.find(provider, modelId)` 解析后调用
`ExtensionAPI.setModel(model)`；解析失败返回 `model_change_failed`（不伪造成功）。

### Event（Plugin → Broker → Host）

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
- 模型事件按 exact target 关联；Host 更新对应 projection 并广播 `session_updated`，不会创建或修改另一个本地 Pi session。

`runtime_status` 与 `session_summary` 都是 v2 内的协商式增量，而不是无条件扩展：新版 Host 在
`desktop_plugin_ready.supportedEvents` 声明支持，Plugin 只有看到对应事件才发送。
旧 Host 省略该字段时新版 Plugin 不发送未知事件，连接保持可用；旧 Plugin 也可忽略新版
`ready` 的附加字段。

### 帧类型

| 方向 | 帧 |
|---|---|
| Plugin → Broker | `desktop_plugin_hello`、`desktop_plugin_request`、`desktop_plugin_event`、`desktop_ask_request`、`desktop_ask_response`、`desktop_plugin_goodbye` |
| Broker → Plugin | `desktop_plugin_challenge`、`desktop_plugin_ready`、`desktop_plugin_receipt`、`desktop_plugin_result`、`desktop_plugin_error` |

`desktop_plugin_error.code` ∈ `authentication_failed` | `protocol_version_unsupported` |
`release_version_unsupported` | `invalid_frame` | `deadline_exceeded` | `capability_mismatch` |
`target_mismatch` | `disconnected`。

### 数据流：模型双向同步

```
Mobile set_model {modelId, provider?}
  → MobileHostServer → SessionCommandService（完整 exact target）
  → DesktopControlGateway（capability + deadline + 幂等）
  → Broker/UDS desktop_plugin_request(set_model)
  → DesktopPiSessionAdapter → ExtensionAPI.setModel()      # TUI 真实切换

TUI 用户切换模型 → ExtensionAPI model_select 事件
  → Broker/UDS desktop_plugin_event(model_select)
  → HostController.syncDesktopModel（按 exact target 更新 projection）
  → 广播 session_updated → Mobile 刷新
```
