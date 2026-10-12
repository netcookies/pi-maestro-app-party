# Maestro Mobile

**在 iOS / Android 上查看 Pi 会话、跟进任务，并控制已授权的桌面 TUI。**

把桌面的工作进度带到手机：浏览会话与历史、发送文本或图片、切换模型，以及在目标 TUI 已加载兼容 `pi-maestro-flow` 时回答 Ask、审阅 Plan。Pi 会话继续运行在桌面，手机通过 Host 与 Desktop Broker 接入。

<p align="center">
  <a href="docs/images/screenshots/ios-launched.png"><img src="docs/images/screenshots/ios-launched.png" width="260" alt="Workbench：Usage、任务与待处理事项概览" /></a>
  <a href="docs/images/screenshots/ios-sessions.png"><img src="docs/images/screenshots/ios-sessions.png" width="260" alt="Sessions：查看与筛选 Pi 会话" /></a>
  <a href="docs/images/screenshots/ios-chat.png"><img src="docs/images/screenshots/ios-chat.png" width="260" alt="Chat：会话历史、消息与工具输出" /></a>
</p>

<p align="center">Workbench · Sessions · Chat — 点击截图查看原图</p>

<details>
<summary>更多界面：模型选择、Monitor 与配对设置</summary>

<p align="center">
  <a href="docs/images/screenshots/ios-model-select.png"><img src="docs/images/screenshots/ios-model-select.png" width="260" alt="Models：选择模型与 Thinking 级别" /></a>
  <a href="docs/images/screenshots/ios-monitor.png"><img src="docs/images/screenshots/ios-monitor.png" width="260" alt="Monitor：查看工作区窗口与运行状态" /></a>
  <a href="docs/images/screenshots/ios-settings.png"><img src="docs/images/screenshots/ios-settings.png" width="260" alt="Settings：Host 连接、配对与外观设置" /></a>
</p>

</details>

## 从手机接手哪些工作

- **查看会话**：Current / All、搜索、项目筛选、历史分页与搜索、Token / Context 使用量。
- **继续交互**：文本或图片 Prompt、Steer / Follow-up、模型与 Thinking 切换、Skills、Compact / Abort；桌面与手机同步模型状态。
- **跟进任务**：Workbench 汇总 Usage、Run、Teammate、Ask 与 Attention；Monitor 展示服务端允许查看的窗口与遥测。
- **处理决策**：Flow Ask Wizard 支持连续作答、单选、多选和文本；Plan 支持审阅与确认，回复返回发起请求的桌面 TUI。
- **保持连接**：二维码、深链或 8 位短码配对，保存连接配置，断线后自动重连并恢复快照。
- **接收提醒**：系统本地通知、应用内横幅、触觉反馈和点击跳转；适配竖屏与横屏。

操作是否可用取决于目标会话的 capability 与服务端授权。历史会话只读；手机不会创建新的 Pi 会话。

## 依赖与能力边界

运行 Host 需要 **Node.js ≥ 22.19**。实时控制需要目标机器运行 Pi TUI，并加载 `pi-maestro-mobile` 的 Desktop Plugin；建议在 macOS / Linux 上部署 Host 与 Broker。

**手机 Ask / Plan 需要目标 TUI 当前加载兼容的 `pi-maestro-flow`。** 它与 Mobile 通过 Pi 扩展系统独立安装，并非 Mobile 的 npm 依赖。全局磁盘上安装了 Flow，不代表当前 TUI 已启用或已 reload。各项能力的来源如下：

| 能力 | 所需组件 |
| --- | --- |
| 会话列表、JSONL 历史、Usage | Mobile Host + 可读取的 Pi 会话数据 |
| Prompt、Steer、Follow-up、模型 / Thinking、Compact、Abort | Pi TUI + Mobile Desktop Plugin + Broker |
| 多题 Ask、Plan 审阅与确认 | `pi-maestro-flow` 的 Ask / Plan transport + Mobile 桌面桥 |
| Maestro 调度状态与设置 | `pi-maestro-flow` 的 `.pi/flow-schedule` 和配置数据 |
| Monitor、Teammate 与工作区遥测 | `pi-maestro-teammate` 的 telemetry / projection |

基础桌面控制使用 Pi 原生 API，无需 Flow；Flow 专属能力需要目标 TUI 加载相应扩展并提供兼容的 transport / projection。每次 `/maestro-mobile` 命令都会 fresh 检查当前 Pi 已加载的 `ask-user-question` 工具与 `plan` 命令：两者必须来自同一 `pi-maestro-flow` 包、使用 stable SemVer，并公开 Ask / Plan transport exports 与共享 registry 合同。未安装、被禁用、版本无效或为预发布版本、旧合同或来源冲突时会显示 **warning**，但基础命令仍继续执行。该检查是静态依赖提示，不是完整 runtime 能力协商；磁盘上的安装或升级也不能证明当前内存模块已经 reload。Host 启动时探测 Pi、Flow 与 Maestro CLI 版本，`/maestro-mobile status` 可查看探测结果；版本探测不等于功能授权。

Docker 看板模式只提供 Dashboard、Monitor、Usage 和历史的只读投影，且需要挂载对应数据。容器不承载 Pi TUI 或 Desktop Broker，无法实时控制桌面会话。

## 快速开始

### 1. 在 Pi 所在机器安装扩展

```bash
pi install npm:pi-maestro-flow
pi install npm:pi-maestro-mobile
```

通过 `pi config` 启用 Flow 与 Mobile 主扩展后运行；已打开的会话需执行 `/reload` 或重启，使当前内存模块真正加载：

```text
/maestro-mobile start
/maestro-mobile status
/maestro-mobile qr
```

Host 是独立常驻进程，关闭 Pi 会话后仍继续运行。`start` 幂等启动，已运行则跳过。

| 命令 | 用途 |
| --- | --- |
| `/maestro-mobile start` | 后台启动 Host |
| `/maestro-mobile status` | 查看运行状态、端口及 Pi / Flow / CLI 版本 |
| `/maestro-mobile status --current` | 比较当前 Pi、Plugin、Broker、Host 四层连接状态 |
| `/maestro-mobile qr` | 显示二维码、8 位短码和候选连接地址 |
| `/maestro-mobile stop` | 停止扩展管理的 Host；常驻服务需用对应服务管理器停止 |
| `/maestro-mobile notify` | 配置通知 Provider 与事件 |

### 2. 安装移动端 App

从源码开发安装前，先在仓库根目录执行 `pnpm install` 和 `pnpm build`，并准备 Android SDK，或 macOS 上的 Xcode / CocoaPods。

```bash
# Android 开发构建
cd apps/mobile
npx expo run:android
```

```bash
# iOS 开发构建（需要 macOS）
cd apps/mobile
npx expo run:ios
```

已有 release APK 时可用 `adb install <path-to-apk>` 安装。首次使用会请求相机、相册与通知权限，分别用于扫码配对、发送图片和任务提醒。

### 3. 配对并打开会话

1. 在桌面 Pi TUI 执行 `/maestro-mobile qr`。
2. 在 App 的 **Settings** 中扫码配对。
3. 无法扫码时，输入二维码下方的 8 位短码与 PC 局域网地址。
4. 在 **Sessions** 选择已有会话；运行中的已授权桌面会话可继续交互，历史记录可浏览与搜索。

App 会保存端点与 token。默认 WebSocket 地址为 `ws://<PC 局域网 IP>:4739/ws`；手机与 PC 需能互相访问。

Host 默认监听 `0.0.0.0:4739`，始终要求 token。未指定时自动生成并保存到 `~/.pi/maestro-mobile-token`。仅本机访问可使用 `--host 127.0.0.1`；跨公网使用 Tailscale / WireGuard 等安全隧道。

## 其他 Host 部署方式

**npm 全局安装**适合独立管理常驻服务：

```bash
npm install -g pi-maestro-mobile
pi-maestro-mobile --host 0.0.0.0 --port 4739 --token "your-secret-token"
```

此命令启动 Host 服务。实时控制仍需要目标 Pi TUI 加载 Mobile Desktop Plugin，并连通 Broker；Flow 功能另需 Flow。只有历史文件或 telemetry 数据时，可作为只读看板使用。

**源码运行**：

```bash
pnpm install
pnpm build
node apps/host/dist/cli.js --host 0.0.0.0 --port 4739
```

用 `--project-root /path/to/project` 指定 Flow 调度数据所在项目。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `MAESTRO_MOBILE_HOST` | `0.0.0.0` | HTTP / WS 监听地址 |
| `MAESTRO_MOBILE_PORT` | `4739` | 监听端口 |
| `MAESTRO_MOBILE_TOKEN` | 自动生成并持久化 | Bearer / `?token=` 鉴权 |
| `MAESTRO_MOBILE_PROJECT_ROOT` | 当前目录 | Flow 状态与项目读取根目录 |
| `MAESTRO_MOBILE_POLL_MS` | `5000` | 状态轮询间隔（毫秒） |

launchd、systemd、Docker Compose、挂载与权限说明见 [部署指南](docs/deploy.md)。

## 工作方式

```text
Mobile App
  ↕ WebSocket / HTTP
Mobile Host（API、历史与状态投影）
  ↕ 认证 Unix socket
Desktop Broker（精确目标路由）
  ↕ 认证 Unix socket
Pi TUI + Desktop Plugin（实际执行操作）
```

Host 读取会话目录、JSONL 与遥测，并把实时控制命令送到 Broker。真正拥有和操作 Pi 会话的是桌面 TUI；Host 不创建或附着 `AgentSession`。

每次控制使用完整目标身份：`sessionId`、`endpointId`、`normalizedCwd`、`processGeneration`。Broker 的内存连接状态决定目标是否在线，registry JSON 仅供诊断；跨 cwd peer messaging 需要明确授权。

完整职责见 [架构说明](docs/architecture.md)。

## 升级与排障

升级前执行 `/maestro-mobile stop`；由 launchd / systemd 管理时，先用对应服务管理器停止。更新后在目标 Pi TUI `/reload` 或重启，再执行 `start` 与 `status --current`。

```bash
# 更新通过 Pi 安装的扩展
pi update npm:pi-maestro-flow
pi update npm:pi-maestro-mobile
```

npm 全局安装则重新执行 `npm install -g pi-maestro-mobile`；源码部署重新构建。当前 Desktop Plugin 使用 protocol v2，旧 v1 Plugin 需要 reload / restart 后才可连接，不提供兼容降级。

- **手机连不上**：检查 PC 地址、局域网和防火墙端口 `4739`。`/api/health` 返回未鉴权的 `401` 也说明服务已监听。
- **会话可见但不能操作**：确认它是 live Desktop target，检查 `/maestro-mobile status --current`；历史会话和 Docker 看板本来就只读。
- **Ask / Plan 不出现**：确认目标 TUI 已通过 `pi config` 启用 Flow 主扩展，并执行 `/reload` 或重启；确认当前 TUI 同时加载了来自同一 `pi-maestro-flow` 包的 `ask-user-question` 与 `plan`，且 transport exports / 共享 registry 合同兼容。每次命令的静态检查只会告警并继续基础命令，不代表运行时能力协商成功。
- **Monitor 无窗口**：检查 `~/.pi/teammate/workspaces/` 是否存在 owner telemetry，以及目标会话是否运行过 teammate。
- **版本信息未刷新**：安装或升级只改变磁盘文件，不证明当前 TUI 内存模块已 reload；执行 `/reload` 或重启目标 TUI，并按需重启 Host。容器内无法探测宿主版本时显示为空是预期行为。

Host 日志位于 `~/.pi/maestro-mobile.log`，可能包含 token，请勿公开。更多诊断见 [部署指南](docs/deploy.md)。

## 开发与构建

仓库使用 `pnpm@10.8.1`。主要目录：

```text
apps/mobile/          Expo / React Native App
apps/host/            Host CLI、Pi extension、Desktop Broker / Plugin
packages/shared/      共享协议与类型
packages/mobile-sdk/  移动端 transport SDK
```

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

移动端导出验证：

```bash
pnpm --filter @maestro-mobile/app exec expo export --platform android --platform ios --output-dir dist
```

构建原生 release 包：

```bash
# Android release APK
cd apps/mobile/android
./gradlew assembleRelease
```

```bash
# iOS archive（需要配置 Apple 签名）
cd apps/mobile/ios
xcodebuild -workspace MaestroMobile.xcworkspace -scheme MaestroMobile -configuration Release archive
```

版本与发布流程由 [scripts/release.mjs](scripts/release.mjs) 管理；Host 包的 `prepublishOnly` 会构建并运行测试。完整变更见 [CHANGELOG.md](CHANGELOG.md)。

## 协议与参考

当前项目版本 **0.12.1**；Mobile / Desktop Plugin protocol **v2**，Desktop Broker protocol **v1**。协议版本只在破坏性线协议变更时递增。

HTTP 提供健康检查、会话目录、当前桌面诊断、Maestro 状态和 workspace telemetry；WebSocket 承载实时事件、会话控制、Ask / Plan response、历史分页、模型与设置。除一次性短码交换外，HTTP API 需要 token。

- [协议合同与 API](docs/protocol.md)
- [Host 包说明](apps/host/README.md)
- [部署与故障排查](docs/deploy.md)
- [版本变更](CHANGELOG.md)

许可证：[MIT](LICENSE)。
