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

（薄扩展入口：`/maestro-host` 命令管理守护进程，规划中；当前版本请用方式一。）

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

手机 App 里填 `ws://<PC 局域网 IP>:4739/ws`（有 token 时加 `?token=`）。

## 守护进程

**macOS（launchd）**：

```bash
cp deploy/com.maestro-mobile.host.plist ~/Library/LaunchAgents/
# 编辑 plist 里的安装路径、WorkingDirectory、token
launchctl load ~/Library/LaunchAgents/com.maestro-mobile.host.plist
```

**Linux（systemd）**：

```bash
sudo cp deploy/maestro-mobile.service /etc/systemd/system/
sudo systemctl enable --now maestro-mobile
```

## HTTP 接口速览

| 路由 | 说明 |
|---|---|
| `GET /api/health` | 存活检查 |
| `GET /api/status` | 版本/uptime/sessions（含 pi/flow/CLI 版本探测） |
| `GET /api/sessions` | 会话列表（`cwd`/`query`/`limit`/`cursor`/`projectCwds`） |
| `GET /api/workspace-telemetry` | Monitor 窗口投影 |
| `GET /api/maestro` / `GET /api/maestro-settings` | flow-schedule 调度状态 / 设置总览 |
| `GET /api/file` | 图片只读预览 |
| `GET /api/extension-ui/pending` | 待处理 ask 计数 |
| `GET /api/live-sessions` | 已弃用，返回 410（不属于 Protocol v2） |
| `WS /ws` | 实时事件流 + 客户端命令（协议见 `@maestro-mobile/shared`，摘要见 `docs/protocol.md`） |

## Desktop Plugin（控制桌面 TUI 会话）

外部 Pi TUI 加载 `dist/plugin/desktop-plugin-extension.js` 后，会作为 UDS 客户端连回 Host，使手机可以直接控制桌面 TUI 会话（prompt / steer / follow_up / abort / set_model / ask 作答）。

| 路径 | 用途 |
|---|---|
| `~/.pi/maestro-mobile/ipc/desktop-plugin.sock` | UDS，NDJSON 帧，权限 `0600` |
| `~/.pi/maestro-mobile-ipc-secret` | 共享密钥（启动时自动生成） |
| `~/.pi/maestro-mobile/ipc/desktop-plugin-registry.json` | 注册表快照 |

行为要点：

- 所有控制与事件都绑定 exact target（`sessionId + endpointId + normalizedCwd + processGeneration`），不做 cwd/名称/PID/时间推断。
- 插件自报 capability；旧插件缺 `set_model` 时返回结构化 `capability_mismatch`，不静默降级。
- 断线后插件每 1s 重连，重连成功后重发当前模型；TUI 切换模型会经 `desktop_plugin_event(model_select)` 回流到手机。

完整字段见 [`docs/protocol.md`](../../docs/protocol.md#desktop-plugin-协议)。

## 构建与产物耦合（重要）

Host 运行时通过 `@maestro-mobile/shared` 的 **`dist`** 解析协议 validator，而不是 `src`。因此修改 `packages/shared/src` 后：

1. 必须先 `pnpm --filter @maestro-mobile/shared build` 重建 `dist`；
2. 否则 Host 会按**旧协议**拒绝新帧（表现为新 operation 返回 `invalid_frame` / `desktop_confirmation_unavailable`，而 `typecheck` 与源码测试可能全绿）；
3. 验证时必须包含真实运行时探针（真实 UDS + 真实 Host 进程），不能只靠单元测试。
