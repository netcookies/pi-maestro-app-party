import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DesktopPluginResult, DesktopPluginTarget } from "@maestro-mobile/shared";
import { DesktopBroker } from "../src/plugin/desktop-broker.js";
import { DesktopPluginIpcClient } from "../src/plugin/desktop-plugin-ipc.js";
import { DesktopPluginRegistry } from "../src/plugin/desktop-plugin-registry.js";
import { DesktopPluginRegistryStore } from "../src/plugin/desktop-plugin-registry-store.js";

const target: DesktopPluginTarget = {
  sessionId: "session-1",
  endpointId: "endpoint-1",
  normalizedCwd: "/work/app",
  processGeneration: "generation-1",
};

function transport() {
  return {
    close: () => undefined,
    request: async (request: { requestId: string; operation: { type: string } }): Promise<DesktopPluginResult> => ({
      type: "desktop_plugin_result",
      requestId: request.requestId,
      operation: request.operation.type,
      status: "observed",
    }),
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not reached");
}

describe("DesktopBroker peer messaging", () => {
  it("lists feature-negotiated peers and requires an exact authorized target receipt", async () => {
    const registry = new DesktopPluginRegistry();
    const source = { ...target };
    const peer = { ...target, sessionId: "session-2", endpointId: "endpoint-2", processGeneration: "generation-2" };
    let delivered: unknown;
    const sourceTransport = { ...transport(), deliverPeerMessage: async () => "acknowledged" as const };
    const peerTransport = { ...transport(), deliverPeerMessage: async (delivery: unknown) => { delivered = delivery; return "acknowledged" as const; } };
    registry.register({ target: source, capabilities: [], features: ["peer-message-v1"], transport: sourceTransport });
    registry.register({ target: peer, capabilities: [], features: ["peer-message-v1"], transport: peerTransport });
    const broker = new DesktopBroker({ pluginSocketPath: "/tmp/not-started.sock", secret: "secret", registry });
    const listed = await broker.handlePeerRequest(source, { type: "desktop_peer_list", requestId: "list", deadlineAt: Date.now() + 1000 });
    expect(listed).toMatchObject({ status: "listed", peers: [peer], truncated: false });
    const result = await broker.handlePeerRequest(source, { type: "desktop_peer_send", requestId: "send", deadlineAt: Date.now() + 1000, target: peer, message: "hello" });
    expect(result).toMatchObject({ status: "acknowledged", deliveryId: expect.any(String) });
    expect(delivered).toMatchObject({ source, target: peer, message: "hello" });
    const stale = await broker.handlePeerRequest(source, { type: "desktop_peer_send", requestId: "stale", deadlineAt: Date.now() + 1000, target: { ...peer, processGeneration: "old" }, message: "hello" });
    expect(stale).toMatchObject({ status: "unknown", error: { code: "target_unavailable" } });
    await broker.close();
  });

  it("reuses acknowledged receipt for a duplicate request id", async () => {
    const registry = new DesktopPluginRegistry();
    const source = { ...target };
    const peer = { ...target, sessionId: "session-2", endpointId: "endpoint-2", processGeneration: "generation-2" };
    let deliveries = 0;
    registry.register({ target: source, capabilities: [], features: ["peer-message-v1"], transport: transport() });
    registry.register({ target: peer, capabilities: [], features: ["peer-message-v1"], transport: { ...transport(), deliverPeerMessage: async () => { deliveries += 1; return "acknowledged" as const; } } });
    const broker = new DesktopBroker({ pluginSocketPath: "/tmp/unused.sock", secret: "secret", registry });
    const request = { type: "desktop_peer_send" as const, requestId: "idempotent", deadlineAt: Date.now() + 1000, target: peer, message: "once" };
    const first = await broker.handlePeerRequest(source, request);
    const second = await broker.handlePeerRequest(source, request);
    expect(second).toEqual(first);
    expect(deliveries).toBe(1);
    await broker.close();
  });

  it("fails closed for cross-cwd send without explicit allow rule", async () => {
    const registry = new DesktopPluginRegistry();
    const source = { ...target };
    const peer = { ...target, sessionId: "session-2", endpointId: "endpoint-2", normalizedCwd: "/other", processGeneration: "generation-2" };
    registry.register({ target: source, capabilities: [], features: ["peer-message-v1"], transport: transport() });
    registry.register({ target: peer, capabilities: [], features: ["peer-message-v1"], transport: transport() });
    const broker = new DesktopBroker({ pluginSocketPath: "/tmp/not-started.sock", secret: "secret", registry });
    const result = await broker.handlePeerRequest(source, { type: "desktop_peer_send", requestId: "cross", deadlineAt: Date.now() + 1000, target: peer, message: "hello" });
    expect(result).toMatchObject({ status: "failed", error: { code: "cross_cwd_not_authorized" } });
    await broker.close();
  });
});

describe("DesktopPluginRegistry", () => {
  it("replaces exact targets without allowing delayed old close to remove the new transport", () => {
    const registry = new DesktopPluginRegistry();
    const first = transport();
    const second = transport();
    const revisions: number[] = [];
    registry.subscribe(({ revision }) => revisions.push(revision));

    registry.register({ target, capabilities: ["abort"], transport: first });
    registry.register({ target, capabilities: ["abort"], transport: second });

    expect(registry.unregister(target, first)).toBe(false);
    expect(registry.resolve(target)?.transport).toBe(second);
    expect(revisions).toEqual([1, 2]);
  });

  it("updates projection fields with one revision per mutation", () => {
    const registry = new DesktopPluginRegistry();
    registry.register({ target, capabilities: ["abort"], transport: transport() });
    registry.updateModel(target, { provider: "provider", id: "model", name: "Model", reasoning: true, vision: false });
    registry.updateThinkingLevel(target, "high");
    registry.updateRuntimeStatus(target, "running");
    registry.updateSessionSummary(target, { runtimeStatus: "running", messageCount: 3 });

    expect(registry.revision).toBe(5);
    expect(registry.snapshotRecords()[0]).toMatchObject({
      target,
      runtimeStatus: "running",
      model: { id: "model" },
      thinkingLevel: "high",
      summary: { messageCount: 3 },
    });
  });
});

describe("DesktopPluginRegistryStore", () => {
  it("writes the latest snapshot atomically and keeps diagnostic metadata non-authoritative", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-registry-store-"));
    const filePath = join(dir, "registry.json");
    const store = new DesktopPluginRegistryStore({ filePath, brokerInstanceId: "broker-1", debounceMs: 1 });
    for (let revision = 1; revision <= 20; revision += 1) {
      store.schedule({ schemaVersion: 1, brokerInstanceId: "broker-1", revision, registrations: [] });
    }
    await Promise.all([
      store.flush(),
      store.flush({ schemaVersion: 1, brokerInstanceId: "broker-1", revision: 21, registrations: [] }),
    ]);

    const parsed = JSON.parse(await readFile(filePath, "utf8")) as { revision: number; registrations: unknown[] };
    expect(parsed.revision).toBe(21);
    expect(parsed.registrations).toEqual([]);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    await store.close();
  });
});

describe("DesktopBroker", () => {
  let broker: DesktopBroker | undefined;
  let client: DesktopPluginIpcClient | undefined;

  afterEach(async () => {
    client?.close();
    await broker?.close();
    client = undefined;
    broker = undefined;
  });

  it("emits revisioned snapshots and routes exact command and ask frames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-broker-"));
    const frames: unknown[] = [];
    broker = new DesktopBroker({
      pluginSocketPath: join(dir, "plugin.sock"),
      secret: "secret",
      brokerInstanceId: "broker-1",
      onFrame: (frame) => frames.push(frame),
    });
    await broker.start();
    let askResponse: unknown;
    client = new DesktopPluginIpcClient({
      socketPath: join(dir, "plugin.sock"),
      secret: "secret",
      target,
      sessionFile: "/sessions/session-1.jsonl",
      capabilities: ["abort", "ask-user-question"],
      onRequest: async (request): Promise<DesktopPluginResult> => ({
        type: "desktop_plugin_result",
        requestId: request.requestId,
        operation: request.operation.type,
        status: "observed",
      }),
      onAskResponse: async (response) => { askResponse = response; },
    });
    await client.connect();
    await waitFor(() => broker?.registry.resolve(target) !== undefined);

    const snapshot = broker.createSnapshotFrames();
    expect(snapshot[0]).toMatchObject({ type: "desktop_broker_snapshot_begin", revision: 1, targetCount: 1 });
    expect(snapshot).toContainEqual(expect.objectContaining({
      type: "desktop_broker_snapshot_chunk",
      records: [expect.objectContaining({ sessionFile: "/sessions/session-1.jsonl", target })],
    }));
    expect(snapshot.at(-1)).toMatchObject({ type: "desktop_broker_snapshot_end", revision: 1, chunkCount: 1 });

    await broker.handleHostFrame({
      type: "desktop_broker_command",
      request: {
        type: "desktop_plugin_request",
        requestId: "request-1",
        commandId: "command-1",
        deadlineAt: Date.now() + 1000,
        target,
        operation: { type: "abort" },
      },
    });
    expect(frames).toContainEqual(expect.objectContaining({
      type: "desktop_broker_command_result",
      target,
      result: expect.objectContaining({ requestId: "request-1", status: "observed" }),
    }));

    await client.sendAskRequest({
      type: "desktop_ask_request",
      requestId: "ask_a|fc_b",
      toolCallId: "call_a|fc_b",
      questions: [{ question: "Continue?" }],
    });
    await waitFor(() => frames.some((frame) => (frame as { type?: string }).type === "desktop_broker_ask_request"));
    expect(broker.pendingAskFrames()).toContainEqual(expect.objectContaining({ type: "desktop_broker_ask_request", target, request: expect.objectContaining({ requestId: "ask_a|fc_b", toolCallId: "call_a|fc_b" }) }));
    await broker.handleHostFrame({
      type: "desktop_broker_ask_response",
      target: { ...target, processGeneration: "other" },
      response: { type: "desktop_ask_response", requestId: "ask_a|fc_b", toolCallId: "call_a|fc_b", response: { selected: ["no"] } },
    });
    expect(broker.pendingAskFrames()).toHaveLength(1);
    await broker.handleHostFrame({
      type: "desktop_broker_ask_response",
      target,
      response: { type: "desktop_ask_response", requestId: "ask_a|fc_b", toolCallId: "call_a|fc_b", response: { selected: ["yes"] } },
    });
    await waitFor(() => askResponse !== undefined);
    expect(askResponse).toMatchObject({ requestId: "ask_a|fc_b", toolCallId: "call_a|fc_b", response: { selected: ["yes"] } });
    expect(broker.pendingAskFrames()).toHaveLength(0);
    expect(broker.registry.revision).toBe(1);
  });

  it("routes online peer send, explicit ack and correlated reply between exact plugin connections across cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-broker-peer-ipc-"));
    broker = new DesktopBroker({
      pluginSocketPath: join(dir, "plugin.sock"), secret: "secret", brokerInstanceId: "broker-peer",
      crossCwdAllowRules: [{ sourceCwd: "/work/app", targetCwd: "/work/other" }],
    });
    await broker.start();
    const source = { ...target };
    const peer = { ...target, sessionId: "session-2", endpointId: "endpoint-2", normalizedCwd: "/work/other", processGeneration: "generation-2" };
    let sourceReply: unknown;
    const sourceClient = new DesktopPluginIpcClient({
      socketPath: join(dir, "plugin.sock"), secret: "secret", target: source, capabilities: [], features: ["peer-message-v1"],
      onRequest: async (request) => ({ type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "observed" }),
      onPeerDelivery: async () => undefined,
      onPeerReply: (reply) => { sourceReply = reply; },
    });
    const peerClient = new DesktopPluginIpcClient({
      socketPath: join(dir, "plugin.sock"), secret: "secret", target: peer, capabilities: [], features: ["peer-message-v1"],
      onRequest: async (request) => ({ type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "observed" }),
      onPeerDelivery: async (delivery) => {
        peerClient.sendPeerReply({ type: "desktop_peer_reply", deliveryId: delivery.deliveryId, replyId: "reply-1", message: "back" });
      },
    });
    client = sourceClient;
    await Promise.all([sourceClient.connect(), peerClient.connect()]);
    await waitFor(() => broker?.registry.resolve(source) !== undefined && broker?.registry.resolve(peer) !== undefined);
    const peers = await sourceClient.requestPeers({ type: "desktop_peer_list", requestId: "list", deadlineAt: Date.now() + 2000 });
    expect(peers).toMatchObject({ status: "listed", peers: [peer] });
    const result = await sourceClient.requestPeers({ type: "desktop_peer_send", requestId: "send", deadlineAt: Date.now() + 2000, target: peer, message: "hello" });
    expect(result).toMatchObject({ status: "acknowledged", deliveryId: expect.any(String) });
    await waitFor(() => sourceReply !== undefined);
    expect(sourceReply).toMatchObject({ deliveryId: result.deliveryId, message: "back" });
    peerClient.close();
  });

  it("propagates a Plugin Ask cancellation to Host and clears Broker state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-broker-ask-cancel-"));
    const frames: DesktopBrokerToHostFrame[] = [];
    broker = new DesktopBroker({ pluginSocketPath: join(dir, "plugin.sock"), secret: "secret", brokerInstanceId: "broker-cancel", onFrame: (frame) => frames.push(frame) });
    await broker.start();
    client = new DesktopPluginIpcClient({
      socketPath: join(dir, "plugin.sock"), secret: "secret", target, capabilities: ["ask-user-question"],
      onRequest: async (request) => ({ type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "observed" }),
    });
    await client.connect();
    await waitFor(() => broker?.registry.resolve(target) !== undefined);
    const request = { type: "desktop_ask_request" as const, requestId: "ask-cancel", toolCallId: "tool-cancel", questions: [{ question: "Cancel?" }] };
    await client.sendAskRequest(request);
    await waitFor(() => broker?.pendingAskFrames().length === 1);
    await client.sendAskCancellation(request);
    await waitFor(() => frames.some((frame) => frame.type === "desktop_broker_ask_cancel"));
    expect(frames).toContainEqual(expect.objectContaining({ type: "desktop_broker_ask_cancel", target, response: expect.objectContaining({ requestId: "ask-cancel", toolCallId: "tool-cancel", response: { id: "ask-cancel", cancelled: true } }) }));
    expect(broker.pendingAskFrames()).toHaveLength(0);
  });

  it("routes Plugin rejection as a correlated failed Host receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-broker-ask-rejected-"));
    const frames: DesktopBrokerToHostFrame[] = [];
    broker = new DesktopBroker({ pluginSocketPath: join(dir, "plugin.sock"), secret: "secret", brokerInstanceId: "broker-rejected", onFrame: (frame) => frames.push(frame) });
    await broker.start();
    let attempts = 0;
    client = new DesktopPluginIpcClient({
      socketPath: join(dir, "plugin.sock"), secret: "secret", target, capabilities: ["ask-user-question"],
      onRequest: async (request) => ({ type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "observed" }),
      onAskResponse: async () => { if (++attempts === 1) throw new Error("ask expired"); },
    });
    await client.connect();
    await waitFor(() => broker?.registry.resolve(target) !== undefined);
    await client.sendAskRequest({ type: "desktop_ask_request", requestId: "ask-rejected", toolCallId: "tool-rejected", questions: [{ question: "Continue?" }] });
    await waitFor(() => broker?.pendingAskFrames().length === 1);
    await broker.handleHostFrame({ type: "desktop_broker_ask_response", target, response: { type: "desktop_ask_response", requestId: "ask-rejected", toolCallId: "tool-rejected", response: { selected: ["yes"] } } });
    await waitFor(() => frames.some((frame) => frame.type === "desktop_broker_ask_result"));
    expect(frames).toContainEqual(expect.objectContaining({ type: "desktop_broker_ask_result", target, result: expect.objectContaining({ requestId: "ask-rejected", toolCallId: "tool-rejected", status: "failed" }) }));
    expect(broker.pendingAskFrames()).toHaveLength(1);
    await broker.handleHostFrame({ type: "desktop_broker_ask_response", target, response: { type: "desktop_ask_response", requestId: "ask-rejected", toolCallId: "tool-rejected", response: { selected: ["yes"] } } });
    await waitFor(() => frames.filter((frame) => frame.type === "desktop_broker_ask_result" && frame.result.status === "accepted").length === 1);
    expect(attempts).toBe(2);
    expect(broker.pendingAskFrames()).toHaveLength(0);
  });

  it("replays a pending no-deadline ask after reconnect with the same request identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-broker-ask-replay-"));
    const frames: DesktopBrokerToHostFrame[] = [];
    broker = new DesktopBroker({ pluginSocketPath: join(dir, "plugin.sock"), secret: "secret", brokerInstanceId: "broker-ask-replay", onFrame: (frame) => frames.push(frame) });
    await broker.start();
    client = new DesktopPluginIpcClient({
      socketPath: join(dir, "plugin.sock"), secret: "secret", target, capabilities: ["ask-user-question"],
      onRequest: async (request) => ({ type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "observed" }),
    });
    await client.connect();
    await waitFor(() => broker?.registry.resolve(target) !== undefined);
    const request = { type: "desktop_ask_request" as const, requestId: "ask-live", toolCallId: "tool-live", questions: [{ question: "Continue?" }] };
    await client.sendAskRequest(request);
    await waitFor(() => broker?.pendingAskFrames().length === 1);
    expect(broker.pendingAskFrames()[0]).toMatchObject({ request, target });
    expect(broker.pendingPlanFrames()).toHaveLength(0);
    expect(frames).toContainEqual(expect.objectContaining({ type: "desktop_broker_ask_request", request, target }));
    await broker.handleHostFrame({ type: "desktop_broker_ask_response", target, response: { type: "desktop_ask_response", requestId: request.requestId, toolCallId: request.toolCallId, response: { selected: ["yes"] } } });
    await waitFor(() => broker?.pendingAskFrames().length === 0);
  });

  it("rejects a mismatched toolCallId while retaining the active Ask", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-broker-ask-active-"));
    const frames: DesktopBrokerToHostFrame[] = [];
    broker = new DesktopBroker({ pluginSocketPath: join(dir, "plugin.sock"), secret: "secret", brokerInstanceId: "broker-active", onFrame: (frame) => frames.push(frame) });
    await broker.start();
    client = new DesktopPluginIpcClient({
      socketPath: join(dir, "plugin.sock"), secret: "secret", target, capabilities: ["ask-user-question"],
      onRequest: async (request) => ({ type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "observed" }),
    });
    await client.connect();
    await waitFor(() => broker?.registry.resolve(target) !== undefined);
    const request = { type: "desktop_ask_request" as const, requestId: "ask-active", toolCallId: "tool-active", questions: [{ question: "Continue?" }] };
    await client.sendAskRequest(request);
    await waitFor(() => broker?.pendingAskFrames().length === 1);
    await broker.handleHostFrame({ type: "desktop_broker_ask_response", target, response: { type: "desktop_ask_response", requestId: request.requestId, toolCallId: "wrong-tool", response: { selected: ["yes"] } } });
    expect(broker.pendingAskFrames()).toHaveLength(1);
    expect(frames).toContainEqual(expect.objectContaining({ type: "desktop_broker_ask_result", result: expect.objectContaining({ status: "unknown", error: expect.objectContaining({ code: "target_unavailable" }) }) }));
    await broker.handleHostFrame({ type: "desktop_broker_ask_response", target, response: { type: "desktop_ask_response", requestId: request.requestId, toolCallId: request.toolCallId, response: { selected: ["yes"] } } });
    await waitFor(() => broker?.pendingAskFrames().length === 0);
  });
});
