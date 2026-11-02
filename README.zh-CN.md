<a id="readme-top"></a>

<div align="center">
  <img src="apps/mobile/assets/icon.png" alt="Maestro Mobile 应用图标" width="80" height="80" />
  <h1>Maestro Mobile</h1>
  <p>用手机跟进 Pi 会话，随时继续桌面的工作。</p>
  <p><a href="README.md">English</a> · <strong>简体中文</strong></p>
  <p>
    <a href="https://github.com/netcookies/pi-maestro-app-party/releases/latest"><img src="https://img.shields.io/github/v/release/netcookies/pi-maestro-app-party" alt="最新版本" /></a>
    <a href="https://www.npmjs.com/package/pi-maestro-mobile"><img src="https://img.shields.io/npm/v/pi-maestro-mobile" alt="npm 版本" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT 许可证" /></a>
  </p>
  <p>
    <a href="https://github.com/netcookies/pi-maestro-app-party/releases/latest"><strong>下载 App »</strong></a>
    <br /><br />
    <a href="#getting-started">快速开始</a> ·
    <a href="https://github.com/netcookies/pi-maestro-app-party/issues/new">反馈问题</a> ·
    <a href="https://github.com/netcookies/pi-maestro-app-party/issues">功能建议</a>
  </p>
</div>

<details>
  <summary>目录</summary>
  <ol>
    <li><a href="#about-the-project">项目介绍</a></li>
    <li><a href="#getting-started">快速开始</a></li>
    <li><a href="#remote-sessions-with-herdr">结合 Herdr 远程管理会话</a></li>
    <li><a href="#usage">日常使用</a></li>
    <li><a href="#peer-messaging">Pi 会话消息（/mb-peer）</a></li>
    <li><a href="#documentation">相关文档</a></li>
    <li><a href="#contributing">参与贡献</a></li>
    <li><a href="#license">许可证</a></li>
  </ol>
</details>

<a id="about-the-project"></a>

## 项目介绍

Maestro Mobile 是 [Pi](https://github.com/badlogic/pi-mono) 的 iOS / Android 配套 App。会话继续在电脑上运行，手机通过本地 Host 服务查看进度，并操作已授权的运行中会话。

<p align="center">
  <a href="docs/images/screenshots/ios-launched.png"><img src="docs/images/screenshots/ios-launched.png" width="180" alt="Workbench：使用量、任务与待处理事项" /></a>
  <a href="docs/images/screenshots/ios-sessions.png"><img src="docs/images/screenshots/ios-sessions.png" width="180" alt="Sessions：浏览与新建 Pi 会话" /></a>
  <a href="docs/images/screenshots/ios-chat.png"><img src="docs/images/screenshots/ios-chat.png" width="180" alt="Chat：消息、悬浮状态栏与后续发送" /></a>
  <a href="docs/images/screenshots/ios-execution-drawer.png"><img src="docs/images/screenshots/ios-execution-drawer.png" width="180" alt="执行状态抽屉：Goal 指标与 Todo 明细" /></a>
</p>

- **跟进进度**：浏览会话、搜索历史，查看实时使用量、活跃任务、子代理与执行进度。
- **继续工作**：发送文本或图片，介入当前轮次，流式中排队后续消息，调整思考等级，通过可折叠悬浮状态栏切换模型，或停止长任务。
- **跟踪执行**：展开执行状态抽屉，查看 Goal 指标（进度、Token、耗时）、Loop 循环轮次，以及带耗时柱状条与 Summary 小字的逐条 Todo 明细。
- **处理决策**：在手机上回答 Ask、审阅 Plan；可将弹窗最小化为悬浮胶囊以便先查阅会话上下文，也可使用原生 Review & Refine 面板优化计划。
- **远程会话管理**：通过 Herdr 直接在手机上选择运行时与工作目录，启动独立的桌面 Pi 会话，或远程优雅结束会话。
- **保持连接**：支持二维码或短码配对、断线自动重连和任务完成通知。

可用操作取决于桌面会话的权限与能力。历史会话只读；主机可用 Herdr 时可直接远程新建 Pi 会话；Docker 部署提供只读看板。

<a id="getting-started"></a>

## 快速开始

### 使用前准备

- 已安装 Pi 和 **Node.js ≥ 22.19** 的电脑，建议在 macOS / Linux 上运行 Host。
- 一部 iOS 或 Android 手机，通过局域网或 Tailscale / WireGuard 等私有隧道访问电脑。

### 1. 配置桌面端

在 Pi 中安装 Mobile 扩展：

```bash
pi install npm:pi-maestro-mobile
```

如需 Ask / Plan，再安装 Flow：

```bash
pi install npm:pi-maestro-flow
```

通过 `pi config` 启用已安装的扩展，包括 Mobile Desktop Plugin。已打开的 Pi 会话需执行 `/reload` 或重启，然后运行：

```text
/maestro-mobile start
/maestro-mobile qr
```

如需维护手机端新建会话的常用工作目录，可在桌面 TUI 执行 `/maestro-mobile manager-fav`。

### 2. 安装 App

从 [最新 Release](https://github.com/netcookies/pi-maestro-app-party/releases/latest) 下载：

| 平台 | 安装方式 |
| --- | --- |
| Android | 安装已签名的 `.apk`，按提示允许来自该来源的安装。 |
| iOS | 下载未签名 `.ipa`，使用 [Sideloadly](https://sideloadly.io/) 或 AltStore，通过自己的 Apple ID 签名后安装。 |

希望自行构建？请看 [开发指南](docs/development.md#run-the-mobile-app)。

### 3. 配对并打开会话

在 App 的 **Settings** 中扫描桌面二维码，也可输入 **8 位短码**与电脑局域网地址。进入 **Sessions**，选择已有会话。

App 会保存连接并自动重连。默认地址为 `ws://<computer-ip>:4739/ws`，Host 始终要求 token；局域网外访问请使用私有隧道。

<a id="remote-sessions-with-herdr"></a>

## 结合 Herdr 远程管理会话

默认情况下，Maestro Mobile 仅用于查看和操作电脑桌面端「已打开」的 Pi 会话窗口。与 **[Herdr](https://herdr.dev)** 搭配使用后，即可解锁完整的远程生命周期管理能力：直接在手机端新建独立会话、恢复历史对话并远程优雅关闭会话。

<p align="center">
  <a href="docs/images/screenshots/ios-launch-session.png"><img src="docs/images/screenshots/ios-launch-session.png" width="220" alt="通过 Herdr 新建会话：运行时与常用工作目录选择" /></a>
</p>

### 什么是 Herdr？

[Herdr](https://herdr.dev) 是专为 AI 编码智能体设计的终端多工作区复用管理器（Terminal Workspace Manager for AI Coding Agents）。它在后台作为轻量级守护进程运行，集中托管和维护多个命令行智能体（如 Pi、Claude、Codex 等）的工作区窗口与进程生命周期。

- **官方网站与文档**：[https://herdr.dev](https://herdr.dev)
- **最低版本要求**：`≥ 0.9.5`

### 1. 在电脑端安装 Herdr

在运行 Host 的电脑上通过 Homebrew（macOS）或官方脚本安装：

```bash
# macOS (Homebrew)
brew install herdr

# 或使用官方安装脚本
curl -fsSL https://herdr.dev/install.sh | bash
```

检查安装与后台服务状态：

```bash
herdr --version      # 要求 >= 0.9.5
herdr status server  # 查看本地后台守护服务状态
```

*提示：在终端中直接运行一次 `herdr`，后台守护服务会自动启动。*

### 2. 在 Maestro Mobile 中使用

当电脑端已安装并启动 Herdr 后，移动端会自动识别并在界面中启用对应功能：

- **远程新建会话（右上角 `+` 号）**：进入 App「会话」Tab，点击右上角的 `+` 按钮即可进入新建页。选择目标运行时（`自动` / `Pi-bolt` / `Pi`），从常用工作目录中点选工程路径（或手动输入绝对路径），设置可选窗口标签后点击「启动会话」。Herdr 将在桌面自动拉起独立工作区窗口，手机端立即接管并开始对话。
- **维护常用工作目录（`/maestro-mobile manager-fav`）**：在桌面 Pi TUI 执行 `/maestro-mobile manager-fav`，呼出弹窗快速收藏常用项目路径；也可在手机端「设置 → Herdr 会话启动 → 常用工作目录」中集中管理。
- **历史会话一键恢复**：在手机上查阅历史只读会话时，详情页顶栏提供恢复入口，Herdr 会自动在桌面新建窗口并加载历史上下文继续执行。
- **远程优雅结束会话**：在会话详情页菜单选择关闭会话，Host 会通过 Herdr 向目标窗口发送 `Ctrl+D` 信号让智能体安全退出，并在开启「自动清理空窗口」时自动回收窗格。

<a id="peer-messaging"></a>

## 会话间消息（`/mb-peer`）

`/mb-peer` 是独立于 Mobile App 的 Pi TUI 功能，通过 Desktop Broker 在在线 Pi 会话之间发送消息。

| 命令 | 用途 |
| --- | --- |
| `/mb-peer list` | 列出当前会话已获准联系的在线会话。 |
| `/mb-peer send <session ID 或前缀> <消息>` | 发送消息。Pi 支持原生命令补全；若前缀匹配多个会话，可从交互列表选择目标。 |
| `/mb-peer inbox` | 查看当前 TUI 收到且尚未过期的消息。 |
| `/mb-peer access` | 列出在线会话与现有授权，包括尚未获准的会话。 |
| `/mb-peer access <session ID 或前缀>` | 选择会话并授予访问权限。 |
| `/mb-peer revoke <授权 ID>` | 撤销当前工作目录创建的用户授权。 |

默认情况下，同一**工作目录**下的在线 peer 可以互相发送消息。跨目录发送须明确确认，并选择**单向**或**双向**授权。授权成功前不会发送消息；授权后需重新执行 `/mb-peer send`。授权会在 Broker 重启后保留；命令不能撤销由管理员配置的规则。

回执中的 `accepted` 表示接收端 Plugin 已将消息放入临时收件箱，不代表对方已经阅读、回复或采取行动。双方都须是在线的 Pi TUI 会话，并加载兼容的 Desktop Plugin、连接 Broker；历史会话和仅连接 Mobile App 的设备不是 peer。

<a id="usage"></a>

## 日常使用

在 **Workbench** 查看进度，在 **Sessions** 继续对话，在 **Monitor** 跟进工作区动态。Ask / Plan 需要目标 Pi 会话加载 Flow，Monitor / Teammate 数据来自 `pi-maestro-teammate`。

| 桌面命令 | 用途 |
| --- | --- |
| `/maestro-mobile status` | 查看 Host 状态与探测到的版本。 |
| `/maestro-mobile status --current` | 诊断当前桌面连接。 |
| `/maestro-mobile manager-fav` | 在桌面 TUI 中维护和收藏常用工作目录，供手机端新建会话使用。 |
| `/maestro-mobile stop` | 停止扩展管理的 Host。 |
| `/maestro-mobile notify` | 配置通知 Provider 与事件。 |

配对失败时，检查电脑地址和防火墙端口 `4739`；会话可见但不能操作时，检查 `status --current`，并确认它是运行中的桌面会话。升级与排障详见 [使用指南（英文）](docs/usage.md)。

<a id="documentation"></a>

## 相关文档

- [使用指南（英文）](docs/usage.md)：连接、升级、排障与 [`/mb-peer` 会话消息](docs/usage.md#peer-messaging)。
- [部署指南](docs/deploy.md)：独立 Host、launchd、systemd 与 Docker。
- [开发指南（英文）](docs/development.md)：源码准备、原生构建与贡献检查。
- [架构说明](docs/architecture.md) · [协议与 API](docs/protocol.md)：实现参考。
- [更新日志](CHANGELOG.md)：版本变更。

<a id="contributing"></a>

## 参与贡献

通过 [GitHub Issues](https://github.com/netcookies/pi-maestro-app-party/issues) 反馈问题或提出建议。代码贡献请参照 [开发指南](docs/development.md)，并提交 Pull Request。

<a id="license"></a>

## 许可证

本项目使用 [MIT License](LICENSE)。

<p align="right"><a href="#readme-top">返回顶部 ↑</a></p>
