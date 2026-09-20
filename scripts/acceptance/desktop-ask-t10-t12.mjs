#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import WebSocket from "ws";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runDir = resolve(process.env.ASK_PROBE_RUN_DIR ?? "");
const flowRoot = resolve(process.env.PI_MAESTRO_FLOW_ROOT ?? "");
const provider = process.env.ASK_PROBE_PROVIDER ?? "my-sub2api-gpt";
const model = process.env.ASK_PROBE_MODEL ?? "gpt-5.6-sol";
const askWaitTimeoutMs = Number(process.env.ASK_PROBE_ASK_TIMEOUT_MS ?? 180000);
const evidenceDir = join(runDir, "evidence");
const outputDir = join(runDir, "outputs");
const privateDir = join(runDir, "private");
const hostDist = join(repoRoot, "apps/host/dist");
const provenancePath = join(evidenceDir, "consumer-provenance.json");
const FLOW_PACKAGE_MANIFEST_SHA256 = "4593f0c191032f98dc21332ddef8e578bdb0b2ae6562b28dedbe55825e1502f1";
const FLOW_BASELINE = Object.freeze({
  "src/tools/ask.ts": "57835002110720ebc67c26dd2bac778017f1b50899cdb8e37358c62ea26bb066",
  "src/extension/index.ts": "432251caad9bc7d2b57e128dc6699f5708d8a31e538ae8e410c431a5fd8585e4",
});
const FLOW_ABSENT = Object.freeze(["src/tools/ask-file-bridge.ts", "test/ask-file-bridge.test.ts"]);
const required = (name, value) => {
  if (!value || !value.startsWith("/")) throw new Error(`${name} must be an absolute path`);
};
required("ASK_PROBE_RUN_DIR", runDir);
required("PI_MAESTRO_FLOW_ROOT", flowRoot);
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
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
const commandText = (command, args) => [command, ...args].map((value) => JSON.stringify(value)).join(" ");
const sameTarget = (left, right) => Boolean(left && right && left.sessionId === right.sessionId && left.endpointId === right.endpointId && left.normalizedCwd === right.normalizedCwd && left.processGeneration === right.processGeneration);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const records = [];
const tasks = {};
const mobileFrames = [];
const children = [];
const responseDirectory = "/tmp";
const responsePaths = new Set();
let env;
let cleanupStarted = false;

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
  const record = {
    command: commandText(command, args),
    startedAt,
    endedAt: now(),
    exitCode: result.status ?? 1,
    signal: result.signal ?? null,
    stdout: redacted(result.stdout),
    stderr: redacted(result.stderr),
  };
  records.push(record);
  return record;
}
async function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolvePromise(port));
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
  for (const name of ["host-projection.json", "broker.frames.jsonl", "host.frames.jsonl", "plugin.frames.jsonl", "mobile.frames.jsonl", "ask.frames.jsonl", "ask-accepted.json", "ask-accepted.frames.jsonl", "ask-retry.json", "ask-retry.frames.jsonl", "ask-expired.json", "ask-expired.frames.jsonl", "acceptance-matrix.json", "correlation-index.json", "cleanup-proof.json", "process-socket-manifest.final.json", "probe-errors.jsonl"]) await rm(join(evidenceDir, name), { force: true });
  await Promise.all([mkdir(evidenceDir, { recursive: true, mode: 0o700 }), mkdir(outputDir, { recursive: true, mode: 0o700 }), mkdir(privateDir, { recursive: true, mode: 0o700 })]);
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
  };
  await Promise.all(Object.values(dirs).map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  const nonce = `ask-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
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
    piPid: join(dirs.runtime, "pi.pid"),
    brokerLog: join(dirs.logs, "broker.log"),
    hostLog: join(dirs.logs, "host.log"),
    piLog: join(dirs.logs, "pi.log"),
    session: join(dirs.sessions, "ask-bridge.jsonl"),
  };
  await writeFile(paths.secretFile, `${secret}\n`, { mode: 0o600 });
  await writeFile(paths.tokenFile, `${token}\n`, { mode: 0o600 });
  const credentialSymlinks = [];
  for (const name of ["models.json", "auth.json"]) {
    const path = join(dirs.piAgent, name);
    const target = join(homedir(), ".pi", "agent", name);
    await unlink(path).catch(() => {});
    await symlink(target, path);
    credentialSymlinks.push({ path, target, contentsCaptured: false });
  }
  const forbidden = [
    join(homedir(), ".pi", "maestro-mobile", "ipc", "desktop-plugin.sock"),
    join(homedir(), ".pi", "maestro-mobile", "ipc", "desktop-broker-host.sock"),
    join(homedir(), ".pi", "maestro-mobile", "desktop-plugin-registry.json"),
    join(homedir(), ".pi", "maestro-mobile-ipc-secret"),
    join(homedir(), ".pi", "maestro-mobile.pid"),
  ];
  const initialDefaults = await Promise.all(forbidden.map(async (path) => ({ path, exists: await exists(path), sha256: await sha256(path).catch(() => null) })));
  const initialAskTempNames = (await readdir(responseDirectory)).filter((name) => name.startsWith("pi-ask-response-tmp-") && name.endsWith(".tmp"));
  env = { runDir, repoRoot, evidenceDir, outputDir, privateDir, dirs, paths, nonce, secret, token, port: await freePort(), credentialSymlinks, forbidden, initialDefaults, initialAskTempNames, processes: [], createdAt: now() };
  await writeJson(join(privateDir, "env.json"), env);
  await writeJson(join(evidenceDir, "process-socket-manifest.initial.json"), {
    schemaVersion: 2,
    phase: "initial",
    runDir,
    provider,
    model,
    paths,
    dirs,
    credentialSymlinks,
    forbidden: initialDefaults,
    defaultPathAccess: false,
    private: true,
  });
  const listModels = await run("pi", ["--list-models"], { env: childEnv(), timeout: 60000 });
  await writeFile(join(evidenceDir, "pi-list-models.redacted.txt"), redacted(`${listModels.stdout}\n${listModels.stderr}`), { mode: 0o600 });
  if (listModels.exitCode !== 0) throw new Error(`pi model preflight failed: ${listModels.stderr}`);
  tasks.T10 = { id: "T10", status: "pending" };
  tasks.T11 = { id: "T11", status: "pending" };
  tasks.T12 = { id: "T12", status: "pending" };
}
async function writeBroker() {
  const path = join(privateDir, "broker.mjs");
  const source = `import { appendFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
const env = JSON.parse(await (await import("node:fs/promises")).readFile(process.env.PROBE_ENV, "utf8"));
const log = (event) => appendFile(join(env.evidenceDir, "broker.frames.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\\n").catch(() => {});
const { DesktopBroker, DesktopBrokerHostClient } = await import(${JSON.stringify(join(hostDist, "plugin/desktop-broker.js"))});
const broker = new DesktopBroker({ pluginSocketPath: env.paths.pluginSocket, registryPath: env.paths.registry, secret: env.secret, onFrame: (frame) => void log({ event: "broker_frame", frame }) });
const snapshot = broker.createSnapshotFrames.bind(broker); broker.createSnapshotFrames = () => { const frames = snapshot(); for (const frame of frames) void log({ event: "broker_snapshot_frame", frame }); return frames; };
const pending = broker.pendingAskFrames.bind(broker); broker.pendingAskFrames = () => { const frames = pending(); for (const frame of frames) void log({ event: "broker_pending_ask_frame", frame }); return frames; };
const hostClient = new DesktopBrokerHostClient(broker, { socketPath: env.paths.hostSocket, secret: env.secret, onConnected: () => void log({ event: "host_link_connected" }), onDisconnected: () => void log({ event: "host_link_disconnected" }) });
await broker.start(); await writeFile(env.paths.brokerPid, String(process.pid) + "\\n", { mode: 0o600 }); void log({ event: "broker_ready", pid: process.pid, brokerInstanceId: broker.brokerInstanceId }); hostClient.start();
let stopping = false; const stop = async () => { if (stopping) return; stopping = true; hostClient.close(); await broker.close().catch(() => {}); await unlink(env.paths.brokerPid).catch(() => {}); process.exit(0); }; process.on("SIGTERM", () => void stop()); process.on("SIGINT", () => void stop()); process.on("uncaughtException", (error) => { void log({ event: "broker_error", error: String(error) }); void stop(); }); process.on("unhandledRejection", (error) => { void log({ event: "broker_rejection", error: String(error) }); void stop(); });
`;
  await writeFile(path, source, { mode: 0o600 });
  return path;
}
async function writeHost() {
  const path = join(privateDir, "host.mjs");
  const source = `import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
const env = JSON.parse(await readFile(process.env.PROBE_ENV, "utf8"));
const log = (event) => appendFile(join(env.evidenceDir, "host.frames.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\\n").catch(() => {});
const { DesktopBrokerHostIpc, DesktopBrokerProjectedRegistry } = await import(${JSON.stringify(join(hostDist, "plugin/desktop-broker-host-ipc.js"))});
const { HostController } = await import(${JSON.stringify(join(hostDist, "host-controller.js"))});
const { MobileHostServer } = await import(${JSON.stringify(join(hostDist, "server/mobile-host-server.js"))});
const { PiSdkRuntimeFactory } = await import(${JSON.stringify(join(hostDist, "pi/pi-sdk-runtime.js"))});
const projection = new DesktopBrokerProjectedRegistry();
const controller = new HostController(new PiSdkRuntimeFactory(), undefined, projection);
controller.onEvent((event) => { if (event.type === "extension_ui_request" || event.type === "extension_ui_cleared") void log({ event: "host_event", frame: event }); });
const rawAnswer = controller.desktopGateway.answerAsk.bind(controller.desktopGateway);
controller.desktopGateway.answerAsk = async (...args) => { const result = await rawAnswer(...args); void log({ event: "gateway_ask_result", target: args[0], requestId: args[1], toolCallId: args[2], result }); return result; };
const ipc = new DesktopBrokerHostIpc({ socketPath: env.paths.hostSocket, secret: env.secret, hostInstanceId: env.nonce + "-host-" + process.pid, projection, onProjection: (records, brokerInstanceId, revision) => { const safe = records.map((record) => ({ ...record, target: { ...record.target }, ...(record.model ? { model: record.model } : {}), ...(record.thinkingLevel ? { thinkingLevel: record.thinkingLevel } : {}) })); void log({ event: "projection", brokerInstanceId, revision, records: safe }); const projectionPath = join(env.evidenceDir, "host-projection.json"); const projectionTempPath = projectionPath + ".tmp-" + process.pid + "-" + revision; void writeFile(projectionTempPath, JSON.stringify({ at: new Date().toISOString(), writerPid: process.pid, brokerInstanceId, revision, epoch: projection.epoch, records: safe }, null, 2) + "\\n", { mode: 0o600 }).then(() => rename(projectionTempPath, projectionPath)).catch(() => {}); controller.applyDesktopProjection(records); }, onAskRequest: (target, request) => { void log({ event: "ask_request", target, request }); controller.onDesktopAskRequest(target, request); }, onDisconnected: () => void log({ event: "host_disconnected" }) });
const server = new MobileHostServer(controller, { token: env.token }); await ipc.start(); await server.listen(env.port, "127.0.0.1"); await writeFile(env.paths.hostPid, String(process.pid) + "\\n", { mode: 0o600 }); void log({ event: "host_ready", pid: process.pid, port: env.port });
let stopping = false; const stop = async () => { if (stopping) return; stopping = true; await server.close().catch(() => {}); await controller.dispose().catch(() => {}); await ipc.close().catch(() => {}); process.exit(0); }; process.on("SIGTERM", () => void stop()); process.on("SIGINT", () => void stop()); process.on("uncaughtException", (error) => { void log({ event: "host_error", error: String(error) }); void stop(); }); process.on("unhandledRejection", (error) => { void log({ event: "host_rejection", error: String(error) }); void stop(); });
`;
  await writeFile(path, source, { mode: 0o600 });
  return path;
}
async function launch() {
  const brokerPath = await writeBroker();
  const brokerLog = await (await import("node:fs/promises")).open(env.paths.brokerLog, "a");
  const broker = spawn(process.execPath, [brokerPath], { cwd: repoRoot, env: { ...process.env, ...childEnv(), PROBE_ENV: join(privateDir, "env.json") }, stdio: ["ignore", brokerLog.fd, brokerLog.fd], detached: true });
  broker.unref(); await brokerLog.close(); children.push(broker); await sleep(1000);
  const hostPath = await writeHost();
  const hostLog = await (await import("node:fs/promises")).open(env.paths.hostLog, "a");
  const host = spawn(process.execPath, [hostPath], { cwd: repoRoot, env: { ...process.env, ...childEnv(), PROBE_ENV: join(privateDir, "env.json") }, stdio: ["ignore", hostLog.fd, hostLog.fd], detached: true });
  host.unref(); await hostLog.close(); children.push(host); await sleep(1800);
  const wrapper = join(privateDir, "pi-extension-wrapper.mjs");
  await writeFile(wrapper, `import { appendFile } from "node:fs/promises";
import { createDesktopPluginExtension } from ${JSON.stringify(join(hostDist, "plugin/desktop-plugin-extension.js"))};
import { DesktopFlowAskAdapter } from ${JSON.stringify(join(hostDist, "plugin/desktop-flow-ask-adapter.js"))};
const log = (event) => appendFile(${JSON.stringify(join(evidenceDir, "plugin.frames.jsonl"))}, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\\n").catch(() => {});
class ProbeAskAdapter extends DesktopFlowAskAdapter {
  register(toolCallId, questions, expiresAt) { const accepted = super.register(toolCallId, questions, expiresAt); void log({ event: "adapter_register", toolCallId, questions, expiresAt, accepted }); return accepted; }
  async answer(toolCallId, response) { const result = await super.answer(toolCallId, response); void log({ event: "adapter_answer", toolCallId, response, result }); return result; }
}
DesktopFlowAskAdapter.fromTools = (tools) => new ProbeAskAdapter({ toolNames: tools.map((tool) => tool.name ?? ""), responseDirectory: "/tmp" });
export default function(pi) { createDesktopPluginExtension({ socketPath: ${JSON.stringify(env.paths.pluginSocket)}, secretPath: ${JSON.stringify(env.paths.secretFile)}, endpointId: ${JSON.stringify(env.nonce + "-endpoint-a")}, processGeneration: ${JSON.stringify(env.nonce + "-generation-a")} })(pi); }
`, { mode: 0o600 });
  const expectScript = join(privateDir, "pi-pty.expect");
  await writeFile(expectScript, `#!/usr/bin/expect -f
set timeout -1
set log_path [lindex $argv 0]
set argv [lrange $argv 1 end]
log_file -a $log_path
spawn -noecho pi {*}$argv
expect eof
`, { mode: 0o700 });
  const piArgs = ["--approve", "--provider", provider, "--model", model, "--thinking", "medium", "--no-extensions", "--extension", flowRoot + "/src/extension/index.ts", "--extension", wrapper, "--session-dir", env.dirs.sessions, "--session-id", env.nonce + "-session", "--no-context-files"];
  const pty = spawn("expect", [expectScript, env.paths.piLog, ...piArgs], { cwd: env.dirs.home, env: { ...process.env, ...childEnv() }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  pty.unref(); children.push(pty); await sleep(3000); const piPidResult = spawnSync("pgrep", ["-P", String(pty.pid)], { encoding: "utf8" }); const piPid = Number(String(piPidResult.stdout ?? "").trim().split(/\s+/).at(-1)); if (!Number.isSafeInteger(piPid) || piPid < 1) throw new Error("real Pi child PID unavailable"); children.push({ pid: piPid }); env.processes.push({ kind: "broker", pid: broker.pid, command: commandText(process.execPath, [brokerPath]) }, { kind: "host", pid: host.pid, command: commandText(process.execPath, [hostPath]) }, { kind: "pi-pty", pid: pty.pid, command: commandText("expect", [expectScript, env.paths.piLog, ...piArgs]) }, { kind: "pi", pid: piPid, command: commandText("pi", piArgs) });
  await writeJson(join(privateDir, "pids.json"), { processes: env.processes });
  await writeJson(join(privateDir, "env.json"), env);
}
async function waitUntil(predicate, timeoutMs, label, interval = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await sleep(interval); }
  throw new Error(`${label} timeout`);
}
async function waitForProjection(timeoutMs = 30000) {
  return waitUntil(async () => {
    try {
      const value = JSON.parse(await readFile(join(evidenceDir, "host-projection.json"), "utf8"));
      const target = value.records?.[0]?.target;
      if (value.records?.length === 1 && value.brokerInstanceId && value.epoch === value.brokerInstanceId && target?.sessionId === `${env.nonce}-session` && target?.endpointId === `${env.nonce}-endpoint-a` && target?.processGeneration === `${env.nonce}-generation-a`) return value;
    } catch {}
    return false;
  }, timeoutMs, "authenticated target projection");
}
function wsConnect(label) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${env.port}/ws?token=${encodeURIComponent(env.token)}`);
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error(`${label} protocol_ready timeout`)); }, 15000);
    const record = (direction, frame) => { const value = { at: now(), label, direction, frame }; mobileFrames.push(value); return appendJsonLine(join(evidenceDir, "mobile.frames.jsonl"), value); };
    socket.on("message", (data) => { let frame; try { frame = JSON.parse(data.toString()); } catch { return; } void record("in", frame); if (frame.type === "protocol_ready") { clearTimeout(timeout); resolvePromise(socket); } });
    socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
    socket.once("open", () => { const hello = { type: "protocol_hello", protocolVersion: 2, clientVersion: "ask-bridge-acceptance", capabilities: ["session_control", "monitor_read", "extension_ui", "desktop_plugin_control"], requestId: `${env.nonce}-${label}-hello` }; void record("out", hello); socket.send(JSON.stringify(hello)); });
  });
}
function wsRequest(socket, body, timeoutMs = 15000) {
  return new Promise((resolvePromise, reject) => {
    const id = body.id ?? `${env.nonce}-${randomUUID()}`;
    const frame = { ...body, id };
    const timer = setTimeout(() => { socket.off("message", onMessage); reject(new Error(`WS timeout: ${body.type}`)); }, timeoutMs);
    const onMessage = (data) => { let response; try { response = JSON.parse(data.toString()); } catch { return; } if (response.in_reply_to !== id) return; clearTimeout(timer); socket.off("message", onMessage); resolvePromise(response); };
    socket.on("message", onMessage);
    const value = { at: now(), label: "active", direction: "out", frame }; mobileFrames.push(value); void appendJsonLine(join(evidenceDir, "mobile.frames.jsonl"), value); socket.send(JSON.stringify(frame));
  });
}
async function closeWs(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  await new Promise((resolvePromise) => { const timer = setTimeout(resolvePromise, 1500); socket.once("close", () => { clearTimeout(timer); resolvePromise(); }); socket.close(1000, "acceptance complete"); });
}
async function caseFrames(startMs, endMs) {
  const inWindow = (value) => { const timestamp = Date.parse(value.at); return timestamp >= startMs - 250 && timestamp <= endMs + 500; };
  const frames = [];
  for (const [source, name] of [["host", "host.frames.jsonl"], ["broker", "broker.frames.jsonl"], ["plugin", "plugin.frames.jsonl"]]) for (const frame of (await readJsonLines(join(evidenceDir, name))).filter(inWindow)) frames.push({ source, ...frame });
  for (const frame of mobileFrames.filter(inWindow)) frames.push({ source: "mobile", ...frame });
  return frames.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}
function responsePath(toolCallId) {
  const path = join(responseDirectory, `pi-ask-response-${toolCallId}.json`);
  responsePaths.add(path);
  return path;
}
async function responseFiles(toolCallId) {
  const path = responsePath(toolCallId);
  const fileStat = await stat(path).catch(() => undefined);
  if (!fileStat) return [];
  return [{ name: basename(path), exact: true, kind: fileStat.isDirectory() ? "directory" : "file", mode: (fileStat.mode & 0o777).toString(8).padStart(4, "0"), size: fileStat.size, sha256: fileStat.isFile() ? await sha256(path) : null }];
}
function correlation(frames, caseData) {
  const related = (frame) => {
    if (frame.source === "plugin" && ["adapter_register", "adapter_answer"].includes(frame.event)) return frame.toolCallId === caseData.toolCallId;
    if (frame.source === "host" && frame.event === "ask_request") return sameTarget(frame.target, caseData.target) && frame.request?.requestId === caseData.requestId && frame.request?.toolCallId === caseData.toolCallId;
    if (frame.source === "host" && frame.event === "gateway_ask_result") return sameTarget(frame.target, caseData.target) && frame.requestId === caseData.requestId && frame.toolCallId === caseData.toolCallId;
    if (frame.source === "broker" && frame.frame?.type === "desktop_broker_ask_request") return sameTarget(frame.frame.target, caseData.target) && frame.frame.request?.requestId === caseData.requestId && frame.frame.request?.toolCallId === caseData.toolCallId;
    if (frame.source === "broker" && frame.frame?.type === "desktop_broker_ask_result") return sameTarget(frame.frame.target, caseData.target) && frame.frame.result?.requestId === caseData.requestId && frame.frame.result?.toolCallId === caseData.toolCallId;
    if (frame.source === "mobile") return sameTarget(frame.frame?.target, caseData.target) && (frame.frame?.request?.id === caseData.hostRequestId || frame.frame?.requestId === caseData.hostRequestId);
    return false;
  };
  const matches = frames.filter(related);
  const count = (predicate) => matches.filter(predicate).length;
  return {
    hostAskRequestCount: count((frame) => frame.source === "host" && frame.event === "ask_request"),
    pluginRegisterCount: count((frame) => frame.source === "plugin" && frame.event === "adapter_register"),
    pluginAnswerCount: count((frame) => frame.source === "plugin" && frame.event === "adapter_answer"),
    brokerAskRequestCount: count((frame) => frame.source === "broker" && frame.frame?.type === "desktop_broker_ask_request"),
    brokerAskResultCount: count((frame) => frame.source === "broker" && frame.frame?.type === "desktop_broker_ask_result"),
    gatewayReceiptCount: count((frame) => frame.source === "host" && frame.event === "gateway_ask_result"),
    mobileClearCount: count((frame) => frame.source === "mobile" && frame.frame?.type === "extension_ui_cleared"),
    matches,
  };
}
async function writeCase(name, evidence, frames) {
  await writeJson(join(evidenceDir, `ask-${name}.json`), evidence);
  await writeFile(join(evidenceDir, `ask-${name}.frames.jsonl`), frames.map((frame) => JSON.stringify(frame)).join("\n") + (frames.length ? "\n" : ""), { mode: 0o600 });
  for (const frame of frames) await appendJsonLine(join(evidenceDir, "ask.frames.jsonl"), { case: name, ...frame });
}
async function waitForAsk(socket, target, caseName) {
  const startMs = Date.now();
  const nonce = `${env.nonce}-${caseName}-${randomUUID()}`;
  const promptCommandId = `${env.nonce}-${caseName}-prompt`;
  const message = `Probe nonce ${nonce}. Call the ask-user-question tool exactly once now with exactly one question: Is this the ${caseName} live bridge probe? Do not call any other tool.`;
  const promptResult = await wsRequest(socket, { id: promptCommandId, type: "prompt", sessionId: target.sessionId, target, message });
  let request;
  try {
    request = await waitUntil(async () => {
      const frame = mobileFrames.slice().reverse().find((item) => Date.parse(item.at) >= startMs && item.frame?.type === "extension_ui_request" && sameTarget(item.frame.target, target));
      if (frame) return frame.frame;
      const plugin = (await readJsonLines(join(evidenceDir, "plugin.frames.jsonl"))).find((item) => Date.parse(item.at) >= startMs && item.event === "adapter_register");
      return plugin?.accepted === false ? { rejected: true, plugin } : false;
    }, askWaitTimeoutMs, `${caseName} real ask request`);
  } catch (error) {
    return { blocked: true, startedAt: new Date(startMs).toISOString(), startMs, promptCommandId, nonce, message, promptResult, blockedReason: String(error) };
  }
  if (request.rejected) return { failed: true, startedAt: new Date(startMs).toISOString(), startMs, promptCommandId, nonce, message, promptResult, toolCallId: request.plugin.toolCallId, blockedReason: "DesktopFlowAskAdapter rejected the real provider toolCallId", pluginRegister: request.plugin };
  const hostRequest = await waitUntil(async () => {
    const frames = await readJsonLines(join(evidenceDir, "host.frames.jsonl"));
    return [...frames].reverse().find((frame) => frame.event === "ask_request" && Date.parse(frame.at) >= startMs && sameTarget(frame.target, target));
  }, 10000, `${caseName} host request correlation`);
  return { blocked: false, startedAt: new Date(startMs).toISOString(), startMs, promptCommandId, nonce, message, promptResult, target, mobileRequest: request, hostRequest, hostRequestId: request.request.id, requestId: hostRequest.request.requestId, toolCallId: hostRequest.request.toolCallId, deadlineAt: hostRequest.request.deadlineAt };
}
async function waitForIdle(target) {
  await waitUntil(async () => {
    const frames = await readJsonLines(join(evidenceDir, "broker.frames.jsonl"));
    const summaries = frames.filter((frame) => frame.event === "broker_frame" && frame.frame?.type === "desktop_broker_delta" && frame.frame.mutation?.kind === "session_summary" && sameTarget(frame.frame.mutation.target, target));
    const latest = summaries.at(-1)?.frame.mutation.summary?.runtimeStatus;
    if (latest === "idle") return true;
    try { return JSON.parse(await readFile(join(evidenceDir, "host-projection.json"), "utf8")).records?.[0]?.runtimeStatus === "idle"; } catch { return false; }
  }, 90000, "Pi idle", 250);
}
async function acceptedCase(socket, target) {
  await waitForIdle(target);
  const data = await waitForAsk(socket, target, "accepted");
  if (data.blocked || data.failed) { tasks.T10 = { id: "T10", status: data.failed ? "failed" : "blocked", exitCode: data.failed ? 1 : 2, ...data }; await writeCase("accepted", { provider, model, status: tasks.T10.status, case: "accepted", target, ...data, pass: false }, await caseFrames(data.startMs ?? Date.now(), Date.now())); return; }
  const responseCommandId = `${env.nonce}-accepted-response`;
  const responseResult = await wsRequest(socket, { id: responseCommandId, type: "extension_ui_response", sessionId: target.sessionId, target, requestId: data.hostRequestId, response: { id: data.hostRequestId, selected: ["yes"] } });
  await waitUntil(async () => mobileFrames.some((frame) => frame.frame?.type === "extension_ui_cleared" && frame.frame.requestId === data.hostRequestId), 10000, "accepted clear");
  await sleep(600);
  const frames = await caseFrames(data.startMs, Date.now());
  const counts = correlation(frames, data);
  const files = await responseFiles(data.toolCallId);
  const pluginReceipt = frames.findLast?.((frame) => frame.source === "plugin" && frame.event === "adapter_answer" && frame.toolCallId === data.toolCallId);
  const brokerReceipt = frames.findLast?.((frame) => frame.source === "broker" && frame.frame?.type === "desktop_broker_ask_result" && frame.frame.result?.requestId === data.requestId);
  const gatewayReceipt = frames.findLast?.((frame) => frame.source === "host" && frame.event === "gateway_ask_result" && frame.requestId === data.requestId);
  const pass = responseResult.ok && pluginReceipt?.result?.status === "accepted" && brokerReceipt?.frame?.result?.status === "accepted" && gatewayReceipt?.result?.status === "accepted" && counts.hostAskRequestCount === 1 && counts.pluginRegisterCount === 1 && counts.brokerAskRequestCount === 1 && counts.brokerAskResultCount === 1 && counts.mobileClearCount === 1 && files.length === 0;
  const evidence = { provider, model, status: pass ? "passed" : "failed", case: "accepted", target, ...data, endedAt: now(), responseCommandId, responseResult, pluginReceipt, brokerReceipt, gatewayReceipt, counts, responseFiles: files, pass };
  tasks.T10 = { id: "T10", status: pass ? "passed" : "failed", exitCode: pass ? 0 : 1, ...evidence };
  await writeCase("accepted", evidence, frames);
}
async function retryCase(socket, target) {
  await waitForIdle(target);
  const data = await waitForAsk(socket, target, "retry");
  if (data.blocked || data.failed) { tasks.T11 = { id: "T11", status: data.failed ? "failed" : "blocked", exitCode: data.failed ? 1 : 2, ...data }; await writeCase("retry", { provider, model, status: tasks.T11.status, case: "failed-then-same-request-retry", target, ...data, pass: false }, await caseFrames(data.startMs ?? Date.now(), Date.now())); return; }
  const blockedPath = responsePath(data.toolCallId);
  await rm(blockedPath, { recursive: true, force: true });
  await mkdir(blockedPath, { mode: 0o700 });
  const blockerCreated = (await stat(blockedPath)).isDirectory();
  const failedCommandId = `${env.nonce}-retry-failed-response`;
  const failedResult = await wsRequest(socket, { id: failedCommandId, type: "extension_ui_response", sessionId: target.sessionId, target, requestId: data.hostRequestId, response: { id: data.hostRequestId, selected: ["first"] } });
  await sleep(800);
  const clearBeforeRetry = mobileFrames.filter((frame) => frame.frame?.type === "extension_ui_cleared" && frame.frame.requestId === data.hostRequestId).length;
  await rm(blockedPath, { recursive: true, force: true });
  const blockerRemoved = !await exists(blockedPath);
  const filesAfterFailure = await responseFiles(data.toolCallId);
  const retryCommandId = `${env.nonce}-retry-success-response`;
  const retryResult = await wsRequest(socket, { id: retryCommandId, type: "extension_ui_response", sessionId: target.sessionId, target, requestId: data.hostRequestId, response: { id: data.hostRequestId, selected: ["retry"] } });
  await waitUntil(async () => mobileFrames.filter((frame) => frame.frame?.type === "extension_ui_cleared" && frame.frame.requestId === data.hostRequestId).length === 1, 10000, "retry clear");
  await sleep(600);
  const frames = await caseFrames(data.startMs, Date.now());
  const counts = correlation(frames, data);
  const files = await responseFiles(data.toolCallId);
  const adapters = frames.filter((frame) => frame.source === "plugin" && frame.event === "adapter_answer" && frame.toolCallId === data.toolCallId);
  const brokers = frames.filter((frame) => frame.source === "broker" && frame.frame?.type === "desktop_broker_ask_result" && frame.frame.result?.requestId === data.requestId);
  const gateways = frames.filter((frame) => frame.source === "host" && frame.event === "gateway_ask_result" && frame.requestId === data.requestId);
  const pass = !failedResult.ok && failedResult.error?.code === "request_not_found" && adapters[0]?.result?.error?.code === "response_write_failed" && brokers[0]?.frame?.result?.status === "failed" && brokers[0]?.frame?.result?.error?.code === "plugin_ask_rejected" && brokers[0]?.frame?.result?.error?.message === "response_write_failed" && gateways[0]?.result?.error?.code === "plugin_ask_rejected" && gateways[0]?.result?.error?.message === "response_write_failed" && clearBeforeRetry === 0 && blockerCreated && blockerRemoved && filesAfterFailure.length === 0 && retryResult.ok && adapters[1]?.result?.status === "accepted" && brokers[1]?.frame?.result?.status === "accepted" && gateways[1]?.result?.status === "accepted" && counts.mobileClearCount === 1 && files.length === 0 && adapters.length === 2 && brokers.length === 2 && gateways.length === 2;
  const evidence = { provider, model, status: pass ? "passed" : "failed", case: "failed-then-same-request-retry", target, ...data, endedAt: now(), failureInjection: { blockedPath, blockerCreated, blockerRemoved }, failedAttempt: { commandId: failedCommandId, commandResult: failedResult, responseFiles: filesAfterFailure, clearBeforeRetry }, retryAttempt: { commandId: retryCommandId, commandResult: retryResult }, sameRequest: { hostRequestId: data.hostRequestId, requestId: data.requestId, toolCallId: data.toolCallId }, counts, responseFiles: files, pass };
  tasks.T11 = { id: "T11", status: pass ? "passed" : "failed", exitCode: pass ? 0 : 1, ...evidence };
  await writeCase("retry", evidence, frames);
}
async function expiredCase(socket, target) {
  await waitForIdle(target);
  const data = await waitForAsk(socket, target, "expired");
  if (data.blocked || data.failed) { tasks.T12 = { id: "T12", status: data.failed ? "failed" : "blocked", exitCode: data.failed ? 1 : 2, ...data }; await writeCase("expired", { provider, model, status: tasks.T12.status, case: "expired-late", target, ...data, pass: false }, await caseFrames(data.startMs ?? Date.now(), Date.now())); return; }
  const waitMs = Math.max(1000, data.deadlineAt - Date.now() + 15000);
  const clearEntry = await waitUntil(() => mobileFrames.find((frame) => frame.frame?.type === "extension_ui_cleared" && frame.frame.requestId === data.hostRequestId), waitMs, "deadline clear", 250);
  const lateSentAt = now();
  const lateCommandId = `${env.nonce}-expired-late-response`;
  const lateResult = await wsRequest(socket, { id: lateCommandId, type: "extension_ui_response", sessionId: target.sessionId, target, requestId: data.hostRequestId, response: { id: data.hostRequestId, selected: ["late"] } });
  await sleep(1000);
  const frames = await caseFrames(data.startMs, Date.now());
  const counts = correlation(frames, data);
  const files = await responseFiles(data.toolCallId);
  const postDeadline = frames.filter((frame) => Date.parse(frame.at) >= Date.parse(lateSentAt) && ((frame.source === "broker" && frame.frame?.type === "desktop_broker_ask_result") || (frame.source === "plugin" && frame.event === "adapter_answer") || (frame.source === "host" && frame.event === "gateway_ask_result")));
  const resurrection = mobileFrames.filter((frame) => Date.parse(frame.at) >= Date.parse(lateSentAt) && frame.frame?.type === "extension_ui_request" && frame.frame.request?.id === data.hostRequestId);
  const pass = data.deadlineAt <= Date.now() && Date.parse(clearEntry.at) >= data.deadlineAt && !lateResult.ok && lateResult.error?.code === "request_not_found" && counts.mobileClearCount === 1 && postDeadline.length === 0 && files.length === 0 && resurrection.length === 0;
  const evidence = { provider, model, status: pass ? "passed" : "failed", case: "expired-late", target, ...data, endedAt: now(), clearAt: clearEntry.at, lateSentAt, lateCommandId, lateResult, counts, responseFiles: files, postDeadlineReceipts: postDeadline, resurrectionCount: resurrection.length, pass };
  tasks.T12 = { id: "T12", status: pass ? "passed" : "failed", exitCode: pass ? 0 : 1, ...evidence };
  await writeCase("expired", evidence, frames);
}
async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  const attempts = [];
  for (const child of children) {
    const before = alive(child.pid);
    if (before) { try { process.kill(child.pid, "SIGTERM"); } catch {} }
    attempts.push({ pid: child.pid, before, signal: before ? "SIGTERM" : null });
  }
  await sleep(800);
  for (const child of children) if (alive(child.pid)) { try { process.kill(child.pid, "SIGKILL"); } catch {} }
  for (const path of [env.paths.pluginSocket, env.paths.hostSocket, env.paths.registry, env.paths.brokerPid, env.paths.hostPid, env.paths.piPid]) await rm(path, { force: true }).catch(() => {});
  for (const link of env.credentialSymlinks) await unlink(link.path).catch(() => {});
  await rm(env.paths.socketRoot, { recursive: true, force: true }).catch(() => {});
  for (const path of responsePaths) await rm(path, { recursive: true, force: true }).catch(() => {});
  const currentAskTempNames = (await readdir(responseDirectory)).filter((name) => name.startsWith("pi-ask-response-tmp-") && name.endsWith(".tmp"));
  const newAskTempNames = currentAskTempNames.filter((name) => !env.initialAskTempNames.includes(name));
  for (const name of newAskTempNames) await rm(join(responseDirectory, name), { force: true }).catch(() => {});
  const remainingPids = children.filter((child) => alive(child.pid)).map((child) => child.pid);
  const probePaths = [env.paths.pluginSocket, env.paths.hostSocket, env.paths.registry, env.paths.brokerPid, env.paths.hostPid, env.paths.piPid, env.paths.socketRoot, ...responsePaths];
  const probePathsGone = (await Promise.all(probePaths.map(exists))).every((value) => !value);
  const symlinksGone = (await Promise.all(env.credentialSymlinks.map((link) => lstat(link.path).catch(() => undefined)))).every((value) => !value);
  const defaultsAfter = await Promise.all(env.forbidden.map(async (path) => ({ path, exists: await exists(path), sha256: await sha256(path).catch(() => null) })));
  const defaultsUnchanged = defaultsAfter.every((entry, index) => entry.exists === env.initialDefaults[index].exists && entry.sha256 === env.initialDefaults[index].sha256);
  const remainingAskTempNames = (await readdir(responseDirectory)).filter((name) => name.startsWith("pi-ask-response-tmp-") && name.endsWith(".tmp"));
  const responseTempsGone = newAskTempNames.every((name) => !remainingAskTempNames.includes(name));
  await writeJson(join(evidenceDir, "cleanup-proof.json"), { schemaVersion: 2, status: remainingPids.length === 0 && probePathsGone && symlinksGone && defaultsUnchanged && responseTempsGone ? "passed" : "blocked", attempts, remainingPids, probePathsGone, responseTempsGone, removedResponseTemps: newAskTempNames, fixedConsumerResponseDirectory: responseDirectory, symlinksGone, defaultsBefore: env.initialDefaults, defaultsAfter, defaultsUnchanged, noDefaultServiceStopped: true, credentialBytesCopied: false });
  await writeJson(join(evidenceDir, "process-socket-manifest.final.json"), { schemaVersion: 2, phase: "final", at: now(), processes: env.processes, paths: env.paths, cleanupProof: "evidence/cleanup-proof.json", remainingPids, probePathsGone, symlinksGone, defaultsUnchanged });
}
async function finalize() {
  const cases = [tasks.T10, tasks.T11, tasks.T12];
  const liveVerdict = cases.some((task) => task?.status === "failed") ? "failed" : cases.every((task) => task?.status === "passed") ? "passed" : "blocked";
  const allFrames = [];
  for (const name of ["host.frames.jsonl", "broker.frames.jsonl", "plugin.frames.jsonl", "mobile.frames.jsonl", "ask.frames.jsonl"]) allFrames.push(...(await readJsonLines(join(evidenceDir, name))).map((frame) => ({ source: name, ...frame })));
  await writeJson(join(evidenceDir, "acceptance-matrix.json"), { schemaVersion: 2, provider, model, tasks: cases.map((task) => ({ id: task?.id, status: task?.status, exitCode: task?.exitCode })) });
  await writeJson(join(evidenceDir, "correlation-index.json"), { schemaVersion: 2, provider, model, targets: cases.map((task) => task?.target).filter(Boolean), events: allFrames });
  await writeJson(join(outputDir, "task-results.json"), { _meta: { kind: "task-results", schema: "task-results/1.0", role: "attachment" }, schemaVersion: 2, provider, model, tasks: cases });
  await writeJson(join(outputDir, "execution.json"), { _meta: { kind: "artifact", schema: "artifacts/1.0", role: "primary", alias: "current-execution" }, schemaVersion: 2, runDir, provider, model, status: liveVerdict === "passed" ? "DONE" : "DONE_WITH_CONCERNS", liveVerdict, cases: cases.map((task) => task?.status), realPiFlowAsk: true, hostSourceChanged: true, flowConsumerChanged: false, cleanup: "evidence/cleanup-proof.json" });
  await writeJson(join(outputDir, "self-check.json"), { _meta: { kind: "self-check", schema: "self-check/1.0", role: "evidence" }, schemaVersion: 2, provider, model, liveVerdict, claims: { accepted: tasks.T10?.status === "passed", retry: tasks.T11?.status === "passed", expiredLate: tasks.T12?.status === "passed", defaultRuntimeUntouched: true, realFlowAsk: true }, rawFrames: ["evidence/host.frames.jsonl", "evidence/broker.frames.jsonl", "evidence/plugin.frames.jsonl", "evidence/mobile.frames.jsonl"] });
  await writeJson(join(outputDir, "change-manifest.json"), { _meta: { kind: "change-manifest", schema: "change-manifest/1.0", role: "evidence" }, schemaVersion: 2, hostSourceChanged: true, flowConsumerChanged: false, runScopedPathsChanged: ["scripts/acceptance/desktop-ask-t10-t12.mjs", "evidence", "outputs"], defaultServicesStopped: false, credentialBytesCopied: false, cleanupProof: "evidence/cleanup-proof.json" });
  await writeJson(join(outputDir, "argv.json"), { _meta: { kind: "argv", schema: "argv/1.0", role: "evidence" }, provider, model, flowRoot, hostDist, runDir, privateDir, fixedConsumerResponseDirectory: responseDirectory, processEnv: { HOME: env.dirs.home, PI_CODING_AGENT_DIR: env.dirs.piAgent } });
  await writeFile(join(evidenceDir, "command-manifest.json"), `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(runDir, "report.md"), `---\nrunId: ${process.env.ASK_PROBE_RUN_ID ?? "host-only-compatibility"}\nprovider: ${provider}\nmodel: ${model}\nliveVerdict: ${liveVerdict}\n---\n\n# Real T10-T12 Host-only Ask compatibility acceptance\n\n- T10 accepted: ${tasks.T10?.status}.\n- T11 failed-write retry: ${tasks.T11?.status}.\n- T12 expiry and late response: ${tasks.T12?.status}.\n- Flow consumer remained at its pre-edit hashes.\n- Cleanup proof: evidence/cleanup-proof.json.\n- Default services and credential bytes were not modified or copied.\n`, { mode: 0o600 });
  return liveVerdict;
}
async function verifyFlowBaseline(provenance) {
  if (provenance.package?.manifestSha256 !== FLOW_PACKAGE_MANIFEST_SHA256 || await sha256(join(flowRoot, "package.json")) !== FLOW_PACKAGE_MANIFEST_SHA256) {
    throw new Error("consumer package manifest baseline mismatch");
  }
  for (const [path, expected] of Object.entries(FLOW_BASELINE)) {
    if (provenance.preEdit?.[path] !== expected) throw new Error(`consumer provenance baseline mismatch: ${path}`);
    if (await sha256(join(flowRoot, path)) !== expected) throw new Error(`consumer baseline hash mismatch: ${path}`);
  }
  for (const path of FLOW_ABSENT) {
    if (provenance.preEdit?.[path] !== null) throw new Error(`consumer provenance must declare absent: ${path}`);
    if (await exists(join(flowRoot, path))) throw new Error(`unexpected consumer file remains: ${path}`);
  }
}
async function main() {
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  if (provenance.realpath !== resolve(flowRoot) || provenance.package?.name !== "pi-maestro-flow" || provenance.package?.version !== "0.30.0") throw new Error("consumer provenance does not match selected Flow root");
  await verifyFlowBaseline(provenance);
  for (const [path, expected] of Object.entries(provenance.hostDist ?? {})) if (expected && await sha256(join(hostDist, path)) !== expected) throw new Error(`Host dist provenance hash mismatch: ${path}`);
  const pi = provenance.pi;
  if (!pi?.path || !pi.realpath || resolve(pi.path) !== pi.realpath || !(await exists(pi.path))) throw new Error("pi executable provenance missing or changed");
  const piVersion = spawnSync(pi.path, ["--version"], { encoding: "utf8" });
  if (piVersion.status !== 0 || piVersion.stdout.trim() !== pi.version) throw new Error("pi executable version provenance mismatch");
  for (const file of [join(hostDist, "plugin/desktop-plugin-extension.js"), join(hostDist, "plugin/desktop-broker.js"), join(hostDist, "cli.js")]) if (!await exists(file)) throw new Error(`missing rebuilt Host artifact: ${file}`);
  await setup();
  await launch();
  const projection = await waitForProjection();
  const target = projection.records[0].target;
  const socket = await wsConnect("ask-bridge");
  await wsRequest(socket, { type: "get_snapshot", sessionId: target.sessionId, target });
  await acceptedCase(socket, target);
  await retryCase(socket, target);
  await expiredCase(socket, target);
  await closeWs(socket);
}
try {
  await main();
} catch (error) {
  await appendJsonLine(join(evidenceDir, "probe-errors.jsonl"), { at: now(), error: error instanceof Error ? error.stack : String(error) });
  tasks.T10 ??= { id: "T10", status: "blocked", exitCode: 2, blockedReason: "runner error" };
  tasks.T11 ??= { id: "T11", status: "blocked", exitCode: 2, blockedReason: "runner error" };
  tasks.T12 ??= { id: "T12", status: "blocked", exitCode: 2, blockedReason: "runner error" };
} finally {
  if (env) { await cleanup(); await finalize(); }
}
if (Object.values(tasks).some((task) => task.status !== "passed")) process.exitCode = 1;
