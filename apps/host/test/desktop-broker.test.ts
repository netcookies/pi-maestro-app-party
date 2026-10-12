import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DesktopPeerDelivery, DesktopPluginResult, DesktopPluginTarget } from "@maestro-mobile/shared";
import { registerDesktopPeerCommand } from "../src/plugin/desktop-peer-extension.js";
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

const PEER_FEATURE = "peer-message-v2";

describe("DesktopBroker peer messaging", () => {
  it("persists exact cwd grants, enforces direction, and restores them after Broker restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-peer-access-"));
    const accessPath = join(dir, "peer-access.json");
    const registry = new DesktopPluginRegistry();
    const source = { ...target };
    const peer = { ...target, sessionId: "session-2", endpointId: "endpoint-2", normalizedCwd: "/other", processGeneration: "generation-2" };
    registry.register({ target: source, capabilities: [], features: [PEER_FEATURE], transport: transport() });
    registry.register({ target: peer, capabilities: [], features: [PEER_FEATURE], transport: { ...transport(), deliverPeerMessage: async () => "accepted" as const } });
    const broker = new DesktopBroker({ pluginSocketPath: "/tmp/not-started.sock", secret: "secret", registry, peerAccessPath: accessPath });
    try {
      const hidden = await broker.handlePeerRequest(source, { type: "desktop_peer_list", requestId: "list-before", deadlineAt: Date.now() + 1000 });
      expect(hidden).toMatchObject({ status: "listed", peers: [] });
      expect(await broker.handlePeerRequest(source, { type: "desktop_peer_candidates", requestId: "candidates", deadlineAt: Date.now() + 1000 })).toMatchObject({ status: "candidates", candidates: [peer] });
      const denied = await broker.handlePeerRequest(source, { type: "desktop_peer_send", requestId: "send-before", deadlineAt: Date.now() + 1000, target: peer, message: "hello" });
      expect(denied).toMatchObject({ status: "failed", error: { code: "authorization_required" }, authorization: { sourceCwd: "/work/app", targetCwd: "/other" } });
      const grant = await broker.handlePeerRequest(source, { type: "desktop_peer_access_grant", requestId: "grant", deadlineAt: Date.now() + 1000, target: peer, direction: "one_way" });
      expect(grant).toMatchObject({ status: "access_granted", grant: { sourceCwd: "/work/app", targetCwd: "/other", direction: "one_way", managed: false } });
      expect((await stat(accessPath)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(accessPath, "utf8"))).toHaveLength(1);
      expect(await broker.handlePeerRequest(source, { type: "desktop_peer_list", requestId: "list-after", deadlineAt: Date.now() + 1000 })).toMatchObject({ status: "listed", peers: [peer] });
      const reverse = await broker.handlePeerRequest(peer, { type: "desktop_peer_list", requestId: "reverse", deadlineAt: Date.now() + 1000 });
      expect(reverse).toMatchObject({ status: "listed", peers: [] });
      await broker.close();
      registry.register({ target: source, capabilities: [], features: [PEER_FEATURE], transport: transport() });
      registry.register({ target: peer, capabilities: [], features: [PEER_FEATURE], transport: { ...transport(), deliverPeerMessage: async () => "accepted" as const } });
      const restored = new DesktopBroker({ pluginSocketPath: "/tmp/not-started.sock", secret: "secret", registry, peerAccessPath: accessPath });
      expect(await restored.handlePeerRequest(source, { type: "desktop_peer_list", requestId: "restored", deadlineAt: Date.now() + 1000 })).toMatchObject({ status: "listed", peers: [peer] });
      const grantId = (grant as { grant?: { grantId: string } }).grant!.grantId;
      const revoked = await restored.handlePeerRequest(source, { type: "desktop_peer_access_revoke", requestId: "revoke", deadlineAt: Date.now() + 1000, grantId });
      expect(revoked).toMatchObject({ status: "access_revoked", grantId });
      expect(await restored.handlePeerRequest(source, { type: "desktop_peer_list", requestId: "list-revoked", deadlineAt: Date.now() + 1000 })).toMatchObject({ status: "listed", peers: [] });
      await restored.close();
      registry.register({ target: source, capabilities: [], features: [PEER_FEATURE], transport: transport() });
      registry.register({ target: peer, capabilities: [], features: [PEER_FEATURE], transport: transport() });
      const revokedRestart = new DesktopBroker({ pluginSocketPath: "/tmp/not-started.sock", secret: "secret", registry, peerAccessPath: accessPath });
      expect(await revokedRestart.handlePeerRequest(source, { type: "desktop_peer_list", requestId: "revoked-restart", deadlineAt: Date.now() + 1000 })).toMatchObject({ status: "listed", peers: [] });
      await revokedRestart.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses Broker startup for corrupt authorization state and protects managed grants from revoke", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-peer-access-corrupt-"));
    const accessPath = join(dir, "peer-access.json");
    const registry = new DesktopPluginRegistry();
    const source = { ...target };
    const peer = { ...target, sessionId: "session-2", endpointId: "endpoint-2", normalizedCwd: "/other", processGeneration: "generation-2" };
    registry.register({ target: source, capabilities: [], features: [PEER_FEATURE], transport: transport() });
    registry.register({ target: peer, capabilities: [], features: [PEER_FEATURE], transport: transport() });
    try {
      await (await import("node:fs/promises")).writeFile(accessPath, "not json");
      const corrupt = new DesktopBroker({ pluginSocketPath: join(dir, "socket"), secret: "secret", registry, peerAccessPath: accessPath });
      await expect(corrupt.start()).rejects.toThrow("Broker startup refused");
      expect(await readFile(accessPath, "utf8")).toBe("not json");
      const managed = new DesktopBroker({ pluginSocketPath: "/tmp/not-started.sock", secret: "secret", registry, peerAccessPath: join(dir, "empty.json"), crossCwdAllowRules: [{ sourceCwd: "/work/app", targetCwd: "/other" }] });
      const grants = await managed.handlePeerRequest(source, { type: "desktop_peer_access_list", requestId: "access", deadlineAt: Date.now() + 1000 });
      expect(grants).toMatchObject({ status: "access_listed", grants: [{ managed: true, sourceCwd: "/work/app", targetCwd: "/other" }] });
      const grantId = (grants as { grants: Array<{ grantId: string }> }).grants[0].grantId;
      expect(await managed.handlePeerRequest(source, { type: "desktop_peer_access_revoke", requestId: "revoke", deadlineAt: Date.now() + 1000, grantId })).toMatchObject({ status: "failed", error: { code: "managed_grant" } });
      await managed.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("serializes concurrent changes and refuses another cwd's revoke", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-peer-concurrent-"));
    const registry = new DesktopPluginRegistry();
    const peerA = { ...target, sessionId: "a", endpointId: "a", processGeneration: "a", normalizedCwd: "/a" };
    const peerB = { ...target, sessionId: "b", endpointId: "b", processGeneration: "b", normalizedCwd: "/b" };
    for (const item of [target, peerA, peerB]) registry.register({ target: item, capabilities: [], features: [PEER_FEATURE], transport: transport() });
    const accessPath = join(dir, "peer-access.json");
    const broker = new DesktopBroker({ pluginSocketPath: join(dir, "socket"), secret: "secret", registry, peerAccessPath: accessPath });
    try {
      const [first, second] = await Promise.all([peerA, peerB].map((peer, index) => broker.handlePeerRequest(target, { type: "desktop_peer_access_grant", requestId: `grant-${index}`, deadlineAt: Date.now() + 5000, target: peer, direction: "one_way" })));
      expect(first.status).toBe("access_granted");
      expect(second.status).toBe("access_granted");
      expect(JSON.parse(await readFile(accessPath, "utf8"))).toHaveLength(2);
      const grantId = first.grant!.grantId;
      expect(await broker.handlePeerRequest(peerB, { type: "desktop_peer_access_revoke", requestId: "foreign", deadlineAt: Date.now() + 1000, grantId })).toMatchObject({ status: "failed", error: { code: "grant_not_owned" } });
      expect(await broker.handlePeerRequest(target, { type: "desktop_peer_list", requestId: "still-allowed", deadlineAt: Date.now() + 1000 })).toMatchObject({ status: "listed", peers: expect.arrayContaining([peerA, peerB]) });
    } finally { await broker.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("blocks an in-flight delivery after access is revoked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-peer-revoke-"));
    const registry = new DesktopPluginRegistry();
    const peer = { ...target, sessionId: "peer", endpointId: "peer", processGeneration: "peer", normalizedCwd: "/other" };
    let release!: () => void;
    const delivered = new Promise<void>((resolve) => { release = resolve; });
    registry.register({ target, capabilities: [], features: [PEER_FEATURE], transport: transport() });
    registry.register({ target: peer, capabilities: [], features: [PEER_FEATURE], transport: { ...transport(), deliverPeerMessage: async () => { await delivered; return "accepted" as const; } } });
    const broker = new DesktopBroker({ pluginSocketPath: join(dir, "socket"), secret: "secret", registry, peerAccessPath: join(dir, "peer-access.json") });
    try {
      const granted = await broker.handlePeerRequest(target, { type: "desktop_peer_access_grant", requestId: "grant", deadlineAt: Date.now() + 1000, target: peer, direction: "one_way" });
      const pending = broker.handlePeerRequest(target, { type: "desktop_peer_send", requestId: "send", deadlineAt: Date.now() + 2000, target: peer, message: "hello" });
      await Promise.resolve();
      expect(await broker.handlePeerRequest(target, { type: "desktop_peer_access_revoke", requestId: "revoke", deadlineAt: Date.now() + 1000, grantId: granted.grant!.grantId })).toMatchObject({ status: "access_revoked" });
      release();
      expect(await pending).toMatchObject({ status: "failed", error: { code: "authorization_required" } });
    } finally { release(); await broker.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("lists feature-negotiated peers and requires an exact authorized target receipt", async () => {
    const registry = new DesktopPluginRegistry();
    const source = { ...target };
    const peer = { ...target, sessionId: "session-2", endpointId: "endpoint-2", processGeneration: "generation-2" };
    let delivered: unknown;
    const sourceTransport = { ...transport(), deliverPeerMessage: async () => "accepted" as const };
    const peerTransport = { ...transport(), deliverPeerMessage: async (delivery: unknown) => { delivered = delivery; return "accepted" as const; } };
    registry.register({ target: source, capabilities: [], features: [PEER_FEATURE], transport: sourceTransport });
    registry.register({ target: peer, capabilities: [], features: [PEER_FEATURE], transport: peerTransport });
    const broker = new DesktopBroker({ pluginSocketPath: "/tmp/not-started.sock", secret: "secret", registry });
    const listed = await broker.handlePeerRequest(source, { type: "desktop_peer_list", requestId: "list", deadlineAt: Date.now() + 1000 });
    expect(listed).toMatchObject({ status: "listed", peers: [peer], truncated: false });
    const result = await broker.handlePeerRequest(source, { type: "desktop_peer_send", requestId: "send", deadlineAt: Date.now() + 1000, target: peer, message: "hello" });
    expect(result).toMatchObject({ status: "accepted", deliveryId: expect.any(String) });
    expect(delivered).toMatchObject({ source, target: peer, message: "hello" });
    const stale = await broker.handlePeerRequest(source, { type: "desktop_peer_send", requestId: "stale", deadlineAt: Date.now() + 1000, target: { ...peer, processGeneration: "old" }, message: "hello" });
    expect(stale).toMatchObject({ status: "unknown", error: { code: "target_unavailable" } });
    await broker.close();
  });

  it("reuses accepted receipt for a duplicate request id", async () => {
    const registry = new DesktopPluginRegistry();
    const source = { ...target };
    const peer = { ...target, sessionId: "session-2", endpointId: "endpoint-2", processGeneration: "generation-2" };
    let deliveries = 0;
    registry.register({ target: source, capabilities: [], features: [PEER_FEATURE], transport: transport() });
    registry.register({ target: peer, capabilities: [], features: [PEER_FEATURE], transport: { ...transport(), deliverPeerMessage: async () => { deliveries += 1; return "accepted" as const; } } });
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
    registry.register({ target: source, capabilities: [], features: [PEER_FEATURE], transport: transport() });
    registry.register({ target: peer, capabilities: [], features: [PEER_FEATURE], transport: transport() });
    const broker = new DesktopBroker({ pluginSocketPath: "/tmp/not-started.sock", secret: "secret", registry });
    const result = await broker.handlePeerRequest(source, { type: "desktop_peer_send", requestId: "cross", deadlineAt: Date.now() + 1000, target: peer, message: "hello" });
    expect(result).toMatchObject({ status: "failed", error: { code: "authorization_required" }, authorization: { sourceCwd: source.normalizedCwd, targetCwd: peer.normalizedCwd } });
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

  it("delivers A→B→A→B through real UDS inboxes, persists authorization across restart, and revokes both directions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-broker-peer-access-ipc-"));
    const socketPath = join(dir, "plugin.sock");
    const accessPath = join(dir, "peer-access.json");
    const source = { ...target };
    const peer = { ...target, sessionId: "session-2", endpointId: "endpoint-2", normalizedCwd: "/work/other", processGeneration: "generation-2" };
    let sourceClient: DesktopPluginIpcClient;
    let peerClient: DesktopPluginIpcClient;
    const createInbox = (getClient: () => DesktopPluginIpcClient | undefined) => {
      let handler!: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
      const messages: Array<{ content: string }> = [];
      const pi = {
        registerCommand: (name: string, command: { handler: typeof handler }) => {
          expect(name).toBe("mb-peer");
          handler = command.handler;
        },
        sendMessage: (message: { content: string }) => { messages.push(message); },
      };
      const command = registerDesktopPeerCommand(pi as unknown as ExtensionAPI, getClient);
      return {
        ...command,
        async read(): Promise<DesktopPeerDelivery[]> {
          await handler("inbox", {} as Parameters<typeof handler>[1]);
          return JSON.parse(messages.at(-1)!.content);
        },
      };
    };
    const sourceInbox = createInbox(() => sourceClient);
    const peerInbox = createInbox(() => peerClient);
    const connect = async () => {
      sourceClient = new DesktopPluginIpcClient({
        socketPath, secret: "secret", target: source, capabilities: [], features: [PEER_FEATURE],
        onRequest: async (request) => ({ type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "observed" }),
        onPeerDelivery: (delivery) => sourceInbox.receive(delivery),
      });
      peerClient = new DesktopPluginIpcClient({
        socketPath, secret: "secret", target: peer, capabilities: [], features: [PEER_FEATURE],
        onRequest: async (request) => ({ type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "observed" }),
        onPeerDelivery: (delivery) => peerInbox.receive(delivery),
      });
      await Promise.all([sourceClient.connect(), peerClient.connect()]);
      await waitFor(() => broker?.registry.resolve(source) !== undefined && broker?.registry.resolve(peer) !== undefined);
    };
    try {
      broker = new DesktopBroker({ pluginSocketPath: socketPath, secret: "secret", peerAccessPath: accessPath, brokerInstanceId: "broker-peer-access" });
      await broker.start();
      await connect();
      expect(await sourceClient.requestPeers({ type: "desktop_peer_list", requestId: "list-before", deadlineAt: Date.now() + 2_000 })).toMatchObject({ status: "listed", peers: [] });
      expect(await sourceClient.requestPeers({ type: "desktop_peer_candidates", requestId: "candidates", deadlineAt: Date.now() + 2_000 })).toMatchObject({ status: "candidates", candidates: [peer] });
      expect(await sourceClient.requestPeers({ type: "desktop_peer_send", requestId: "denied", deadlineAt: Date.now() + 2_000, target: peer, message: "not delivered" })).toMatchObject({ status: "failed", error: { code: "authorization_required" } });
      const grant = await sourceClient.requestPeers({ type: "desktop_peer_access_grant", requestId: "grant", deadlineAt: Date.now() + 2_000, target: peer, direction: "bidirectional" });
      expect(grant).toMatchObject({ status: "access_granted", grant: { managed: false, direction: "bidirectional" } });
      expect(await sourceInbox.read()).toEqual([]);
      expect(await peerInbox.read()).toEqual([]);
      const deliveryIds: string[] = [];
      for (const [sender, receiver, senderTarget, receiverTarget, requestId, message] of [
        [sourceClient, peerInbox, source, peer, "send-a-b-1", "A to B first"],
        [peerClient, sourceInbox, peer, source, "send-b-a", "B to A response"],
        [sourceClient, peerInbox, source, peer, "send-a-b-2", "A to B second"],
      ] as const) {
        const delivered = await sender.requestPeers({ type: "desktop_peer_send", requestId, deadlineAt: Date.now() + 2_000, target: receiverTarget, message });
        expect(delivered).toMatchObject({ status: "accepted", requestId, deliveryId: expect.any(String) });
        deliveryIds.push(delivered.deliveryId!);
        expect(await receiver.read()).toContainEqual(expect.objectContaining({ requestId, deliveryId: delivered.deliveryId, source: senderTarget, target: receiverTarget, message }));
      }
      expect(new Set(deliveryIds).size).toBe(3);
      expect((await sourceInbox.read()).map((delivery) => delivery.message)).toEqual(["B to A response"]);
      expect((await peerInbox.read()).map((delivery) => delivery.message)).toEqual(["A to B first", "A to B second"]);
      expect(JSON.parse(await readFile(accessPath, "utf8"))).toHaveLength(1);

      sourceClient.close(); peerClient.close();
      await broker.close();
      broker = new DesktopBroker({ pluginSocketPath: socketPath, secret: "secret", peerAccessPath: accessPath, brokerInstanceId: "broker-peer-access-restart" });
      await broker.start();
      await connect();
      expect(await sourceClient.requestPeers({ type: "desktop_peer_list", requestId: "list-restored", deadlineAt: Date.now() + 2_000 })).toMatchObject({ status: "listed", peers: [peer] });
      expect(await sourceClient.requestPeers({ type: "desktop_peer_access_list", requestId: "access", deadlineAt: Date.now() + 2_000 })).toMatchObject({ status: "access_listed", grants: [{ managed: false, direction: "bidirectional" }] });
      const restoredDelivery = await peerClient.requestPeers({ type: "desktop_peer_send", requestId: "send-restored", deadlineAt: Date.now() + 2_000, target: source, message: "after restart" });
      expect(restoredDelivery.status).toBe("accepted");
      expect(await sourceInbox.read()).toContainEqual(expect.objectContaining({ deliveryId: restoredDelivery.deliveryId, source: peer, target: source, message: "after restart" }));
      expect(await sourceClient.requestPeers({ type: "desktop_peer_access_revoke", requestId: "revoke", deadlineAt: Date.now() + 2_000, grantId: grant.grant!.grantId })).toMatchObject({ status: "access_revoked" });
      expect(await sourceClient.requestPeers({ type: "desktop_peer_list", requestId: "list-revoked", deadlineAt: Date.now() + 2_000 })).toMatchObject({ status: "listed", peers: [] });
      expect(await sourceClient.requestPeers({ type: "desktop_peer_send", requestId: "send-revoked", deadlineAt: Date.now() + 2_000, target: peer, message: "blocked" })).toMatchObject({ status: "failed", error: { code: "authorization_required" } });
      expect(await peerClient.requestPeers({ type: "desktop_peer_send", requestId: "reverse-revoked", deadlineAt: Date.now() + 2_000, target: source, message: "reverse blocked" })).toMatchObject({ status: "failed", error: { code: "authorization_required" } });
      expect((await sourceInbox.read()).map((delivery) => delivery.message)).toEqual(["B to A response", "after restart"]);
      expect((await peerInbox.read()).map((delivery) => delivery.message)).toEqual(["A to B first", "A to B second"]);
    } finally {
      sourceInbox.clear(); peerInbox.clear();
      sourceClient?.close(); peerClient?.close();
      await broker?.close(); broker = undefined;
      await rm(dir, { recursive: true, force: true });
    }
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
