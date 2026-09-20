# maestro-mobile 部署指南

Host 是 PC 端常驻服务，把 Pi agent 会话、Monitor 窗口 telemetry、maestro 调度状态投影给手机 App。三种部署形态按场景选择：

| 形态 | 适用场景 | 会话接管 | 安装成本 |
|---|---|---|---|
| ① npm 全局安装 | 日常主力机（macOS/Linux） | ✅ 完整 | 低 |
| ② pi 扩展安装 | 深度 Pi 用户 | ✅ 完整 | 低 |
| ③ Docker 看板模式 | NAS / 远程服务器 / 不想装 Node 环境 | ❌ 仅看板 | 中 |

---

## 形态一：npm 全局安装（推荐）

### 安装

```bash
npm install -g pi-maestro-mobile
```

要求 Node ≥ 22.19。包自包含 vendored shared，并安装 Pi Agent SDK、`ws` 与二维码终端运行时依赖。

### 手动运行

```bash
pi-maestro-mobile --port 4739
# 首次无 --token 会生成随机 token 并打印，手机连接时带上
```

### 常驻（macOS launchd）

```bash
cp deploy/com.maestro-mobile.plist ~/Library/LaunchAgents/
# 编辑 plist：ProgramArguments 里的 node 路径与 cli.js 路径、WorkingDirectory、MAESTRO_MOBILE_TOKEN
launchctl load ~/Library/LaunchAgents/com.maestro-mobile.plist
```

日志：`/tmp/maestro-mobile.{out,err}.log`。`KeepAlive` 开启，崩溃自动拉起。

### 常驻（Linux systemd）

```bash
sudo cp deploy/maestro-mobile.service /etc/systemd/system/
# 编辑 ExecStart 路径与 Environment
sudo systemctl daemon-reload
sudo systemctl enable --now maestro-mobile
journalctl -u maestro-mobile -f
```

headless 服务器需要 `sudo loginctl enable-linger $USER`（如果是 user service）。

### 能力边界

完整能力：会话打开/聊天/steer、Monitor 看板、usage 统计、ask 弹窗桥、版本探测（pi/flow/CLI 真实版本）。

---

## 形态二：pi 扩展安装

```bash
pi install npm:pi-maestro-mobile
```

提供 `/maestro-mobile` 薄扩展命令。**扩展不承载服务**：它只 spawn/探测独立的 Host 进程（`detached` + PID 文件 `~/.pi/maestro-mobile.pid` + `/api/health` 幂等探测），Host 生命周期与 Pi 会话完全解耦——关掉 Pi 会话后 Host 仍继续运行。`stop` 会向 PID 文件指向的 Host 发送 `SIGTERM`；若实例由 launchd / systemd 管理，服务管理器可能重新拉起它，应使用对应服务命令永久停止。

```text
/maestro-mobile status   # 探测 :4739，显示状态、版本和 token 摘要
/maestro-mobile start    # 幂等启动：已在监听则跳过；否则 spawn dist/cli.js 并等待 health
/maestro-mobile qr       # 生成二维码、8 位短码和候选端点
/maestro-mobile stop     # 停止 PID 文件指向的实例
```

端口跟随 `MAESTRO_MOBILE_PORT`（默认 4739）。

---

## 形态三：Docker 看板模式

适合 NAS / 远程服务器 / 容器化环境。**能力边界**：Dashboard、Monitor 窗口、usage 统计、会话历史浏览可用；会话控制（`open_session` / `prompt` / `steer` / `abort`）不可用（容器内没有 pi 与 `~/.pi/agent` 认证上下文）。

### docker compose（推荐）

```bash
cd deploy
MAESTRO_MOBILE_TOKEN=your-secret docker compose -f docker-compose.host.yml up -d
```

默认挂载（只读）：

| 宿主路径 | 容器路径 | 用途 |
|---|---|---|
| `~/.pi/agent/sessions` | `/home/node/.pi/agent/sessions` | 会话 JSONL（usage 统计、历史） |
| `~/.pi/teammate` | `/home/node/.pi/teammate` | Monitor 窗口 telemetry |

要看 maestro 调度状态，额外把项目目录挂到 `/workspace`（compose 文件里有注释示例）。

### 纯 docker run

```bash
docker run -d --name maestro-mobile \
  -p 4739:4739 \
  -v ~/.pi/agent/sessions:/home/node/.pi/agent/sessions:ro \
  -v ~/.pi/teammate:/home/node/.pi/teammate:ro \
  -e MAESTRO_MOBILE_TOKEN=your-secret \
  maestro-mobile
```

镜像以非 root 用户运行。

### 版本探测在容器里的行为

容器内没有宿主的全局 npm 目录和 `pi`/`maestro` bin，`/api/status` 的 `piVersion`/`flowVersion`/`maestroCliVersion` 为空，手机端显示「待 Host 接入」——这是预期行为。需要版本信息就用形态一。

---

## Desktop Broker 运行与升级

正式拓扑只有一个 singleton Broker：

- Broker 独占 `~/.pi/maestro-mobile/ipc/desktop-plugin.sock`，内存 registry 是 live authority。
- Host 独占 `~/.pi/maestro-mobile/ipc/desktop-broker-host.sock`，只消费 Broker 的认证 snapshot/delta projection。
- `desktop-plugin-registry.json` 只用于诊断，不恢复 live transport、pending command 或 ask 状态。
- Host restart 不应清空 Plugin live connection；Broker crash 后 supervisor 会恢复 Broker，Plugin 会 bounded reconnect，Host 会等待新的完整 snapshot。

升级或协议不兼容时：先停止 Host/Broker，再安装新版并重新启动；Desktop Plugin protocol v1 不兼容 v2，旧 TUI 必须 reload/restart。socket collision 时检查 `~/.pi/maestro-mobile/*.pid`、lock 和 log，确认 owner 后再处理，禁止以删除 JSON 快照代替恢复。

使用 `/maestro-mobile status --current` 检查四层状态：Pi local runtime、Plugin→Broker、Broker→Host、Host projection。输出 verdict 为 `synced`、`drift`、`target_missing`、`plugin_disconnected`、`broker_host_disconnected`、`host_unreachable` 或 `broker_flapping`。



推荐在 Pi TUI 执行：

```text
/maestro-mobile qr
```

随后在 App 的 **Settings** 中扫码；无法扫码时，输入二维码下方的 8 位短码与 PC 局域网地址。配对成功后 App 会保存 WS 端点和 token，并自动重连。

协议端点格式为：

```text
ws://<PC 局域网 IP>:4739/ws
```

同一局域网内直连，数据不过公网。多台手机可以同时连接并接收事件广播。

## 安全

- Host CLI 默认监听 `0.0.0.0`，并始终启用 token；未显式设置时会自动生成并持久化到 `~/.pi/maestro-mobile-token`
- 只需本机访问时设置 `MAESTRO_MOBILE_HOST=127.0.0.1`
- Docker 看板模式的挂载全部只读（`:ro`）
- 跨公网访问请套 Tailscale / WireGuard，不要裸暴露端口

## 故障排查

| 症状 | 检查 |
|---|---|
| 手机连不上 | `curl -H "Authorization: Bearer $MAESTRO_MOBILE_TOKEN" http://<PC>:4739/api/health`；无 token 的 `401` 也说明服务已监听；同时检查防火墙端口 4739 |
| Monitor 无窗口 | 宿主 `~/.pi/teammate/workspaces/` 是否有 owners JSON（Pi 会话是否跑过 teammate） |
| usage 显示 -- | 手机端需先在「会话」页打开一个会话（usage 是会话级聚合） |
| Docker 内会话控制不可用 | 预期行为——看板模式不包含 Pi 认证上下文 |
