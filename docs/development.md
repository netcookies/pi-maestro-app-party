# Development guide

[README](../README.md) · [中文首页](../README.zh-CN.md)

## Source setup

Use **Node.js ≥ 22.19** and **pnpm 10.8.1**, as declared in [package.json](../package.json).

```bash
git clone https://github.com/netcookies/pi-maestro-app-party.git
cd pi-maestro-app-party
pnpm install
pnpm build
```

| Directory | Responsibility |
| --- | --- |
| `apps/mobile/` | Expo / React Native app |
| `apps/host/` | Host CLI, Pi extensions, Desktop Broker and Plugin |
| `packages/shared/` | Protocol types and validators |
| `packages/mobile-sdk/` | Mobile transport SDK |

## Run the Host

From the repository root:

```bash
node apps/host/dist/cli.js --host 0.0.0.0 --port 4739
```

Use `--project-root /path/to/project` to select the project's Flow scheduling data. For live desktop control, the target Pi TUI must also load the Mobile Desktop Plugin and connect to the Broker; starting the Host alone is insufficient.

For persistent services and Docker, see the [deployment guide (中文)](deploy.md).

## Run the mobile app

Complete source setup first. Android requires the Android SDK and a device or emulator; iOS requires macOS, Xcode and CocoaPods.

From the repository root, choose a platform:

```bash
pnpm --filter @maestro-mobile/app android
```

```bash
pnpm --filter @maestro-mobile/app ios
```

The app pairs with a running Host through **Settings**. Source builds use the same desktop setup and pairing flow as [Getting started](../README.md#getting-started).

## Check your changes

Run checks in the affected package, selecting a test file when possible. For example, a Host change can be checked with:

```bash
pnpm --filter pi-maestro-mobile typecheck
pnpm --filter pi-maestro-mobile test path/to/affected.test.ts
```

Replace the test path with an existing relevant file. Root-level `pnpm typecheck` and `pnpm test` cover all workspaces and are used by the release script.

For changes that affect mobile bundling:

```bash
pnpm --filter @maestro-mobile/app exec expo export --platform android --platform ios --output-dir dist
```

**Shared protocol changes require a rebuild.** The Host resolves validators from `@maestro-mobile/shared/dist`, so rebuild before checking runtime behavior:

```bash
pnpm --filter @maestro-mobile/shared build
```

Type checks and source tests alone cannot prove that the running Host is using the new validators. Verify affected behavior through a real Host / Broker / Plugin connection. Details: [Host build coupling](../apps/host/README.md#构建与产物耦合重要).

## Native release builds

For a local Android release APK, configure release signing and run:

```bash
cd apps/mobile/android
./gradlew assembleRelease
```

For an iOS archive, configure Apple signing and run:

```bash
cd apps/mobile/ios
xcodebuild -workspace MaestroMobile.xcworkspace -scheme MaestroMobile -configuration Release archive
```

The [release workflow](../.github/workflows/release.yml) publishes a signed Android APK and an unsigned iOS IPA; iOS users must re-sign the IPA before installing it.

Versioning and release notes are managed by [scripts/release.mjs](../scripts/release.mjs). The script checks the worktree, runs type checks and tests, bumps versions, commits, tags and pushes. The Host package's `prepublishOnly` builds and tests before npm publication.

## Implementation reference

- [Architecture (中文)](architecture.md): Host, Broker, Desktop Plugin and mobile responsibilities.
- [Protocol and API (中文)](protocol.md): HTTP / WebSocket contracts and desktop routing.
- [Host package (中文)](../apps/host/README.md): CLI options and build constraints.

The Desktop Broker routes `/mb-peer` only between live, online Desktop Plugin targets. It addresses the exact session, endpoint, working directory and process generation; it never guesses from a session name or historical record. Cross-directory access must be explicitly granted. User-managed grants persist in `~/.pi/maestro-mobile/peer-access.json`; do not edit the file while the Broker is running.

`/mb-peer` uses the Desktop Broker and Pi TUI, independently of the Mobile Host HTTP / WebSocket interface and app. For wire frames and target identity, see [Protocol and API (中文)](protocol.md).

Flow is independently installed through Pi, rather than an npm dependency of Mobile. Ask / Plan support requires the target TUI to load a compatible stable `pi-maestro-flow`, with both `ask-user-question` and `plan` from the same package, transport exports and shared registry contracts. The command-time dependency check warns and continues basic commands; it is not runtime capability negotiation. Installed versions do not prove the in-memory extensions have reloaded.

Mobile / Desktop Plugin uses protocol **v2**; Desktop Broker uses protocol **v1**. Protocol versions increase for breaking wire changes. The desktop TUI owns the Pi session; the Host reads history and forwards authorized controls through the Broker. See the protocol guide for exact target identity and authorization boundaries.

## Contributing

Describe the problem and expected behavior in an issue or pull request, keep changes focused, and include the relevant verification results. Do not include connection tokens or unredacted Host logs.
