#!/usr/bin/env node
/**
 * Real dual-process Review & Refine acceptance probe.
 *
 * Verifies the "TUI is authority, remote is mirror" contract using four real
 * long-lived processes: a real `pi` TUI inside tmux, a real Host, and a real
 * Broker. Nothing is an in-process stand-in: every frame is captured from the
 * wire or from a child process log, and the TUI is driven by real keystrokes
 * against a real PTY whose screen is captured as evidence.
 *
 * Cases:
 *   R1  TUI opens the refine overlay; the remote mirror receives the handshake.
 *   R2  A remote `run` intent replays into the local overlay and yields a turn.
 *   R3  A remote `discard` intent drives the local overlay to discard locally.
 *   R4  A remote `cancel` intent exits locally without reopening plan confirm.
 *
 * Isolation (per prior probe hazards R-01/R-02/R-06): every socket, secret,
 * registry, log and PID lives under a private run directory; the user's live
 * Broker/Host/sockets are inventoried before and after and never touched.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import WebSocket from "ws";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runDir = resolve(process.env.REFINE_PROBE_RUN_DIR ?? "");
const flowRoot = resolve(process.env.PI_MAESTRO_FLOW_ROOT ?? "");
const provider = process.env.REFINE_PROBE_PROVIDER ?? "my-sub2api-opencode";
const model = process.env.REFINE_PROBE_MODEL ?? "deepseek-v4.1-flash";
const overlayWaitMs = Number(process.env.REFINE_PROBE_OVERLAY_TIMEOUT_MS ?? 180000);
const runTurnWaitMs = Number(process.env.REFINE_PROBE_RUN_TIMEOUT_MS ?? 420000);
const tmuxSession = `refine-probe-${randomBytes(4).toString("hex")}`;
const evidenceDir = join(runDir, "evidence");
const outputDir = join(runDir, "outputs");
const privateDir = join(runDir, "private");
const hostDist = join(repoRoot, "apps/host/dist");

const required = (name, value) => {
  if (!value || !value.startsWith("/")) throw new Error(`${name} must be an absolute path`);
};
required("REFINE_PROBE_RUN_DIR", runDir);
required("PI_MAESTRO_FLOW_ROOT", flowRoot);

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const exists = async (path) => Boolean(await stat(path).catch(() => undefined));
const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};
const appendJsonLine = async (path, value) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(value)}\n`);
};
const readJsonLines = async (path) => {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};
const commandText = (command, args) => [command, ...args].map((v) => JSON.stringify(v)).join(" ");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sameTarget = (l, r) => Boolean(l && r && l.sessionId === r.sessionId && l.endpointId === r.endpointId && l.normalizedCwd === r.normalizedCwd && l.processGeneration === r.processGeneration);

const records = [];
const tasks = {};
const mobileFrames = [];
const children = [];
const paneScreens = [];
let env;

function redacted(value) {
  let text = String(value ?? "");
  for (const secret of [env?.secret, env?.token]) if (secret) text = text.split(secret).join("[REDACTED]");
  return text.replace(/(api[_-]?key|token|secret|authorization)\s*[:=]\s*[^\s,}]+/gi, "$1=[REDACTED]");
}

async function run(command, args, options = {}) {
  const startedAt = now();
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    timeout: options.timeout ?? 180000,
  });
  records.push({
    command: commandText(command, args),
    startedAt,
    endedAt: now(),
    exitCode: result.status ?? 1,
    signal: result.signal ?? null,
    stdout: redacted(result.stdout),
    stderr: redacted(result.stderr),
  });
  return records.at(-1);
}

function freePort() {
  return new Promise((res, rej) => {
    const server = net.createServer();
    server.unref();
    server.on("error", rej);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => res(port));
    });
  });
}

function childEnv() {
  return {
    HOME: env.dirs.home,
    XDG_CONFIG_HOME: env.dirs.xdgConfig,
    XDG_DATA_HOME: env.dirs.xdgData,
    XDG_STATE_HOME: env.dirs.xdgState,
    PI_CODING_AGENT_DIR: env.dirs.piAgent,
    PI_AGENT_DIR: env.dirs.piAgent,
    PI_CODING_AGENT_SESSION_DIR: env.dirs.sessions,
    PI_OFFLINE: "0",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    MAESTRO_MOBILE_PROJECT_ROOT: repoRoot,
    MAESTRO_MOBILE_HOST: "127.0.0.1",
  };
}

async function setup() {
  await rm(privateDir, { recursive: true, force: true });
  await Promise.all([
    mkdir(evidenceDir, { recursive: true, mode: 0o700 }),
    mkdir(outputDir, { recursive: true, mode: 0o700 }),
    mkdir(privateDir, { recursive: true, mode: 0o700 }),
  ]);
  const dirs = {
    home: join(privateDir, "home"),
    xdgConfig: join(privateDir, "xdg-config"),
    xdgData: join(privateDir, "xdg-data"),
    xdgState: join(privateDir, "xdg-state"),
    piAgent: join(privateDir, "pi-agent"),
    sessions: join(privateDir, "pi-sessions"),
    ipc: join(privateDir, "ipc"),
    runtime: join(privateDir, "runtime"),
    logs: join(privateDir, "logs"),
    registry: join(privateDir, "registry"),
    tmp: join(privateDir, "tmp"),
    workspace: join(privateDir, "workspace"),
  };
  await Promise.all(Object.values(dirs).map((p) => mkdir(p, { recursive: true, mode: 0o700 })));

  const nonce = `refine-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
  const socketRoot = join("/tmp", `maestro-${nonce}`);
  await mkdir(socketRoot, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString("hex");
  const token = randomBytes(32).toString("hex");
  const paths = {
    secretFile: join(dirs.ipc, "broker-secret"),
    tokenFile: join(dirs.ipc, "host-token"),
    pluginSocket: join(socketRoot, "plugin.sock"),
    hostSocket: join(socketRoot, "host.sock"),
    socketRoot,
    registry: join(dirs.registry, "desktop-plugin-registry.json"),
    brokerPid: join(dirs.runtime, "broker.pid"),
    hostPid: join(dirs.runtime, "host.pid"),
    brokerLog: join(dirs.logs, "broker.log"),
    hostLog: join(dirs.logs, "host.log"),
    tmuxLog: join(dirs.logs, "tmux-pane.log"),
  };
  await writeFile(paths.secretFile, `${secret}\n`, { mode: 0o600 });
  await writeFile(paths.tokenFile, `${token}\n`, { mode: 0o600 });

  // teammate-models.json drives teammate/subagent routing; without it the refine
  // role subagent cannot select a model and produces no turn.
  const credentialSymlinks = [];
  for (const name of ["models.json", "auth.json", "teammate-models.json"]) {
    const path = join(dirs.piAgent, name);
    const target = join(homedir(), ".pi", "agent", name);
    await unlink(path).catch(() => {});
    await symlink(target, path);
    credentialSymlinks.push({ path, target, contentsCaptured: false });
  }

  // The Flow extension under test self-imports `maestro-flow/dist/...`, which only
  // resolves when a published `maestro-flow` package is reachable. Link the
  // published package rather than copying 318MB, so the PR branch source stays
  // the code under test.
  const flowNodeModules = join(dirs.piAgent, "..", "node_modules");
  const maestroFlowLink = join(flowNodeModules, "maestro-flow");
  await mkdir(flowNodeModules, { recursive: true, mode: 0o700 });
  await rm(maestroFlowLink, { recursive: true, force: true }).catch(() => {});
  await symlink(join(homedir(), ".pi", "agent", "npm", "node_modules", "maestro-flow"), maestroFlowLink);
  const flowSelfDeps = [maestroFlowLink];

  const forbidden = [
    join(homedir(), ".pi", "maestro-mobile", "ipc", "desktop-plugin.sock"),
    join(homedir(), ".pi", "maestro-mobile", "ipc", "desktop-broker-host.sock"),
    join(homedir(), ".pi", "maestro-mobile", "desktop-plugin-registry.json"),
    join(homedir(), ".pi", "maestro-mobile-ipc-secret"),
    join(homedir(), ".pi", "maestro-mobile.pid"),
  ];
  const initialDefaults = await Promise.all(forbidden.map(async (path) => ({
    path, exists: await exists(path), sha256: await sha256(path).catch(() => null),
  })));

  env = {
    runDir, repoRoot, evidenceDir, outputDir, privateDir, dirs, paths, nonce, secret, token,
    port: await freePort(), credentialSymlinks, flowSelfDeps, forbidden, initialDefaults,
    processes: [], createdAt: now(), tmuxSession,
  };
  await writeJson(join(privateDir, "env.json"), env);
  await writeJson(join(evidenceDir, "process-socket-manifest.initial.json"), {
    schemaVersion: 1, phase: "initial", runDir, provider, model, paths, dirs,
    credentialSymlinks, forbidden: initialDefaults, defaultPathAccess: false, private: true, flowSelfDeps,
  });

  const listModels = await run("pi", ["--list-models"], { env: childEnv(), timeout: 60000 });
  await writeFile(join(evidenceDir, "pi-list-models.redacted.txt"), redacted(`${listModels.stdout}\n${listModels.stderr}`), { mode: 0o600 });
  if (listModels.exitCode !== 0) throw new Error(`pi model preflight failed: ${listModels.stderr}`);

  for (const id of ["R1", "R2", "R3", "R4"]) tasks[id] = { id, status: "pending" };
}

async function writeBroker() {
  const path = join(privateDir, "broker.mjs");
  await writeFile(path, `import { appendFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
const env = JSON.parse(await (await import("node:fs/promises")).readFile(process.env.PROBE_ENV, "utf8"));
const log = (event) => appendFile(join(env.evidenceDir, "broker.frames.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\\n").catch(() => {});
const { DesktopBroker, DesktopBrokerHostClient } = await import(${JSON.stringify(join(hostDist, "plugin/desktop-broker.js"))});
const broker = new DesktopBroker({ pluginSocketPath: env.paths.pluginSocket, registryPath: env.paths.registry, secret: env.secret, onFrame: (frame) => void log({ event: "broker_frame", frame }) });
const hostClient = new DesktopBrokerHostClient(broker, { socketPath: env.paths.hostSocket, secret: env.secret, onConnected: () => void log({ event: "host_link_connected" }), onDisconnected: () => void log({ event: "host_link_disconnected" }) });
await broker.start(); await writeFile(env.paths.brokerPid, String(process.pid) + "\\n", { mode: 0o600 }); void log({ event: "broker_ready", pid: process.pid, brokerInstanceId: broker.brokerInstanceId }); hostClient.start();
let stopping = false; const stop = async () => { if (stopping) return; stopping = true; hostClient.close(); await broker.close().catch(() => {}); await unlink(env.paths.brokerPid).catch(() => {}); process.exit(0); }; process.on("SIGTERM", () => void stop()); process.on("SIGINT", () => void stop()); process.on("uncaughtException", (e) => { void log({ event: "broker_error", error: String(e) }); void stop(); }); process.on("unhandledRejection", (e) => { void log({ event: "broker_rejection", error: String(e) }); void stop(); });
`, { mode: 0o600 });
  return path;
}

async function writeHost() {
  const path = join(privateDir, "host.mjs");
  await writeFile(path, `import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
const env = JSON.parse(await readFile(process.env.PROBE_ENV, "utf8"));
const log = (event) => appendFile(join(env.evidenceDir, "host.frames.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\\n").catch(() => {});
const { DesktopBrokerHostIpc, DesktopBrokerProjectedRegistry } = await import(${JSON.stringify(join(hostDist, "plugin/desktop-broker-host-ipc.js"))});
const { HostController } = await import(${JSON.stringify(join(hostDist, "host-controller.js"))});
const { MobileHostServer } = await import(${JSON.stringify(join(hostDist, "server/mobile-host-server.js"))});
const { PiSessionCatalog } = await import(${JSON.stringify(join(hostDist, "pi/pi-sdk-runtime.js"))});
const { MaestroStateReader } = await import(${JSON.stringify(join(hostDist, "maestro-state.js"))});
const sessionCatalog = new PiSessionCatalog(env.repoRoot);
const maestroReader = new MaestroStateReader({ projectRoot: env.repoRoot });
const projection = new DesktopBrokerProjectedRegistry();
const controller = new HostController(sessionCatalog, maestroReader, projection);
const rawRefine = controller.respondToDesktopRefine.bind(controller);
controller.respondToDesktopRefine = async (...args) => { void log({ event: "gateway_refine_in", target: args[1], actionId: args[0]?.actionId, action: args[0]?.action?.action }); const result = await rawRefine(...args); void log({ event: "gateway_refine_out", target: args[1], actionId: args[0]?.actionId, result }); return result; };
const ipc = new DesktopBrokerHostIpc({ socketPath: env.paths.hostSocket, secret: env.secret, projection, onProjection: (records2, brokerInstanceId, revision) => { const safe = records2.map((r) => ({ ...r, target: { ...r.target } })); void log({ event: "projection", brokerInstanceId, revision, records: safe }); const p = join(env.evidenceDir, "host-projection.json"); const tmp = p + ".tmp-" + process.pid + "-" + revision; void writeFile(tmp, JSON.stringify({ at: new Date().toISOString(), writerPid: process.pid, brokerInstanceId, revision, records: safe }, null, 2) + "\\n", { mode: 0o600 }).then(() => rename(tmp, p)).catch(() => {}); controller.applyDesktopProjection(records2); }, onAskRequest: (target, request) => controller.onDesktopAskRequest(target, request), onPlanRequest: (target, request) => controller.onDesktopPlanRequest(target, request), onPlanRefine: (target, message) => controller.onDesktopPlanRefine(target, message), onDisconnected: () => void log({ event: "host_disconnected" }) });
const server = new MobileHostServer(controller, { token: env.token }); await ipc.start(); await server.listen(env.port, "127.0.0.1"); await writeFile(env.paths.hostPid, String(process.pid) + "\\n", { mode: 0o600 }); void log({ event: "host_ready", pid: process.pid, port: env.port });
let stopping = false; const stop = async () => { if (stopping) return; stopping = true; await server.close().catch(() => {}); await controller.dispose().catch(() => {}); await ipc.close().catch(() => {}); process.exit(0); }; process.on("SIGTERM", () => void stop()); process.on("SIGINT", () => void stop()); process.on("uncaughtException", (e) => { void log({ event: "host_error", error: String(e) }); void stop(); }); process.on("unhandledRejection", (e) => { void log({ event: "host_rejection", error: String(e) }); void stop(); });
`, { mode: 0o600 });
  return path;
}

/**
 * Build a private, resolvable copy of the Flow package under test.
 *
 * The extension self-imports `maestro-flow/dist/...`, which only resolves when
 * the package sits inside a node_modules tree that also exposes `maestro-flow`.
 * The PR source tree deliberately does not self-link, so we materialize the
 * source (11MB) under the private root, point node_modules at the real
 * dependency tree, and link the published `maestro-flow` alongside it. This keeps
 * the code under test exactly the PR branch source while making it loadable.
 */
async function stageFlowCopy() {
  const stage = join(privateDir, "flow-under-test");
  const { cp } = await import("node:fs/promises");
  await mkdir(stage, { recursive: true, mode: 0o700 });
  await cp(join(flowRoot, "package.json"), join(stage, "package.json"));
  await cp(join(flowRoot, "src"), join(stage, "src"), { recursive: true });
  if (await exists(join(flowRoot, ".pi"))) await cp(join(flowRoot, ".pi"), join(stage, ".pi"), { recursive: true });
  if (await exists(join(flowRoot, "schemas"))) await cp(join(flowRoot, "schemas"), join(stage, "schemas"), { recursive: true });
  if (await exists(join(flowRoot, "templates"))) await cp(join(flowRoot, "templates"), join(stage, "templates"), { recursive: true });
  if (await exists(join(flowRoot, "scripts"))) await cp(join(flowRoot, "scripts"), join(stage, "scripts"), { recursive: true });
  if (await exists(join(flowRoot, "bin"))) await cp(join(flowRoot, "bin"), join(stage, "bin"), { recursive: true });

  // Node resolves bare specifiers by walking up from the importing file. The Flow
  // source tree cannot resolve its own dependencies in this environment (even
  // `puppeteer-core` fails from the PR checkout), while the published install
  // resolves cleanly. Stage the source inside the install tree so resolution
  // matches the real runtime, and link the self-referential `maestro-flow`.
  const installRoot = join(homedir(), ".pi", "agent", "npm", "node_modules");
  const stageNodeModules = join(stage, "node_modules");
  await mkdir(stageNodeModules, { recursive: true, mode: 0o700 });

  // Workspace siblings (pi-maestro-settings-core, pi-cockpit, ...) must resolve to
  // the PR checkout so the code under test is exercised, while third-party deps
  // resolve from the real install tree where they actually exist.
  const packagesDir = dirname(flowRoot);
  const workspacePackages = await readdir(packagesDir);
  let workspaceLinked = 0;
  for (const entry of workspacePackages) {
    if (!(await exists(join(packagesDir, entry, "package.json")))) continue;
    await symlink(join(packagesDir, entry), join(stageNodeModules, entry)).catch(() => {});
    workspaceLinked += 1;
  }

  // `maestro-flow` is a self-referential published dependency that ships the
  // compiled dist the extension imports; link it from the real install.
  await symlink(join(installRoot, "maestro-flow"), join(stageNodeModules, "maestro-flow"));

  let thirdPartyLinked = 0;
  for (const entry of await readdir(installRoot)) {
    if (entry === "maestro-flow" || entry.startsWith(".")) continue;
    await symlink(join(installRoot, entry), join(stageNodeModules, entry)).catch(() => {});
    thirdPartyLinked += 1;
  }
  await writeJson(join(stage, ".stage-metadata.json"), {
    at: now(), flowRoot, workspaceLinked, thirdPartyLinked, maestroFlowLinked: true, installRoot,
  });
  return { stage, extensionEntry: join(stage, "src", "extension", "index.ts") };
}

async function launch() {
  const brokerPath = await writeBroker();
  const brokerLog = await (await import("node:fs/promises")).open(env.paths.brokerLog, "a");
  const broker = spawn(process.execPath, [brokerPath], {
    cwd: repoRoot,
    env: { ...process.env, ...childEnv(), PROBE_ENV: join(privateDir, "env.json") },
    stdio: ["ignore", brokerLog.fd, brokerLog.fd],
    detached: true,
  });
  broker.unref(); await brokerLog.close(); children.push(broker); await sleep(1000);

  const hostPath = await writeHost();
  const hostLog = await (await import("node:fs/promises")).open(env.paths.hostLog, "a");
  const host = spawn(process.execPath, [hostPath], {
    cwd: repoRoot,
    env: { ...process.env, ...childEnv(), PROBE_ENV: join(privateDir, "env.json") },
    stdio: ["ignore", hostLog.fd, hostLog.fd],
    detached: true,
  });
  host.unref(); await hostLog.close(); children.push(host); await sleep(1800);

  const wrapper = join(privateDir, "pi-extension-wrapper.mjs");
  await writeFile(wrapper, `import { appendFile } from "node:fs/promises";
import { createDesktopPluginExtension } from ${JSON.stringify(join(hostDist, "plugin/desktop-plugin-extension.js"))};
const log = (event) => appendFile(${JSON.stringify(join(evidenceDir, "plugin.frames.jsonl"))}, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\\n").catch(() => {});
export default function (pi) { void log({ event: "wrapper_loaded" }); createDesktopPluginExtension({ socketPath: ${JSON.stringify(env.paths.pluginSocket)}, secretPath: ${JSON.stringify(env.paths.secretFile)}, endpointId: ${JSON.stringify(env.nonce + "-endpoint-a")}, processGeneration: ${JSON.stringify(env.nonce + "-generation-a")} })(pi); }
`, { mode: 0o600 });

  const stagedFlow = await stageFlowCopy();
  const piArgs = [
    "--approve", "--provider", provider, "--model", model, "--thinking", "medium",
    "--no-extensions",
    "--extension", stagedFlow.extensionEntry,
    "--extension", wrapper,
    "--session-dir", env.dirs.sessions,
    "--session-id", `${env.nonce}-session`,
    "--no-context-files",
  ];

  // Real Pi TUI inside tmux so real keystrokes can be delivered and the rendered
  // screen captured as evidence. `script` gives the pane a real PTY.
  const quoted = [process.env.PATH ? "pi" : "pi", ...piArgs].map((v) => `'${String(v).replace(/'/g, `'\\''`)}'`).join(" ");
  const paneCommand = `cd ${JSON.stringify(env.dirs.workspace)} && exec script -q ${JSON.stringify(env.paths.tmuxLog)} ${quoted}`;
  const tmuxNew = spawnSync("tmux", [
    "new-session", "-d", "-s", env.tmuxSession,
    "-x", "160", "-y", "50",
    paneCommand,
  ], { env: { ...process.env, ...childEnv() }, encoding: "utf8" });
  if (tmuxNew.status !== 0) throw new Error(`tmux new-session failed: ${tmuxNew.stderr}`);
  await sleep(6000);

  const piPidResult = spawnSync("tmux", ["list-panes", "-t", env.tmuxSession, "-F", "#{pane_pid}"], { encoding: "utf8" });
  const panePid = Number(String(piPidResult.stdout ?? "").trim().split(/\s+/)[0]);
  const childPids = spawnSync("pgrep", ["-P", String(panePid)], { encoding: "utf8" });
  const piPid = Number(String(childPids.stdout ?? "").trim().split(/\s+/).at(-1));
  if (!Number.isSafeInteger(panePid) || panePid < 1) throw new Error("tmux pane PID unavailable");
  children.push({ pid: panePid, kind: "tmux-pane" });
  if (Number.isSafeInteger(piPid) && piPid > 1) children.push({ pid: piPid, kind: "pi" });

  env.processes.push(
    { kind: "broker", pid: broker.pid, command: commandText(process.execPath, [brokerPath]) },
    { kind: "host", pid: host.pid, command: commandText(process.execPath, [hostPath]) },
    { kind: "tmux-pane", pid: panePid, command: paneCommand },
    ...(Number.isSafeInteger(piPid) && piPid > 1 ? [{ kind: "pi", pid: piPid, command: commandText("pi", piArgs) }] : []),
  );
  await writeJson(join(privateDir, "pids.json"), { processes: env.processes });
  await writeJson(join(privateDir, "env.json"), env);
}

async function capturePane(label) {
  const result = spawnSync("tmux", ["capture-pane", "-p", "-S", "-", "-t", env.tmuxSession], { encoding: "utf8" });
  const screen = result.stdout ?? "";
  paneScreens.push({ at: now(), label, screen });
  await appendJsonLine(join(evidenceDir, "pane.screens.jsonl"), { at: now(), label, screen });
  return screen;
}

async function sendKeys(keys, label = "keys") {
  const result = spawnSync("tmux", ["send-keys", "-t", env.tmuxSession, ...keys], { encoding: "utf8" });
  await appendJsonLine(join(evidenceDir, "pane.keys.jsonl"), { at: now(), label, keys });
  if (result.status !== 0) throw new Error(`tmux send-keys failed: ${result.stderr}`);
}

async function waitForPaneText(pattern, timeoutMs, label) {
  return waitUntil(async () => {
    const screen = await capturePane(label);
    return pattern.test(screen) ? screen : false;
  }, timeoutMs, label, 1000);
}

async function waitUntil(predicate, timeoutMs, label, interval = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) { lastError = error; }
    await sleep(interval);
  }
  throw new Error(`${label} timeout${lastError ? `: ${lastError}` : ""}`);
}

async function waitForProjection(timeoutMs = 60000) {
  return waitUntil(async () => {
    const value = JSON.parse(await readFile(join(evidenceDir, "host-projection.json"), "utf8"));
    const target = value.records?.[0]?.target;
    if (value.records?.length === 1 && value.brokerInstanceId
      && target?.sessionId === `${env.nonce}-session`
      && target?.endpointId === `${env.nonce}-endpoint-a`
      && target?.processGeneration === `${env.nonce}-generation-a`) return value;
    return false;
  }, timeoutMs, "authenticated target projection", 500);
}

function wsConnect(label) {
  return new Promise((res, rej) => {
    const socket = new WebSocket(`ws://127.0.0.1:${env.port}/ws?token=${encodeURIComponent(env.token)}`);
    const timeout = setTimeout(() => { socket.terminate(); rej(new Error(`${label} protocol_ready timeout`)); }, 20000);
    const record = (direction, frame) => {
      const value = { at: now(), label, direction, frame };
      mobileFrames.push(value);
      return appendJsonLine(join(evidenceDir, "mobile.frames.jsonl"), value);
    };
    socket.on("message", (data) => {
      let frame; try { frame = JSON.parse(data.toString()); } catch { return; }
      void record("in", frame);
      if (frame.type === "protocol_ready") { clearTimeout(timeout); res(socket); }
    });
    socket.once("error", (error) => { clearTimeout(timeout); rej(error); });
    socket.once("open", () => {
      const hello = { type: "protocol_hello", protocolVersion: 2, clientVersion: "refine-acceptance", capabilities: ["session_control", "monitor_read", "extension_ui", "desktop_plugin_control", "plan", "plan_refine"], requestId: `${env.nonce}-${label}-hello` };
      void record("out", hello);
      socket.send(JSON.stringify(hello));
    });
  });
}

function wsRequest(socket, body, timeoutMs = 30000) {
  return new Promise((res, rej) => {
    const id = body.id ?? `${env.nonce}-${randomUUID()}`;
    const frame = { ...body, id };
    const timer = setTimeout(() => { socket.off("message", onMessage); rej(new Error(`WS timeout: ${body.type}`)); }, timeoutMs);
    const onMessage = (data) => {
      let response; try { response = JSON.parse(data.toString()); } catch { return; }
      if (response.in_reply_to !== id) return;
      clearTimeout(timer); socket.off("message", onMessage); res(response);
    };
    socket.on("message", onMessage);
    const value = { at: now(), label: "active", direction: "out", frame };
    mobileFrames.push(value);
    void appendJsonLine(join(evidenceDir, "mobile.frames.jsonl"), value);
    socket.send(JSON.stringify(frame));
  });
}

async function closeWs(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  await new Promise((res) => { const t = setTimeout(res, 1500); socket.once("close", () => { clearTimeout(t); res(); }); socket.close(1000, "acceptance complete"); });
}

async function caseFrames(startMs, endMs) {
  const inWindow = (v) => { const t = Date.parse(v.at); return t >= startMs - 250 && t <= endMs + 500; };
  const frames = [];
  for (const [source, name] of [["host", "host.frames.jsonl"], ["broker", "broker.frames.jsonl"], ["plugin", "plugin.frames.jsonl"]]) {
    for (const frame of (await readJsonLines(join(evidenceDir, name))).filter(inWindow)) frames.push({ source, ...frame });
  }
  for (const frame of mobileFrames.filter(inWindow)) frames.push({ source: "mobile", ...frame });
  return frames.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

async function writeCase(name, evidence, frames) {
  await writeJson(join(evidenceDir, `refine-${name}.json`), evidence);
  await writeFile(join(evidenceDir, `refine-${name}.frames.jsonl`), frames.map((f) => JSON.stringify(f)).join("\n") + (frames.length ? "\n" : ""), { mode: 0o600 });
  for (const frame of frames) await appendJsonLine(join(evidenceDir, "refine.frames.jsonl"), { case: name, ...frame });
}

/** Extract desktop plan refine frames the mirror sent toward Mobile/Host. */
async function mirrorFrames() {
  const brokerFrames = await readJsonLines(join(evidenceDir, "broker.frames.jsonl"));
  return brokerFrames
    .filter((entry) => entry.event === "broker_frame" && entry.frame?.type === "desktop_broker_plan_refine")
    .map((entry) => entry.frame.message)
    .filter((frame) => typeof frame?.type === "string" && frame.type.startsWith("desktop_plan_refine"));
}

function mirrorOf(frames, refineSessionId) {
  const scoped = frames.filter((f) => f.refineSessionId === refineSessionId);
  return {
    all: scoped,
    snapshotCount: scoped.filter((f) => f.type === "desktop_plan_refine_snapshot").length,
    updateCount: scoped.filter((f) => f.type === "desktop_plan_refine_update").length,
    terminalCount: scoped.filter((f) => f.type === "desktop_plan_refine_terminal").length,
    snapshots: scoped.filter((f) => f.type === "desktop_plan_refine_snapshot"),
    updates: scoped.filter((f) => f.type === "desktop_plan_refine_update"),
    terminals: scoped.filter((f) => f.type === "desktop_plan_refine_terminal"),
  };
}

async function driveToRefineOverlay(target) {
  const entered = await wsRequest(socket, {
    type: "prompt",
    sessionId: target.sessionId,
    target,
    message: "Call plan-enter, then plan-update with a 3-bullet plan about testing, then plan-confirm. Stop immediately after plan-confirm returns; do not call any other tool.",
  }, 240000);
  await capturePane("after-plan-prompt");

  let screen;
  try {
    screen = await waitForPaneText(/1\. Execute[\s\S]*View \/ modify Plan|View \/ modify Plan[\s\S]*Review & Refine/, overlayWaitMs, "plan confirm overlay");
  } catch (error) {
    throw new Error(`plan confirm overlay never opened (prompt=${JSON.stringify(entered).slice(0, 200)}): ${error}`);
  }
  await capturePane("plan-confirm-open");
  return screen;
}

/**
 * Stable anchor for the refine panel. Its box footer always ends with
 * `d discard · Esc cancel`, while the plan confirm footer uses `Esc close`, so
 * this distinguishes the two overlays without depending on scroll position.
 */
const REFINE_PANEL = /d\s+discard[\s\S]{0,40}Esc\s+cancel|Esc\s+cancel/;

/** The panel is in text-input mode, where remote run intents are not applied. */
const REFINE_INPUT_MODE = /Esc\s+keep\s+input|Input\s*>/;

let socket;

async function caseR1(target, projection) {
  const startMs = Date.now();
  const screenAtConfirm = await capturePane("r1-plan-confirm");
  // Navigate to the "Review & Refine" row (3rd entry: Execute, View/modify, Review & Refine)
  // and choose it with Enter.
  // "Review & Refine" is the 3rd confirm row; the overlay accepts a direct
  // numeric shortcut, which is far more reliable in a PTY than arrow+Enter.
  await sendKeys(["3"], "r1-choose-refine");
  // The plan confirm list and the refine panel are distinct screens. Either the
  // overlay is already up (a prior keystroke or the model opened it) or the
  // confirm list is waiting for the numeric shortcut.
  let screen = await capturePane("r1-precheck");
  if (!REFINE_PANEL.test(screen)) {
    await sendKeys(["3"], "r1-choose-refine");
  }
  // `3` both selects the Review & Refine row and lands the panel on its Input row,
  // which swallows remote run intents. Escape returns to the plain selector.
  await sleep(1200);
  await sendKeys(["Escape"], "r1-leave-input-mode");
  await sleep(600);
  try {
    screen = await waitForPaneText(REFINE_PANEL, overlayWaitMs, "refine overlay opened");
  } catch (error) {
    tasks.R1 = { id: "R1", status: "blocked", exitCode: 2, blockedReason: String(error), screenAtConfirm };
    await writeCase("r1", { provider, model, status: "blocked", case: "overlay-open", target, screenAtConfirm, blockedReason: String(error), pass: false }, await caseFrames(startMs, Date.now()));
    return false;
  }
  const refineOverlayScreen = await capturePane("r1-refine-overlay");
  const frames = await caseFrames(startMs, Date.now());
  const mirror = await mirrorFrames();
  const anySnapshot = mirror.filter((f) => f.type === "desktop_plan_refine_snapshot");
  const pass = REFINE_PANEL.test(refineOverlayScreen) && anySnapshot.length >= 1;
  tasks.R1 = {
    id: "R1", status: pass ? "passed" : "failed", exitCode: pass ? 0 : 1,
    target, projection, refineOverlayScreen, snapshotCount: anySnapshot.length,
    refineSessionIds: [...new Set(anySnapshot.map((f) => f.refineSessionId))],
  };
  await writeCase("r1", { provider, model, status: tasks.R1.status, case: "overlay-open", target, ...tasks.R1, frames, pass }, frames);
  return pass;
}

/** Send one Mobile SDK refine action as a `plan_refine_action` command. */
async function sendRefineAction(target, snapshot, actionId, action) {
  return wsRequest(socket, {
    type: "plan_refine_action",
    sessionId: target.sessionId,
    target,
    refine: {
      type: "plan_refine_action",
      refineSessionId: snapshot.refineSessionId,
      planRequestId: snapshot.refineSessionId,
      operationId: snapshot.operationId,
      revision: snapshot.revision,
      actionId,
      action,
    },
  }).catch((error) => ({ error: String(error) }));
}

async function caseR2(target) {
  const startMs = Date.now();
  const latestSnapshot = [...(await mirrorFrames())].reverse().find((f) => f.type === "desktop_plan_refine_snapshot");
  if (!latestSnapshot) {
    tasks.R2 = { id: "R2", status: "blocked", exitCode: 2, blockedReason: "no snapshot to target" };
    await writeCase("r2", { provider, model, status: "blocked", case: "remote-run", target, pass: false }, await caseFrames(startMs, Date.now()));
    return false;
  }
  const refineSessionId = latestSnapshot.refineSessionId;
  if (REFINE_INPUT_MODE.test(await capturePane("r2-pre-run"))) {
    await sendKeys(["Escape"], "r2-leave-input-mode");
    await sleep(800);
  }
  const action = { action: "run", userInput: "List exactly two short review bullets about this plan." };
  const result = await sendRefineAction(target, latestSnapshot, `${env.nonce}-r2-run`, action);

  // A "running" status update proves nothing: wait for a real turn to be
  // published and for the panel to leave the running phase.
  // A produced turn arrives either inside a snapshot's `turns` array or as a
  // single `turn` field on an update frame.
  const producedTurns = (scoped) => {
    const fromArrays = scoped.all.flatMap((f) => (Array.isArray(f.turns) ? f.turns : []));
    const fromSingles = scoped.all.flatMap((f) => (f.turn ? [f.turn] : []));
    return [...fromArrays, ...fromSingles];
  };
  let turns = [];
  let lastStatus;
  try {
    await waitUntil(async () => {
      const scoped = mirrorOf(await mirrorFrames(), refineSessionId);
      turns = producedTurns(scoped);
      lastStatus = [...scoped.updates, ...scoped.snapshots].at(-1)?.status;
      return turns.length >= 1 && lastStatus !== "running";
    }, runTurnWaitMs, "remote run turn completed", 3000);
  } catch (error) {
    const failureScreen = await capturePane("r2-timeout");
    tasks.R2 = { id: "R2", status: "failed", exitCode: 1, target, refineSessionId, action, result, producedTurnCount: turns.length, lastStatus, blockedReason: String(error), failureScreen };
    await writeCase("r2", { provider, model, status: "failed", case: "remote-run", target, ...tasks.R2, pass: false }, await caseFrames(startMs, Date.now()));
    return false;
  }
  const mirror = mirrorOf(await mirrorFrames(), refineSessionId);
  const screen = await capturePane("r2-after-remote-run");
  const pass = turns.length >= 1 && lastStatus !== "running" && mirror.snapshots.length >= 1;
  tasks.R2 = {
    id: "R2", status: pass ? "passed" : "failed", exitCode: pass ? 0 : 1,
    target, refineSessionId, action, result,
    producedTurnCount: turns.length,
    turnSummary: turns.map((t) => ({ turnId: t.turnId, role: t.role, status: t.status, appliesAs: t.appliesAs, outputBytes: (t.output ?? "").length })),
    lastStatus, updateCount: mirror.updateCount, snapshotCount: mirror.snapshots.length, screen,
  };
  await writeCase("r2", { provider, model, status: tasks.R2.status, case: "remote-run", target, ...tasks.R2, pass }, await caseFrames(startMs, Date.now()));
  return pass;
}

async function caseR3(target) {
  const startMs = Date.now();
  const latestSnapshot = [...(await mirrorFrames())].reverse().find((f) => f.type === "desktop_plan_refine_snapshot");
  if (!latestSnapshot) {
    tasks.R3 = { id: "R3", status: "blocked", exitCode: 2, blockedReason: "no snapshot to target" };
    await writeCase("r3", { provider, model, status: "blocked", case: "remote-discard", target, pass: false }, await caseFrames(startMs, Date.now()));
    return false;
  }
  const refineSessionId = latestSnapshot.refineSessionId;
  const result = await sendRefineAction(target, latestSnapshot, `${env.nonce}-r3-discard`, { action: "discard" });

  let screen;
  let exited = false;
  try {
    screen = await waitUntil(async () => {
      const current = await capturePane("r3-poll");
      return !REFINE_PANEL.test(current) ? current : false;
    }, 60000, "refine overlay closed after remote discard", 1500);
    exited = true;
  } catch {
    screen = await capturePane("r3-timeout");
  }
  const pass = exited;
  tasks.R3 = { id: "R3", status: pass ? "passed" : "failed", exitCode: pass ? 0 : 1, target, refineSessionId, result, exited, screen };
  await writeCase("r3", { provider, model, status: tasks.R3.status, case: "remote-discard", target, ...tasks.R3, pass }, await caseFrames(startMs, Date.now()));
  return pass;
}

/**
 * R4 verifies the regression fix: a remote `cancel` intent must close the local
 * overlay and return to plan confirm exactly once, never re-entering the refine
 * overlay in a loop (the old abort->cancel->reopen cycle).
 */
async function caseR4(target) {
  const startMs = Date.now();
  // Re-enter the refine overlay from the plan confirm that R3 returned to.
  let reopened = false;
  try {
    await waitForPaneText(/Execute|View \/ modify Plan/i, 60000, "plan confirm after discard");
    await sendKeys(["3"], "r4-choose-refine");
    await waitForPaneText(REFINE_PANEL, overlayWaitMs, "refine overlay reopened for cancel");
    reopened = true;
  } catch (error) {
    tasks.R4 = { id: "R4", status: "blocked", exitCode: 2, blockedReason: `could not reopen overlay: ${error}` };
    await writeCase("r4", { provider, model, status: "blocked", case: "remote-cancel-no-loop", target, pass: false }, await caseFrames(startMs, Date.now()));
    return false;
  }

  const latestSnapshot = [...(await mirrorFrames())].reverse().find((f) => f.type === "desktop_plan_refine_snapshot");
  if (!latestSnapshot) {
    tasks.R4 = { id: "R4", status: "blocked", exitCode: 2, blockedReason: "no snapshot after reopen" };
    await writeCase("r4", { provider, model, status: "blocked", case: "remote-cancel-no-loop", target, pass: false }, await caseFrames(startMs, Date.now()));
    return false;
  }
  const refineSessionId = latestSnapshot.refineSessionId;
  const result = await sendRefineAction(target, latestSnapshot, `${env.nonce}-r4-cancel`, { action: "cancel" });

  let closed = false;
  let screen;
  try {
    screen = await waitUntil(async () => {
      const current = await capturePane("r4-poll");
      return !REFINE_PANEL.test(current) ? current : false;
    }, 60000, "refine overlay closed after remote cancel", 1500);
    closed = true;
  } catch {
    screen = await capturePane("r4-timeout");
  }

  // Let the loop settle, then count how many distinct refine sessions the mirror
  // ever opened. A single reopen (R4) is expected; a growing count means the
  // abort->cancel->reopen regression is back.
  await sleep(8000);
  const settleScreen = await capturePane("r4-settled");
  const distinctSessions = new Set((await mirrorFrames()).filter((f) => f.type === "desktop_plan_refine_snapshot").map((f) => f.refineSessionId));
  const refineStillOpen = REFINE_PANEL.test(settleScreen);
  // Expected: two refine sessions total (R1 and R4). More than two means a loop.
  const noLoop = distinctSessions.size <= 2;
  const pass = reopened && closed && noLoop && !refineStillOpen;
  tasks.R4 = {
    id: "R4", status: pass ? "passed" : "failed", exitCode: pass ? 0 : 1,
    target, refineSessionId, result, reopened, closed, noLoop,
    distinctRefineSessions: [...distinctSessions], refineStillOpen, screen, settleScreen,
  };
  await writeCase("r4", { provider, model, status: tasks.R4.status, case: "remote-cancel-no-loop", target, ...tasks.R4, pass }, await caseFrames(startMs, Date.now()));
  return pass;
}

async function cleanup() {
  const attempts = [];
  spawnSync("tmux", ["kill-session", "-t", env.tmuxSession], { encoding: "utf8" });
  for (const child of children) {
    const before = alive(child.pid);
    if (before) { try { process.kill(child.pid, "SIGTERM"); } catch {} }
    attempts.push({ pid: child.pid, kind: child.kind, before, signal: before ? "SIGTERM" : null });
  }
  await sleep(900);
  for (const child of children) if (alive(child.pid)) { try { process.kill(child.pid, "SIGKILL"); } catch {} }
  for (const path of [env.paths.pluginSocket, env.paths.hostSocket, env.paths.registry, env.paths.brokerPid, env.paths.hostPid]) {
    await rm(path, { force: true }).catch(() => {});
  }
  for (const link of [...env.credentialSymlinks, ...env.flowSelfDeps]) await unlink(link.path).catch(() => {});
  await rm(env.paths.socketRoot, { recursive: true, force: true }).catch(() => {});

  const remainingPids = children.filter((c) => alive(c.pid)).map((c) => c.pid);
  const probePaths = [env.paths.pluginSocket, env.paths.hostSocket, env.paths.registry, env.paths.brokerPid, env.paths.hostPid, env.paths.socketRoot];
  const probePathsGone = (await Promise.all(probePaths.map(exists))).every((v) => !v);
  const symlinksGone = (await Promise.all([...env.credentialSymlinks, ...env.flowSelfDeps].map((l) => lstat(l.path).catch(() => undefined)))).every((v) => !v);
  const defaultsAfter = await Promise.all(env.forbidden.map(async (path) => ({ path, exists: await exists(path), sha256: await sha256(path).catch(() => null) })));
  const defaultsUnchanged = defaultsAfter.every((e, i) => e.exists === env.initialDefaults[i].exists && e.sha256 === env.initialDefaults[i].sha256);
  const tmuxGone = spawnSync("tmux", ["has-session", "-t", env.tmuxSession], { encoding: "utf8" }).status !== 0;

  await writeJson(join(evidenceDir, "cleanup-proof.json"), {
    schemaVersion: 1,
    status: remainingPids.length === 0 && probePathsGone && symlinksGone && defaultsUnchanged && tmuxGone ? "passed" : "blocked",
    attempts, remainingPids, probePathsGone, symlinksGone, tmuxGone,
    defaultsBefore: env.initialDefaults, defaultsAfter, defaultsUnchanged,
    noDefaultServiceStopped: true, credentialBytesCopied: false,
  });
  await writeJson(join(evidenceDir, "process-socket-manifest.final.json"), {
    schemaVersion: 1, phase: "final", at: now(), processes: env.processes, paths: env.paths,
    cleanupProof: "evidence/cleanup-proof.json", remainingPids, probePathsGone, symlinksGone, defaultsUnchanged,
  });
}

async function finalize() {
  const cases = [tasks.R1, tasks.R2, tasks.R3, tasks.R4];
  const verdict = cases.some((t) => t?.status === "failed") ? "failed"
    : cases.every((t) => t?.status === "passed") ? "passed" : "blocked";
  const allFrames = [];
  for (const name of ["host.frames.jsonl", "broker.frames.jsonl", "plugin.frames.jsonl", "mobile.frames.jsonl", "refine.frames.jsonl"]) {
    allFrames.push(...(await readJsonLines(join(evidenceDir, name))).map((f) => ({ source: name, ...f })));
  }
  await writeJson(join(evidenceDir, "acceptance-matrix.json"), {
    schemaVersion: 1, provider, model,
    tasks: cases.map((t) => ({ id: t?.id, status: t?.status, exitCode: t?.exitCode, blockedReason: t?.blockedReason })),
  });
  await writeJson(join(evidenceDir, "correlation-index.json"), {
    schemaVersion: 1, provider, model,
    targets: cases.map((t) => t?.target).filter(Boolean), events: allFrames,
  });
  await writeJson(join(outputDir, "task-results.json"), { schemaVersion: 1, provider, model, tasks: cases });
  await writeJson(join(outputDir, "self-check.json"), {
    schemaVersion: 1, provider, model, liveVerdict: verdict,
    claims: {
      overlayOpened: tasks.R1?.status === "passed",
      remoteRunProducedTurn: tasks.R2?.status === "passed",
      remoteDiscardExitedLocally: tasks.R3?.status === "passed",
      remoteCancelDidNotReopenConfirm: tasks.R4?.status === "passed",
      realMultiProcessTopology: true,
    },
  });
  await writeFile(join(evidenceDir, "command-manifest.json"), `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(runDir, "report.md"), `---
runId: ${process.env.REFINE_PROBE_RUN_ID ?? "refine-e2e"}
provider: ${provider}
model: ${model}
liveVerdict: ${verdict}
---

# Real dual-process Review & Refine acceptance

- R1 TUI overlay opens and mirror handshakes: ${tasks.R1?.status}${tasks.R1?.blockedReason ? ` (${tasks.R1.blockedReason})` : ""}.
- R2 remote run intent produces a turn: ${tasks.R2?.status}${tasks.R2?.blockedReason ? ` (${tasks.R2.blockedReason})` : ""}.
- R3 remote discard exits locally: ${tasks.R3?.status}${tasks.R3?.blockedReason ? ` (${tasks.R3.blockedReason})` : ""}.
- R4 remote cancel does not reopen plan confirm: ${tasks.R4?.status}${tasks.R4?.blockedReason ? ` (${tasks.R4.blockedReason})` : ""}.
- Topology: real Broker + real Host + real Pi TUI in tmux.
- Cleanup proof: evidence/cleanup-proof.json.
`, { mode: 0o600 });
  return verdict;
}

async function main() {
  const stagedFlow = await stageFlowCopy();
  if (!await exists(stagedFlow.extensionEntry)) throw new Error("missing staged Flow extension entry");
  for (const file of [
    join(hostDist, "plugin/desktop-plugin-extension.js"),
    join(hostDist, "plugin/desktop-broker.js"),
    join(hostDist, "plugin/flow-refine-transport.js"),
    join(flowRoot, "src/extension/index.ts"),
  ]) if (!await exists(file)) throw new Error(`missing required artifact: ${file}`);

  await setup();
  await launch();
  const projection = await waitForProjection();
  const target = projection.records[0].target;
  socket = await wsConnect("refine-acceptance");
  await wsRequest(socket, { type: "get_snapshot", sessionId: target.sessionId, target });
  await driveToRefineOverlay(target);
  await caseR1(target, projection);
  // REFINE_PROBE_STOP_AFTER lets a run stop at a stable checkpoint so the next
  // case can be iterated without paying for the whole chain again.
  const stopAfter = process.env.REFINE_PROBE_STOP_AFTER ?? "";
  if (tasks.R1.status === "passed" && stopAfter !== "r1") {
    await caseR2(target);
    if (tasks.R2.status === "passed" && stopAfter !== "r2") {
      await caseR3(target);
      if (tasks.R3.status === "passed" && stopAfter !== "r3") await caseR4(target);
    }
  }
  await closeWs(socket);
}

try {
  await main();
} catch (error) {
  await appendJsonLine(join(evidenceDir, "probe-errors.jsonl"), { at: now(), error: error instanceof Error ? error.stack : String(error) }).catch(() => {});
  for (const id of ["R1", "R2", "R3", "R4"]) tasks[id] ??= { id, status: "blocked", exitCode: 2, blockedReason: "runner error" };
} finally {
  if (env) { await cleanup(); await finalize(); }
}
if (Object.values(tasks).some((t) => t.status !== "passed")) process.exitCode = 1;
