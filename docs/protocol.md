# 协议

WebSocket 消息契约（`packages/shared/src/protocol.ts` 为唯一权威源，本文是 人读摘要）。

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
| `extension_ui_response` | ask 弹窗作答回传 |
| `get_snapshot` | 拉取当前会话完整快照 |
| `set_model` / `set_thinking` / `compact` | 模型 / 思考深度 / 压缩会话 |
| `get_maestro_state` / `get_monitor_state` | 主动拉取 maestro / monitor 状态（兜底错过推送） |

## 连接

```
ws://<host>:4739/ws?token=<MAESTRO_MOBILE_TOKEN>
```

- token 未配置时开放连接（仅建议内网）
- 断线自动重连 + 指数退避；重连后 App 主动拉取快照与状态兜底

## HTTP API（调试用）

| 路由 | 说明 |
|---|---|
| `GET /api/health` | 健康检查 |
| `GET /api/workspace-telemetry` | workspace owners 原始遥测（调试 Telemetry 合同用） |
| `GET /api/maestro-settings` | maestro 设置文件总览 |
| `GET /api/sessions` | 历史会话列表 |
