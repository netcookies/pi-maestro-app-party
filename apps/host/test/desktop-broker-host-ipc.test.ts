import { afterEach, describe, expect, it } from "vitest";
import { createConnection, type Socket } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DesktopBrokerTargetRecord, DesktopPluginResult, DesktopPluginTarget } from "@maestro-mobile/shared";
import { HostController } from "../src/host-controller.js";
import { DesktopBroker, DesktopBrokerHostClient } from "../src/plugin/desktop-broker.js";
import { DesktopBrokerHostIpc, DesktopBrokerProjectedRegistry } from "../src/plugin/desktop-broker-host-ipc.js";
import { DesktopPluginIpcClient } from "../src/plugin/desktop-plugin-ipc.js";
import { DesktopControlGatewayService } from "../src/control/desktop-control-gateway.js";

const target: DesktopPluginTarget = {
  sessionId: "session-1",
  endpointId: "endpoint-1",
  normalizedCwd: "/work/app",
  processGeneration: "generation-1",
};
const sibling: DesktopPluginTarget = { ...target, endpointId: "endpoint-2", processGeneration: "generation-2" };

function record(targetValue: DesktopPluginTarget): DesktopBrokerTargetRecord {
  return { target: targetValue, capabilities: ["abort", "set_thinking", "ask-user-question"], runtimeStatus: "idle" };
}

function writeFrame(socket: Socket, frame: unknown): void {
  socket.write(`${JSON.stringify(frame)}\n`);
}

async function connect(socketPath: string): Promise<{ socket: Socket; nextFrame: () => Promise<Record<string, unknown>> }> {
  const socket = createConnection(socketPath);
  let buffer = "";
  const queued: Record<string, unknown>[] = [];
  const waiters: ((frame: Record<string, unknown>) => void)[] = [];
  socket.on("data", (data: Buffer) => {
    buffer += data.toString("utf8");
    while (true) {
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const frame = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else queued.push(frame);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  return {
    socket,
    nextFrame: () => new Promise((resolve) => {
      const frame = queued.shift();
      if (frame) resolve(frame);
      else waiters.push(resolve);
    }),
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached");
}
describe("DesktopBrokerHostIpc", () => {
  let host: DesktopBrokerHostIpc | undefined;
  let socket: Socket | undefined;
  let broker: DesktopBroker | undefined;
  let hostClient: DesktopBrokerHostClient | undefined;
  let pluginClient: DesktopPluginIpcClient | undefined;

  afterEach(async () => {
    socket?.destroy();
    pluginClient?.close();
    hostClient?.close();
    await broker?.close();
    await host?.close();
    socket = undefined;
    pluginClient = undefined;
    hostClient = undefined;
    broker = undefined;
    host = undefined;
  });

  it("preserves Plugin downstream connections while Host restarts and receives a fresh snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-broker-restart-"));
    const hostSocket = join(dir, "broker-host.sock");
    const pluginSocket = join(dir, "plugin.sock");
    host = new DesktopBrokerHostIpc({ socketPath: hostSocket, secret: "secret", hostInstanceId: "host-1" });
    await host.start();
    broker = new DesktopBroker({ pluginSocketPath: pluginSocket, secret: "secret", brokerInstanceId: "broker-1" });
    await broker.start();
    hostClient = new DesktopBrokerHostClient(broker, { socketPath: hostSocket, secret: "secret", reconnectDelayMs: 20 });
    hostClient.start();
    pluginClient = new DesktopPluginIpcClient({
      socketPath: pluginSocket,
      secret: "secret",
      target,
      capabilities: ["abort", "ask-user-question"],
      onRequest: async (request) => ({ type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "observed" }),
    });
    await pluginClient.connect();
    await waitFor(() => host?.projection.resolve(target) !== undefined);
    expect(host.projection.epoch).toBe("broker-1");

    await host.close();
    await pluginClient.sendAskRequest({ type: "desktop_ask_request", requestId: "ask-during-reconnect", toolCallId: "tool-1", questions: [{ question: "Continue?" }], deadlineAt: Date.now() + 10_000 });
    await waitFor(() => broker?.pendingAskFrames().length === 1);
    const replayed: unknown[] = [];
    host = new DesktopBrokerHostIpc({ socketPath: hostSocket, secret: "secret", hostInstanceId: "host-2", onAskRequest: (askTarget, request) => replayed.push({ target: askTarget, request }) });
    await host.start();
    await waitFor(() => host?.projection.resolve(target) !== undefined);
    await waitFor(() => replayed.length === 1);
    expect(replayed).toMatchObject([{ target, request: { requestId: "ask-during-reconnect" } }]);
    expect(host.projection.isValid).toBe(true);
    expect(pluginClient.isConnected).toBe(true);
  });
  it("closes an unauthenticated uplink during shutdown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-broker-host-close-"));
    const socketPath = join(dir, "broker.sock");
    host = new DesktopBrokerHostIpc({ socketPath, secret: "secret", hostInstanceId: "host-close" });
    await host.start();
    const pending = await connect(socketPath);
    socket = pending.socket;
    await expect(Promise.race([
      host.close().then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 300)),
    ])).resolves.toBe("closed");
    host = undefined;
  });

  it("accepts a fresh Broker handshake after the previous uplink disconnects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-broker-host-reconnect-"));
    const socketPath = join(dir, "broker.sock");
    host = new DesktopBrokerHostIpc({ socketPath, secret: "secret", hostInstanceId: "host-1" });
    await host.start();
    const first = await connect(socketPath);
    socket = first.socket;
    writeFrame(socket, { type: "desktop_broker_hello", protocolVersion: 1, brokerInstanceId: "broker-1", clientNonce: "nonce-1", secret: "secret" });
    await expect(first.nextFrame()).resolves.toMatchObject({ type: "desktop_broker_ready" });
    writeFrame(socket, { type: "desktop_broker_snapshot_begin", brokerInstanceId: "broker-1", snapshotId: "snapshot-1", revision: 1, targetCount: 0 });
    writeFrame(socket, { type: "desktop_broker_snapshot_end", brokerInstanceId: "broker-1", snapshotId: "snapshot-1", revision: 1, chunkCount: 0 });
    await waitFor(() => host?.projection.isValid === true);

    socket.destroy();
    await waitFor(() => host?.isConnected === false);

    const second = await connect(socketPath);
    socket = second.socket;
    writeFrame(socket, { type: "desktop_broker_hello", protocolVersion: 1, brokerInstanceId: "broker-2", clientNonce: "nonce-2", secret: "secret" });
    await expect(second.nextFrame()).resolves.toMatchObject({ type: "desktop_broker_ready", hostInstanceId: "host-1" });
  });

  it("atomically commits complete snapshots and fails closed on revision gaps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-broker-host-"));
    host = new DesktopBrokerHostIpc({ socketPath: join(dir, "broker.sock"), secret: "secret", hostInstanceId: "host-1" });
    await host.start();
    const connected = await connect(join(dir, "broker.sock"));
    socket = connected.socket;
    writeFrame(socket, {
      type: "desktop_broker_hello",
      protocolVersion: 1,
      brokerInstanceId: "broker-1",
      clientNonce: "nonce",
      secret: "secret",
    });
    await expect(connected.nextFrame()).resolves.toMatchObject({ type: "desktop_broker_ready", hostInstanceId: "host-1" });

    writeFrame(socket, { type: "desktop_broker_snapshot_begin", brokerInstanceId: "broker-1", snapshotId: "snapshot-1", revision: 7, targetCount: 1 });
    writeFrame(socket, { type: "desktop_broker_snapshot_chunk", brokerInstanceId: "broker-1", snapshotId: "snapshot-1", revision: 7, chunkIndex: 0, records: [record(target)] });
    expect(host.projection.list()).toHaveLength(0);
    writeFrame(socket, { type: "desktop_broker_snapshot_end", brokerInstanceId: "broker-1", snapshotId: "snapshot-1", revision: 7, chunkCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(host.projection.list()).toHaveLength(1);
    expect(host.projection.revision).toBe(7);

    writeFrame(socket, {
      type: "desktop_broker_delta",
      brokerInstanceId: "broker-1",
      baseRevision: 6,
      revision: 7,
      mutation: { kind: "runtime_status", target, runtimeStatus: "running" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(host.projection.isValid).toBe(false);
    expect(host.projection.list()).toHaveLength(0);
    await expect(connected.nextFrame()).resolves.toMatchObject({ type: "desktop_broker_error", code: "revision_gap" });
  });

  it("projects thinking level snapshots and contiguous deltas", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-broker-thinking-"));
    host = new DesktopBrokerHostIpc({ socketPath: join(dir, "broker.sock"), secret: "secret", hostInstanceId: "host-1" });
    await host.start();
    const connected = await connect(join(dir, "broker.sock"));
    socket = connected.socket;
    writeFrame(socket, { type: "desktop_broker_hello", protocolVersion: 1, brokerInstanceId: "broker-1", clientNonce: "nonce", secret: "secret" });
    await connected.nextFrame();
    writeFrame(socket, { type: "desktop_broker_snapshot_begin", brokerInstanceId: "broker-1", snapshotId: "snapshot-1", revision: 1, targetCount: 1 });
    writeFrame(socket, {
      type: "desktop_broker_snapshot_chunk",
      brokerInstanceId: "broker-1",
      snapshotId: "snapshot-1",
      revision: 1,
      chunkIndex: 0,
      records: [{ ...record(target), thinkingLevel: "medium" }],
    });
    writeFrame(socket, { type: "desktop_broker_snapshot_end", brokerInstanceId: "broker-1", snapshotId: "snapshot-1", revision: 1, chunkCount: 1 });
    await waitFor(() => host?.projection.resolve(target)?.thinkingLevel === "medium");

    writeFrame(socket, {
      type: "desktop_broker_delta",
      brokerInstanceId: "broker-1",
      baseRevision: 1,
      revision: 2,
      mutation: { kind: "thinking_level", target, level: "xhigh" },
    });
    await waitFor(() => host?.projection.resolve(target)?.thinkingLevel === "xhigh");
    expect(host.projection.isValid).toBe(true);
  });

  it("projects Broker records into the Host session directory through the existing controller path", async () => {
    const projection = new DesktopBrokerProjectedRegistry();
    const controller = new HostController(
      { createRuntime: async () => { throw new Error("not used"); }, listSessions: async () => [] },
      undefined,
      projection,
    );
    try {
      projection.register({
      target,
      sessionFile: "/sessions/session-1.jsonl",
      capabilities: ["abort", "ask-user-question"],
      runtimeStatus: "idle",
      transport: {
        request: async (request: import("@maestro-mobile/shared").DesktopPluginRequest): Promise<DesktopPluginResult> => ({ type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "unknown" }),
        close: () => undefined,
      },
    });
      controller.applyDesktopProjection([{ ...record(target), sessionFile: "/sessions/session-1.jsonl", thinkingLevel: "high" }]);
      expect(controller.directory.resolve(target)?.kind).toBe("desktop");
      expect(controller.directory.resolve(target)?.sessionFile).toBe("/sessions/session-1.jsonl");
      expect(controller.directory.resolve(target)?.thinkingLevel).toBe("high");
      expect(controller.directory.resolve(target)?.capabilities).toContain("abort");
      projection.register({
        target,
        capabilities: ["abort", "ask-user-question"],
        runtimeStatus: "idle",
        transport: {
          request: async (request: import("@maestro-mobile/shared").DesktopPluginRequest): Promise<DesktopPluginResult> => ({ type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "unknown" }),
          close: () => undefined,
        },
      });
      controller.applyDesktopProjection([record(target)]);
      expect(controller.directory.resolve(target)?.sessionFile).toBeUndefined();
      projection.clear();
      controller.applyDesktopProjection([]);
      expect(controller.directory.resolve(target)).toBeUndefined();
    } finally {
      await controller.dispose();
    }
  });

  it("waits for Plugin acceptance across Broker Host IPC before returning the ask receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-broker-host-ask-receipt-"));
    const hostSocket = join(dir, "broker-host.sock");
    const pluginSocket = join(dir, "plugin.sock");
    let askRequest: { requestId: string; toolCallId: string } | undefined;
    let resolveAsk: (() => void) | undefined;
    const askSeen = new Promise<void>((resolve) => { resolveAsk = resolve; });
    host = new DesktopBrokerHostIpc({
      socketPath: hostSocket,
      secret: "secret",
      onAskRequest: (_askTarget, request) => {
        askRequest = request;
        resolveAsk?.();
      },
    });
    await host.start();
    broker = new DesktopBroker({ pluginSocketPath: pluginSocket, secret: "secret", brokerInstanceId: "broker-ask-receipt" });
    await broker.start();
    hostClient = new DesktopBrokerHostClient(broker, { socketPath: hostSocket, secret: "secret", reconnectDelayMs: 20 });
    hostClient.start();
    pluginClient = new DesktopPluginIpcClient({
      socketPath: pluginSocket,
      secret: "secret",
      target,
      capabilities: ["ask-user-question"],
      onRequest: async (request) => ({ type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "observed" }),
      onAskResponse: async () => undefined,
    });
    await pluginClient.connect();
    await waitFor(() => host?.projection.resolve(target) !== undefined);
    await pluginClient.sendAskRequest({ type: "desktop_ask_request", requestId: "ask-host-receipt", toolCallId: "tool-host-receipt", questions: [{ question: "Continue?" }], deadlineAt: Date.now() + 1000 });
    await askSeen;
    const gateway = new DesktopControlGatewayService(host.projection);
    await expect(gateway.answerAsk(target, askRequest!.requestId, askRequest!.toolCallId, { selected: ["yes"] })).resolves.toMatchObject({ status: "accepted" });
  });

  it("uses one physical link for exact logical targets and never replays pending commands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-broker-host-command-"));
    host = new DesktopBrokerHostIpc({ socketPath: join(dir, "broker.sock"), secret: "secret" });
    await host.start();
    const connected = await connect(join(dir, "broker.sock"));
    socket = connected.socket;
    writeFrame(socket, { type: "desktop_broker_hello", protocolVersion: 1, brokerInstanceId: "broker-1", clientNonce: "nonce", secret: "secret" });
    await connected.nextFrame();
    writeFrame(socket, { type: "desktop_broker_snapshot_begin", brokerInstanceId: "broker-1", snapshotId: "snapshot-1", revision: 1, targetCount: 2 });
    writeFrame(socket, { type: "desktop_broker_snapshot_chunk", brokerInstanceId: "broker-1", snapshotId: "snapshot-1", revision: 1, chunkIndex: 0, records: [record(target), record(sibling)] });
    writeFrame(socket, { type: "desktop_broker_snapshot_end", brokerInstanceId: "broker-1", snapshotId: "snapshot-1", revision: 1, chunkCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const gateway = new DesktopControlGatewayService(host.projection, 1000);
    const pending = gateway.execute({ requestId: "command-1", target, kind: "set_thinking", level: "high" });
    const command = await connected.nextFrame();
    expect(command).toMatchObject({
      type: "desktop_broker_command",
      request: { requestId: "command-1", target, operation: { type: "set_thinking", level: "high" } },
    });
    writeFrame(socket, { type: "desktop_broker_command_result", target, result: { type: "desktop_plugin_result", requestId: "command-1", operation: "set_thinking", status: "observed" } });
    await expect(pending).resolves.toMatchObject({ status: "observed" });

    host.projection.resolve(target)?.transport.close();
    const siblingPending = gateway.execute({ requestId: "command-2", target: sibling, kind: "abort" });
    const siblingCommand = await connected.nextFrame();
    expect(siblingCommand).toMatchObject({ type: "desktop_broker_command", request: { requestId: "command-2", target: sibling } });
    writeFrame(socket, { type: "desktop_broker_command_result", target: sibling, result: { type: "desktop_plugin_result", requestId: "command-2", operation: "abort", status: "observed" } });
    await expect(siblingPending).resolves.toMatchObject({ status: "observed" });

    socket.destroy();
    await expect(gateway.execute({ requestId: "command-3", target: sibling, kind: "abort" })).resolves.toMatchObject({ status: "unknown" });
  });
});
