# pi-maestro-host 部署指南

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
npm install -g pi-maestro-host
```

要求 Node ≥ 22.19。包自包含（vendored shared），只拉 `pi-coding-agent` SDK 和 `ws` 两个运行时依赖。

### 手动运行

```bash
maestro-mobile-host --port 4739
# 首次无 --token 会生成随机 token 并打印，手机连接时带上
```

### 常驻（macOS launchd）

```bash
cp deploy/com.maestro-mobile.host.plist ~/Library/LaunchAgents/
# 编辑 plist：ProgramArguments 里的 node 路径与 cli.js 路径、WorkingDirectory、MAESTRO_MOBILE_TOKEN
launchctl load ~/Library/LaunchAgents/com.maestro-mobile.host.plist
```

日志：`/tmp/maestro-mobile-host.{out,err}.log`。`KeepAlive` 开启，崩溃自动拉起。

### 常驻（Linux systemd）

```bash
sudo cp deploy/maestro-mobile-host.service /etc/systemd/system/
# 编辑 ExecStart 路径与 Environment
sudo systemctl daemon-reload
sudo systemctl enable --now maestro-mobile-host
journalctl -u maestro-mobile-host -f
```

headless 服务器需要 `sudo loginctl enable-linger $USER`（如果是 user service）。

### 能力边界

完整能力：会话打开/聊天/steer/接管（steer_window）、Monitor 看板、usage 统计、ask 弹窗桥、版本探测（pi/flow/CLI 真实版本）。

---

## 形态二：pi 扩展安装

```bash
pi install npm:pi-maestro-host
```

提供 `/maestro-host status|start|stop` 薄扩展命令。**扩展不承载服务**：它只 spawn/探测独立的 host 进程（`detached` + PID 文件 `~/.pi/maestro-host.pid` + `/api/health` 幂等探测），host 生命周期与 Pi 会话完全解耦——关掉 Pi 会话 host 继续跑，launchd/systemd 管理的实例也不会被误杀（stop 仅针对本扩展启动的 PID）。

```text
/maestro-host status   # 探测 :4739，显示运行状态与版本（未配 token 时提示）
/maestro-host start    # 幂等启动：已在监听则跳过；否则 spawn dist/cli.js 并等待 health
/maestro-host stop     # 仅停止本扩展启动的实例
```

端口跟随 `MAESTRO_MOBILE_PORT`（默认 4739）。

---

## 形态三：Docker 看板模式

适合 NAS / 远程服务器 / 容器化环境。**能力边界**：Dashboard、Monitor 窗口、usage 统计、会话历史浏览可用；`open_session` / `steer_window` 会话接管**不可用**（容器内没有 pi 与 `~/.pi/agent` 认证上下文）。

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
docker run -d --name maestro-mobile-host \
  -p 4739:4739 \
  -v ~/.pi/agent/sessions:/home/node/.pi/agent/sessions:ro \
  -v ~/.pi/teammate:/home/node/.pi/teammate:ro \
  -e MAESTRO_MOBILE_TOKEN=your-secret \
  pi-maestro-host
```

镜像自带 HEALTHCHECK（`/api/health`），非 root 用户运行。

### 版本探测在容器里的行为

容器内没有宿主的全局 npm 目录和 `pi`/`maestro` bin，`/api/status` 的 `piVersion`/`flowVersion`/`maestroCliVersion` 为空，手机端显示「待 Host 接入」——这是预期行为。需要版本信息就用形态一。

---

## 手机端连接

App「会话」页 Host 连接卡填：

```
ws://<PC 局域网 IP>:4739/ws?token=<your-secret>
```

同一局域网内直连，数据不过公网。多台手机可同时连接（事件广播）。

## 安全

- 强烈建议设置 `MAESTRO_MOBILE_TOKEN`（尤其公共 Wi-Fi）
- Docker 看板模式的挂载全部只读（`:ro`）
- 跨公网访问请套 Tailscale/WireGuard，不要裸暴露端口

## 故障排查

| 症状 | 检查 |
|---|---|
| 手机连不上 | `curl http://<PC>:4739/api/health`；防火墙放行 4739 |
| Monitor 无窗口 | 宿主 `~/.pi/teammate/workspaces/` 是否有 owners JSON（Pi 会话是否跑过 teammate） |
| usage 显示 -- | 手机端需先在「会话」页打开一个会话（usage 是会话级聚合） |
| Docker 内接管失败 | 预期行为——看板模式不支持会话接管 |
