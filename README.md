<a id="readme-top"></a>

<div align="center">
  <img src="apps/mobile/assets/icon.png" alt="Maestro Mobile app icon" width="80" height="80" />
  <h1>Maestro Mobile</h1>
  <p>Follow your Pi sessions and keep work moving from your phone.</p>
  <p><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>
  <p>
    <a href="https://github.com/netcookies/pi-maestro-app-party/releases/latest"><img src="https://img.shields.io/github/v/release/netcookies/pi-maestro-app-party" alt="Latest release" /></a>
    <a href="https://www.npmjs.com/package/pi-maestro-mobile"><img src="https://img.shields.io/npm/v/pi-maestro-mobile" alt="npm version" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" /></a>
  </p>
  <p>
    <a href="https://github.com/netcookies/pi-maestro-app-party/releases/latest"><strong>Download the app »</strong></a>
    <br /><br />
    <a href="#getting-started">Get started</a> ·
    <a href="https://github.com/netcookies/pi-maestro-app-party/issues/new">Report a bug</a> ·
    <a href="https://github.com/netcookies/pi-maestro-app-party/issues">Request a feature</a>
  </p>
</div>

<details>
  <summary>Table of Contents</summary>
  <ol>
    <li><a href="#about-the-project">About the project</a></li>
    <li><a href="#getting-started">Getting started</a></li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#documentation">Documentation</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
  </ol>
</details>

## About the project

Maestro Mobile is an iOS / Android companion for [Pi](https://github.com/badlogic/pi-mono). Your sessions run on your computer; the app connects through a local Host service to show progress and control authorized live sessions.

<p align="center">
  <a href="docs/images/screenshots/ios-launched.png"><img src="docs/images/screenshots/ios-launched.png" width="220" alt="Workbench: usage, tasks and pending actions" /></a>
  <a href="docs/images/screenshots/ios-sessions.png"><img src="docs/images/screenshots/ios-sessions.png" width="220" alt="Sessions: browse and filter Pi sessions" /></a>
  <a href="docs/images/screenshots/ios-chat.png"><img src="docs/images/screenshots/ios-chat.png" width="220" alt="Chat: messages, history and tool output" /></a>
</p>

- **Stay informed:** browse sessions, search history, and check usage, tasks and teammates.
- **Keep working:** send text or images, steer a running turn, queue a follow-up, switch models or stop a task.
- **Make decisions:** answer Ask questions and review Plans from the app when the desktop session has compatible `pi-maestro-flow` loaded.
- **Stay connected:** pair with a QR code or short code, reconnect automatically, and receive task notifications.

Available actions depend on the desktop session's permissions and capabilities. Historical sessions are read-only; new Pi sessions start on the desktop. Docker deployments provide a read-only dashboard.

## Getting started

### Prerequisites

- A computer with **Node.js ≥ 22.19** and Pi installed. macOS / Linux is recommended for the Host.
- An iOS or Android phone that can reach the computer over your LAN or a private tunnel such as Tailscale / WireGuard.

### 1. Set up the desktop

Install the Mobile extension in Pi:

```bash
pi install npm:pi-maestro-mobile
```

For Ask / Plan support, also install Flow:

```bash
pi install npm:pi-maestro-flow
```

Enable the installed extensions, including the Mobile Desktop Plugin, through `pi config`. In an existing Pi session, run `/reload` or restart Pi, then:

```text
/maestro-mobile start
/maestro-mobile qr
```

### 2. Install the app

Download the files from [the latest release](https://github.com/netcookies/pi-maestro-app-party/releases/latest):

| Platform | Installation |
| --- | --- |
| Android | Install the signed `.apk`; allow installation from this source if prompted. |
| iOS | Download the unsigned `.ipa`, then sign and install it with your Apple ID using [Sideloadly](https://sideloadly.io/) or AltStore. |

Prefer to build locally? See the [development guide](docs/development.md#run-the-mobile-app).

### 3. Pair and open a session

In the app, open **Settings** and scan the desktop QR code. Alternatively, enter the **8-character short code** and the computer's LAN address. Open **Sessions** and select an existing session.

The app saves your connection and reconnects automatically. The default endpoint is `ws://<computer-ip>:4739/ws`; the Host requires a token. Use a private tunnel for access outside your LAN.

## Usage

Use **Workbench** for progress, **Sessions** for conversations, and **Monitor** for workspace activity. Ask / Plan requires Flow in the target Pi session; Monitor / Teammate data comes from `pi-maestro-teammate`.

| Desktop command | Purpose |
| --- | --- |
| `/maestro-mobile status` | Check Host status and detected versions. |
| `/maestro-mobile status --current` | Diagnose the current desktop connection. |
| `/maestro-mobile stop` | Stop the extension-managed Host. |
| `/maestro-mobile notify` | Configure notification providers and events. |

If pairing fails, check the computer address and firewall port `4739`. If a visible session cannot be controlled, check `status --current` and confirm it is a running desktop session. See the [user guide](docs/usage.md) for updates and troubleshooting.

## Documentation

- [User guide](docs/usage.md) — connection, updates, troubleshooting and more screenshots.
- [Deployment guide (中文)](docs/deploy.md) — standalone Host, launchd, systemd and Docker.
- [Development guide](docs/development.md) — source setup, native builds and contribution checks.
- [Architecture (中文)](docs/architecture.md) · [Protocol and API (中文)](docs/protocol.md) — implementation reference.
- [Changelog](CHANGELOG.md) — release history.

## Contributing

Report bugs or suggest features through [GitHub Issues](https://github.com/netcookies/pi-maestro-app-party/issues). For code contributions, follow the [development guide](docs/development.md) and open a pull request.

## License

Distributed under the [MIT License](LICENSE).

<p align="right"><a href="#readme-top">Back to top ↑</a></p>
