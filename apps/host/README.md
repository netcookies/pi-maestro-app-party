# maestro-mobile

PC 端常驻服务：把 Pi agent 会话、Monitor 窗口 telemetry、maestro 调度状态投影给手机 App（Maestro Mobile）。

```
手机 App  ←—— 局域网 WS/HTTP ——→  maestro-mobile  ←→  Pi SDK AgentSession / ~/.pi 文件状态
```

## 安装

### 方式一：npm 全局安装（推荐，launchd/systemd 常驻）

```bash
npm install -g maestro-mobile
maestro-mobile --port 4739
```

开机常驻见下方 [守护进程](#守护进程)。

### 方式二：pi 扩展安装

```bash
pi install npm:maestro-mobile
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

容器模式能力边界：Dashboard / Monitor 看板、会话历史浏览、usage 统计**可用**；
`open_session` / `steer_window` 的会话接管**不可用**（需要容器内安装 pi 及认证上下文）。
详细说明见仓库 `docs/deploy.md`。

## 使用

```bash
maestro-mobile [--port 4739] [--host 0.0.0.0] [--token <secret>] [--project-root <dir>] [--poll-ms 5000]
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
| `GET /api/workspace-telemetry` | Monitor 窗口 owners（pid/sessionId/agents/contextPressure） |
| `GET /api/maestro` | flow-schedule 调度状态 |
| `GET /api/live-sessions` | 活跃 Pi 会话扫描 |
| `WS /ws` | 实时事件流 + 客户端命令（协议见 `@maestro-mobile/shared`） |
