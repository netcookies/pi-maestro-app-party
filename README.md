# Maestro Mobile

在移动端使用 Pi Agent + pi-maestro-flow 的 Bridge 方案。

基于 **Bridge 模式 + 选择性缝合**：以 `pi-mobile` 的 SDK Host 架构为基底，复用 `pi-maestro-flow` 的 teammate/monitor 能力，解决 maestro `ask-user-question` 在远程环境失效的问题。

## 架构

```
┌────────────── PC 端：Pi Host（Node 进程）────────────────┐
│                                                          │
│  maestro-mobile-host (apps/host)                         │
│  ├─ PiSdkRuntimeFactory   → createAgentSession           │
│  ├─ SdkSessionRunner      → 订阅事件 + 投影              │
│  ├─ MobileExtensionUiBridge → ask 桥接 (extension_ui)    │
│  ├─ MaestroStateReader    → 读 flow-schedule store       │
│  ├─ WorkspaceTelemetryReader → 读 teammate owners 状态  │
│  └─ MobileHostServer      → HTTP + WS 直连               │
│                        │                                 │
└─────────────────────────┼────────────────────────────────┘
                          │ WebSocket (LAN 直连)
┌─────────────────────────▼────────────────────────────────┐
│  移动端：Expo / React Native (apps/mobile)               │
│  ├─ HostClient      → WS 连接 + 重连                     │
│  ├─ ExtensionUiQueue → ask 弹窗队列                      │
│  ├─ AppState        → 事件流 → UI 状态 reducer           │
│  └─ Tabs            → 会话 / Teammate / Monitor / 设置  │
└──────────────────────────────────────────────────────────┘
```

## 为什么 ask-question 在 remote-pi 失效，这里可用

pi-maestro-flow 的 `ask-user-question` 工具在 TUI 模式走 `ctx.ui.custom`（终端面板），在远程环境不可见。

本项目使用 **SDK Host 模式**（`createAgentSession` + `bindExtensions({ mode: "rpc", uiContext })`）：
- maestro ask 在 RPC 模式自动映射为 `ctx.ui.select/input/confirm`
- host 的 `MobileExtensionUiBridge` 把这些调用转为 `extension_ui_request` 事件
- 移动端 `ExtensionUiQueue` 收到后弹窗渲染，用户作答后返回
- **ask 闭环在移动端完整可用**

## 快速开始

### 前置

- Node.js ≥ 22.19
- pnpm ≥ 10
- 已配置好的 Pi agent（`pi` 命令可用，含 pi-maestro-flow 扩展）

### 安装

```bash
git clone <repo-url>
cd pi-maestro-app-party
pnpm install
```

### 启动 Host（PC 端）

```bash
# 开发模式
pnpm dev:host

# 生产模式（先构建）
pnpm --filter @maestro-mobile/host build
pnpm --filter @maestro-mobile/host start -- --port 4739 --host 0.0.0.0 --project-root /path/to/your/project
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MAESTRO_MOBILE_PORT` | `4739` | 监听端口 |
| `MAESTRO_MOBILE_HOST` | `0.0.0.0` | 监听地址 |
| `MAESTRO_MOBILE_TOKEN` | 无（开放） | token 鉴权 |
| `MAESTRO_MOBILE_PROJECT_ROOT` | `cwd` | 项目根（含 `.pi/flow-schedule`） |
| `MAESTRO_MOBILE_POLL_MS` | `5000` | maestro 状态轮询间隔 |

### 启动 App（移动端）

```bash
pnpm dev:app
```

App 连接 `ws://<PC-IP>:4739/ws`（同一局域网）。若设置 token，连接时附 `?token=`。

### 运行测试

```bash
pnpm test          # 全仓 TDD 测试
pnpm typecheck     # 类型检查
```

## 协议

### HostEvent（host → 移动端）

| 类型 | 说明 |
|---|---|
| `host_status` | 连接状态 |
| `session_updated` | 会话状态变化 |
| `timeline_item` / `timeline_delta` | 对话/工具时间线 |
| `extension_ui_request` / `extension_ui_cleared` | ask 弹窗（select/input/confirm） |
| `maestro_state` | flow-schedule 调度投影 |
| `monitor_state` | workspace owners + teammate agents 状态（5s 变化驱动推送） |
| `command_error` / `error` | 错误 |

### ClientCommand（移动端 → host）

`open_session` / `close_session` / `prompt` / `steer` / `follow_up` / `abort` / `extension_ui_response` / `get_snapshot` / `set_model` / `set_thinking` / `compact` / `get_maestro_state` / `get_monitor_state`

### Workspace Telemetry 数据源

Teammate / Monitor Tab 的数据来自 pi-maestro-teammate 的 owner 持久化文件：

```
~/.pi/teammate/workspaces/<workspaceId>/runtime/owners/<ownerId>.json
  { workspaceId, normalizedCwd, ownerId, pid, sessionId, publishedAt,
    contextPressure, agents[], settled[], backgroundJobs[] }
```

- 每个 owner = 一个活的 Pi 会话（workspace owner claim 持有者）
- 心跳新鲜度（90s 无心跳判不活跃）判活；`agents[]` 即正在运行的 teammate dispatch
- host 5s 轮询，变化时推 `monitor_state`；App 进页面时主动 `get_monitor_state` 兜底

## 构建安装包（APK / IPA）

### Android APK

```bash
# 方式一：Expo 一键构建（推荐，自动生成 android/ 并编译）
pnpm --filter @maestro-mobile/app prebuild --platform android
cd apps/mobile/android
./gradlew assembleDebug
# 产物：apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

### iOS（模拟器）

```bash
# 方式一：Expo 一键构建
pnpm --filter @maestro-mobile/app prebuild --platform ios
cd apps/mobile/ios
pod install
xcodebuild -workspace MaestroMobile.xcworkspace -scheme MaestroMobile \
  -configuration Debug -sdk iphonesimulator -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO build
# 产物：apps/mobile/ios/build/Build/Products/Debug-iphonesimulator/MaestroMobile.app
```

### iOS 真机（需要 Apple Developer 账号签名）

```bash
cd apps/mobile/ios
xcodebuild -workspace MaestroMobile.xcworkspace -scheme MaestroMobile \
  -configuration Release -sdk iphoneos -derivedDataPath build \
  -allowProvisioningUpdates CODE_SIGN_STYLE=Automatic build
# 产物：build/Build/Products/Release-iphoneos/MaestroMobile.app
# 用 Xcode Organizer / Apple Configurator 安装到设备
```

> 首次 prebuild 后 ios/ 和 android/ 已生成并提交，之后无需重复 prebuild。

## 常驻部署

- **macOS**: `deploy/com.maestro-mobile.host.plist`（launchd）
- **Linux**: `deploy/maestro-mobile-host.service`（systemd）
- **Docker**: `Dockerfile`

## 安全

- 默认监听 `0.0.0.0`：建议设置 `MAESTRO_MOBILE_TOKEN`（Bearer header 或 `?token=`）
- 或仅监听 `127.0.0.1` + Tailscale/SSH 隧道
- 移动端是 Pi 的远程入口，可执行命令：**不要**在无鉴权的公网上暴露

## 路线图

- [x] P0 ✅ monorepo 骨架 + 直连服务器
- [x] P1 ✅ Maestro Bridge（flow-schedule 投影 + 变更检测）
- [x] P2 ✅ 移动端核心逻辑（HostClient + ExtensionUiQueue + AppState）
- [x] P3 ✅ E2E 联调（ask 闭环 / maestro 状态流 / 重连）
- [x] P4 ✅ 常驻启动 + 部署配置
- [x] P5 ✅ Teammate / Monitor Tab（workspace telemetry 合同）
- [ ] 后续：owner 详情页（contextPressure / backgroundJobs / settled）、图片附件、推送通知
