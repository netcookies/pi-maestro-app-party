# 协议

WebSocket 消息契约（`packages/shared/src/protocol.ts` 为唯一权威源，本文是 人读摘要）。
跨进程插件契约见 [Desktop Plugin 协议](#desktop-plugin-协议)（`packages/shared/src/desktop-plugin-protocol.ts`）。

版本常量：`MOBILE_PROTOCOL_VERSION = 2`、`MOBILE_RELEASE_VERSION = 0.4.0`、`DESKTOP_PLUGIN_PROTOCOL_VERSION = 1`。

## HostEvent（host → 移动端）

| 类型 | 说明 |
|---|---|
| `host_status` | 连接状态 |
| `session_updated` | 会话状态变化 |
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

### 投递失败（`delivery_failed`）

Pi 的 `ExtensionAPI.sendUserMessage` 返回 `void`，失败被 SDK 吞进 `emitError`，调用方无法 `await` 或 `catch`。
因此 Desktop Plugin 在投递前做预检，把可预见的失败变成结构化结果，**不再返回“假成功”**：

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

Host ↔ 外部 Pi TUI 进程之间的 UDS 契约。**传输**：Unix domain socket（默认
`~/.pi/maestro-mobile/ipc/desktop-plugin.sock`，权限 `0600`），NDJSON 单行帧，默认最大 1 MiB，
握手超时 5s，请求超时 2s。**认证**：共享密钥 `~/.pi/maestro-mobile-ipc-secret`（`timingSafeEqual` 比较）。

### Target 身份（exact target identity）

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

插件在 `desktop_plugin_hello` 中自报能力；Host 在 `DesktopPluginRegistry` 中登记，执行前校验。
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
```

`DesktopPluginModel = { provider, id, name, reasoning, vision }`。

- TUI 内用户切换模型时上报；插件（重）连成功后也会重发当前模型。
- Host 侧按 exact target 更新对应 runner 的 snapshot 并广播 `session_updated` 给移动端。
- 事件**先于** `openSession` 到达时按 target 暂存，会话打开后补发（不丢事件）。

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
