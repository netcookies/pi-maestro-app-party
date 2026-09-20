# pi-maestro-mobile

PC 端常驻服务：把 Pi agent 会话、Monitor 窗口 telemetry、maestro 调度状态投影给手机 App（Maestro Mobile）。

```
手机 App  ←—— 局域网 WS/HTTP ——→  pi-maestro-mobile  ←→  Pi SDK AgentSession / ~/.pi 文件状态
```

## 安装

### 方式一：npm 全局安装（推荐，launchd/systemd 常驻）

```bash
npm install -g pi-maestro-mobile
pi-maestro-mobile --port 4739
```

开机常驻见下方 [守护进程](#守护进程)。

### 方式二：pi 扩展安装

```bash
pi install npm:pi-maestro-mobile
```

安装后可在任意 Pi TUI 中使用薄扩展命令管理独立 Host：

```text
/maestro-mobile start    # 幂等启动
/maestro-mobile status   # 查看状态、版本和 token 摘要
/maestro-mobile status --current # 比较当前 Pi/Plugin/Broker/Host 四层状态
/maestro-mobile qr       # 生成二维码与 8 位短码
/maestro-mobile stop     # 停止 PID 文件指向的 Host 实例
```

扩展只负责启动、探测、配对与停止；Host 是独立常驻进程，不随当前 Pi 会话退出。

### 方式三：Docker（看板模式）

```bash
docker run -d --name maestro-mobile \
  -p 4739:4739 \
  -v ~/.pi/agent/sessions:/home/node/.pi/agent/sessions:ro \
  -v ~/.pi/teammate:/home/node/.pi/teammate:ro \
  -e MAESTRO_MOBILE_TOKEN=your-secret \
  maestro-mobile
```

容器模式能力边界：Dashboard / Monitor 看板、会话历史浏览、usage 统计**可用**；会话控制**不可用**（需要容器内安装 pi 及认证上下文）。
详细说明见仓库 `docs/deploy.md`。

## 使用

```bash
pi-maestro-mobile [--port 4739] [--host 0.0.0.0] [--token <secret>] [--project-root <dir>] [--poll-ms 5000]
```

| 参数 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `--port` | `MAESTRO_MOBILE_PORT` | 4739 | HTTP+WS 端口 |
| `--host` | `MAESTRO_MOBILE_HOST` | 0.0.0.0 | 监听地址 |
| `--token` | `MAESTRO_MOBILE_TOKEN` | 随机（启动时打印） | Bearer/`?token=` 鉴权 |
| `--project-root` | `MAESTRO_MOBILE_PROJECT_ROOT` | cwd | maestro flow-schedule 读取根 |
| `--poll-ms` | `MAESTRO_MOBILE_POLL_MS` | 5000 | telemetry/调度轮询间隔 |

`MAESTRO_MOBILE_ROLLOUT` 可设为 `disabled`、`shadow` 或 `enabled`（默认），用于控制 Protocol v2 rollout。

官方 App 推荐通过 `/maestro-mobile qr` 配对。协议端点格式为 `ws://<PC 局域网 IP>:4739/ws`，token 可使用查询参数或 Bearer header 传递。

## 守护进程

**macOS（launchd）**：

```bash
cp deploy/com.maestro-mobile.plist ~/Library/LaunchAgents/
# 编辑 plist 里的安装路径、WorkingDirectory、token
launchctl load ~/Library/LaunchAgents/com.maestro-mobile.plist
```

**Linux（systemd）**：

```bash
sudo cp deploy/maestro-mobile.service /etc/systemd/system/
sudo systemctl enable --now maestro-mobile
```

## HTTP 接口速览

Host CLI 始终启用 token。除 `/api/pair-short` 使用 8 位一次性短码外，下列 HTTP 路由都需要 Bearer 或 `?token=` 鉴权。

| 路由 | 说明 |
|---|---|
| `GET /api/pair-short` | 短码换 token、候选 IP 和端口 |
| `GET /api/health` | 存活检查；无 token 时 `401` 也表示服务已监听 |
| `GET /api/status` | 版本/uptime/sessions（含 pi/flow/CLI 版本探测） |
| `GET /api/desktop/current` | 认证的 Broker link、epoch/revision、projection 和 exact target 诊断 |
| `GET /api/sessions` | 会话列表（`cwd`/`query`/`limit`/`cursor`/`projectCwds`） |
| `GET /api/pair-ips` | 配对候选 IP 列表 |
| `GET /api/workspace-telemetry` | Monitor 窗口投影 |
| `GET /api/maestro` / `GET /api/maestro-settings` | flow-schedule 调度状态 / 设置总览 |
| `GET /api/file` | 图片只读预览 |
| `GET /api/extension-ui/pending` | 兼容占位，固定返回 `pending: 0` |
| `GET /api/live-sessions` | 已弃用，返回 410（不属于 Protocol v2） |
| `WS /ws` | 实时事件流 + 客户端命令（协议见 `@maestro-mobile/shared`，摘要见 `docs/protocol.md`） |

真实 Ask 状态通过 WS 的 `extension_ui_request` / `extension_ui_cleared` 事件投影。

## Desktop Plugin 与 Singleton Broker（控制桌面 TUI 会话）

| 路径 | owner / 用途 |
|---|---|
| `~/.pi/maestro-mobile/ipc/desktop-plugin.sock` | Broker 独占的 Plugin UDS，NDJSON，权限 `0600` |
| `~/.pi/maestro-mobile/ipc/desktop-broker-host.sock` | Host 独占的 Broker uplink UDS，权限 `0600` |
| `~/.pi/maestro-mobile-ipc-secret` | Plugin/Broker/Host 共享密钥 |
| `~/.pi/maestro-mobile/ipc/desktop-plugin-registry.json` | Broker 诊断快照；不是 live authority，不能恢复 transport |
| `~/.pi/maestro-mobile/desktop-broker.pid` | singleton Broker PID |

行为要点：

- Broker 内存 registry 是唯一 live authority；每次 mutation 有单调 revision，Host 只接受同一 epoch 的 contiguous delta。
- 所有控制与事件都绑定 exact target：`sessionId + endpointId + normalizedCwd + processGeneration`，不做 cwd/名称/PID/时间推断。
- Host restart 只重建 Broker uplink projection，不应断开 Plugin；Broker crash 后 Plugin 按 bounded reconnect 重连，旧 JSON 不会伪造在线 target。
- 升级或协议不兼容时，先执行 `/maestro-mobile stop`，更新 npm 包或重新构建后执行 `/maestro-mobile start`；Desktop Plugin v1 必须 reload/restart 使用 v2。
- 若 `desktop-plugin.sock` 或 `desktop-broker-host.sock` 被其他进程占用，先停止旧 Host/Broker 实例，确认 PID/lock/log 后再启动，不要删除仍被活进程使用的 socket。
- `/maestro-mobile status --current` 只读比较四层状态，输出 `synced`、`drift`、`target_missing`、`plugin_disconnected`、`broker_host_disconnected`、`host_unreachable` 或 `broker_flapping`。

完整字段见 [`docs/protocol.md`](../../docs/protocol.md#desktop-plugin-协议)。


## 构建与产物耦合（重要）

Host 运行时通过 `@maestro-mobile/shared` 的 **`dist`** 解析协议 validator，而不是 `src`。因此修改 `packages/shared/src` 后：

1. 必须先 `pnpm --filter @maestro-mobile/shared build` 重建 `dist`；
2. 否则 Host 会按**旧协议**拒绝新帧（表现为新 operation 返回 `invalid_frame` / `desktop_confirmation_unavailable`，而 `typecheck` 与源码测试可能全绿）；
3. 验证时必须包含真实运行时探针（真实 UDS + 真实 Host 进程），不能只靠单元测试。
