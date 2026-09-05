# Maestro Mobile

<p align="center">
  <img src="docs/images/banner.svg" alt="Maestro Mobile" width="640" />
</p>

**在手机上用你的 PC 端 Pi Agent —— 包括 pi-maestro-flow 的 teammate 多智能体协作。**

你在 PC 上用 Pi 写代码、跑 maestro workflow、派 teammate 干活。这个项目让你**躺到沙发上，用手机继续盯着它、跟它聊、回答它的提问、看每个 teammate 在干嘛** —— 全程走局域网直连，数据不过公网。

```text
手机（Expo App）  ←——  局域网 WebSocket  ——→  PC（Node Host 进程）  ←→  Pi Agent / pi-maestro-flow
```

## 它能干什么

- **📱 完整对话**：手机上继续 PC 端的 Pi 会话，发消息、打断（steer / abort）、切换 model 和 thinking
- **❓ ask 弹窗闭环**：Pi 用 `ask-user-question` 提问时，手机上直接弹出选项卡片——这是本项目的核心价值，一般远程方案里 ask 是失效的
- **🤝 Teammate 面板**：实时看到每个 Pi 会话派出去的 teammate agent（名字 / 状态 / 正在干什么的日志尾巴）
- **📊 Monitor 面板**：所有 Pi 会话窗口一屏总览（运行中 / 睡眠 / 掉线）
- **🗂 会话管理**：搜索历史会话、重命名、compact
- **⚙️ Maestro 设置**：手机上直接改 host 侧 maestro 配置文件

> 一句话：**PC 上的 Pi 在干什么，手机上就看得见、答得上、管得了。**

## 快速开始

前提：Node ≥ 22.19、pnpm ≥ 10、Pi agent 可用（含 pi-maestro-flow）。

```bash
git clone https://github.com/netcookies/pi-maestro-app-party.git
cd pi-maestro-app-party
pnpm install

# 1) PC 端启动 Host（端口 4739）
pnpm dev:host

# 2) 手机端（或 iOS 模拟器）
pnpm dev:app
```

手机 App 里填 `ws://<PC 的局域网 IP>:4739/ws` 即可连上。

> 📖 **详细文档**：[架构](docs/architecture.md) · [协议](docs/protocol.md) · [构建安装包](#构建安装包) · [部署](#常驻部署) · [安全](#安全)

## 构建安装包

```bash
# Android APK
pnpm --filter @maestro-mobile/app prebuild --platform android
cd apps/mobile/android && ./gradlew assembleDebug
# 产物: apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk

# iOS 模拟器
pnpm --filter @maestro-mobile/app prebuild --platform ios
cd apps/mobile/ios && pod install
xcodebuild -workspace MaestroMobile.xcworkspace -scheme MaestroMobile \
  -configuration Debug -sdk iphonesimulator -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO build
```

iOS 真机需要 Apple Developer 签名（`xcodebuild -configuration Release -sdk iphoneos ... -allowProvisioningUpdates`）。

## 常驻部署

- **macOS**: `deploy/com.maestro-mobile.host.plist`（launchd）
- **Linux**: `deploy/maestro-mobile-host.service`（systemd）
- **Docker**: `Dockerfile`

## 安全

- 默认监听 `0.0.0.0`：建议设置 `MAESTRO_MOBILE_TOKEN`（Bearer header 或 `?token=`）
- 或仅监听 `127.0.0.1` + Tailscale/SSH 隧道
- 移动端是 Pi 的远程入口，可执行命令：**不要**在无鉴权的公网上暴露

## 为什么 ask-question 在 remote-pi 失效，这里可用

pi-maestro-flow 的 `ask-user-question` 工具在 TUI 模式走 `ctx.ui.custom`（终端面板），在远程环境不可见。

本项目使用 **SDK Host 模式**（`createAgentSession` + `bindExtensions({ mode: "rpc", uiContext })`）：
- maestro ask 在 RPC 模式自动映射为 `ctx.ui.select/input/confirm`
- host 的 `MobileExtensionUiBridge` 把这些调用转为 `extension_ui_request` 事件
- 移动端 `ExtensionUiQueue` 收到后弹窗渲染，用户作答后返回
- **ask 闭环在移动端完整可用**

## 路线图

- [x] P0 monorepo 骨架 + 直连服务器
- [x] P1 Maestro Bridge（flow-schedule 投影 + 变更检测）
- [x] P2 移动端核心逻辑（HostClient + ExtensionUiQueue + AppState）
- [x] P3 E2E 联调（ask 闭环 / maestro 状态流 / 重连）
- [x] P4 常驻启动 + 部署配置
- [x] P5 Teammate / Monitor Tab（workspace telemetry 合同）
- [ ] 后续：owner 详情页（contextPressure / backgroundJobs / settled）、图片附件、推送通知

## License

[MIT](LICENSE)
