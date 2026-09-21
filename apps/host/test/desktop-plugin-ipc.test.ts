import { describe, expect, it, afterEach } from "vitest";
import { createConnection } from "node:net";
import { mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DesktopAskResult, DesktopPluginResult, DesktopPluginTarget } from "@maestro-mobile/shared";
import { DesktopPluginIpcClient, DesktopPluginIpcServer } from "../src/plugin/desktop-plugin-ipc.js";
import { DesktopPluginRegistry } from "../src/plugin/desktop-plugin-registry.js";
import { DesktopControlGatewayService } from "../src/control/desktop-control-gateway.js";

const target: DesktopPluginTarget = {
  sessionId: "session-1",
  endpointId: "desktop-1",
  normalizedCwd: "/work/app",
  processGeneration: "generation-1",
};

function command(requestId = "request-1") {
  return { requestId, target, kind: "abort" as const };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not reached");
}

describe("DesktopPluginRegistry", () => {
  it("requires the complete target and capability", () => {
    const registry = new DesktopPluginRegistry();
    const transport = { request: async () => ({ requestId: "r", operation: "abort", status: "observed" as const }), close: () => {} };
    registry.register({ target, capabilities: ["abort"], transport });

    expect(registry.resolve(target)?.target).toEqual(target);
    expect(registry.resolve({ ...target, processGeneration: "stale" })).toBeUndefined();
    expect(registry.hasCapability(target, "abort")).toBe(true);
    expect(registry.hasCapability(target, "prompt")).toBe(false);
  });
});

describe("DesktopPlugin IPC and gateway", () => {
  let server: DesktopPluginIpcServer | undefined;
  let client: DesktopPluginIpcClient | undefined;

  afterEach(async () => {
    client?.close();
    await server?.close();
    client = undefined;
    server = undefined;
  });

  it("authenticates over a real UDS, uses 0600 framing, and executes idempotently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-plugin-"));
    const socketPath = join(dir, "plugin.sock");
    const registryPath = join(dir, "registry.json");
    const registry = new DesktopPluginRegistry();
    server = new DesktopPluginIpcServer({ socketPath, registryPath, registry, secret: "test-secret" });
    await server.start();
    const mode = (await stat(socketPath)).mode & 0o777;
    expect(mode).toBe(0o600);
    await server.registry.flush();
    expect((await stat(registryPath)).mode & 0o777).toBe(0o600);

    let executions = 0;
    client = new DesktopPluginIpcClient({
      socketPath,
      secret: "test-secret",
      target,
      capabilities: ["abort"],
      onRequest: async (request): Promise<DesktopPluginResult> => {
        executions += 1;
        return { type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "observed" };
      },
    });
    await client.connect();
    await waitFor(() => server?.registry.resolve(target) !== undefined);

    const gateway = new DesktopControlGatewayService(server.registry);
    const first = await gateway.execute(command());
    const second = await gateway.execute(command());
    expect(first.status).toBe("observed");
    expect(second).toEqual(first);
    expect(executions).toBe(1);
  });

  it("forwards readerless model and skill queries to the exact target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-plugin-query-"));
    server = new DesktopPluginIpcServer({ socketPath: join(dir, "plugin.sock"), secret: "test-secret" });
    await server.start();
    client = new DesktopPluginIpcClient({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      target,
      capabilities: ["list_models", "list_skills"],
      onRequest: async (request) => ({
        type: "desktop_plugin_result" as const,
        requestId: request.requestId,
        operation: request.operation.type,
        status: "observed" as const,
        result: request.operation.type === "list_models"
          ? [{ provider: "provider-a", id: "model-a", name: "Model A", reasoning: true, vision: false }]
          : [{ name: "review", description: "Review changes" }],
      }),
    });
    await client.connect();
    await waitFor(() => server?.registry.resolve(target) !== undefined);

    const gateway = new DesktopControlGatewayService(server.registry);
    await expect(gateway.query(target, "list_models")).resolves.toEqual([
      { provider: "provider-a", id: "model-a", name: "Model A", reasoning: true, vision: false },
    ]);
    await expect(gateway.query(target, "list_skills")).resolves.toEqual([
      { name: "review", description: "Review changes" },
    ]);
    await expect(gateway.query({ ...target, processGeneration: "stale" }, "list_models")).resolves.toEqual([]);
  });
  it("rejects bad secrets without taking down the server", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-plugin-auth-"));
    server = new DesktopPluginIpcServer({ socketPath: join(dir, "plugin.sock"), secret: "right-secret" });
    await server.start();
    client = new DesktopPluginIpcClient({
      socketPath: join(dir, "plugin.sock"),
      secret: "wrong-secret",
      target,
      capabilities: ["abort"],
      onRequest: async () => ({ type: "desktop_plugin_result", requestId: "r", operation: "abort", status: "observed" }),
    });
    await expect(client.connect()).rejects.toThrow();
    expect(server.registry.list()).toHaveLength(0);
  });

  it("forwards model/thinking operations and reports their state events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-plugin-model-"));
    let receivedEvent: unknown;
    let receivedThinkingLevel: string | undefined;
    let receivedRuntimeStatus: string | undefined;
    let receivedSummary: unknown;
    let receivedOperation: string | undefined;
    server = new DesktopPluginIpcServer({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      supportedEvents: ["model_select", "thinking_level_select", "runtime_status", "session_summary"],
      onModelSelect: (_target, event) => { receivedEvent = event; },
      onThinkingLevelSelect: (_target, event) => { receivedThinkingLevel = event.level; },
      onRuntimeStatus: (_target, event) => { receivedRuntimeStatus = event.runtimeStatus; },
      onSessionSummary: (_target, event) => { receivedSummary = event.summary; },
    });
    await server.start();
    client = new DesktopPluginIpcClient({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      target,
      capabilities: ["set_model", "set_thinking"],
      onRequest: async (request): Promise<DesktopPluginResult> => {
        receivedOperation = request.operation.type;
        return { type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "observed" };
      },
    });
    await client.connect();
    await waitFor(() => server?.registry.resolve(target) !== undefined);

    const gateway = new DesktopControlGatewayService(server.registry);
    await expect(gateway.execute({
      requestId: "set-model",
      target,
      kind: "set_model",
      provider: "provider-a",
      modelId: "shared-id",
    })).resolves.toMatchObject({ status: "observed" });
    expect(receivedOperation).toBe("set_model");

    const thinkingResult = await server.registry.resolve(target)!.transport.request({
      type: "desktop_plugin_request",
      requestId: "set-thinking",
      commandId: "set-thinking",
      deadlineAt: Date.now() + 1000,
      target,
      operation: { type: "set_thinking", level: "high" },
    });
    expect(thinkingResult).toMatchObject({ status: "observed" });
    expect(receivedOperation).toBe("set_thinking");

    await client.sendModelSelect({
      type: "desktop_plugin_event",
      event: "model_select",
      model: { provider: "provider-b", id: "shared-id", name: "Model B", reasoning: false, vision: true },
    });
    await waitFor(() => receivedEvent !== undefined);
    expect(receivedEvent).toMatchObject({ event: "model_select", model: { provider: "provider-b", id: "shared-id" } });

    await client.sendThinkingLevelSelect({ type: "desktop_plugin_event", event: "thinking_level_select", level: "xhigh" });
    await waitFor(() => receivedThinkingLevel === "xhigh");

    await client.sendRuntimeStatus({ type: "desktop_plugin_event", event: "runtime_status", runtimeStatus: "running" });
    await waitFor(() => receivedRuntimeStatus === "running");
    await client.sendSessionSummary({
      type: "desktop_plugin_event",
      event: "session_summary",
      summary: { runtimeStatus: "running", messageCount: 4, lastActivityAt: "2026-01-01T00:00:00.000Z" },
    });
    await waitFor(() => receivedSummary !== undefined);
    expect(receivedSummary).toMatchObject({ runtimeStatus: "running", messageCount: 4 });
  });

  it("keeps a v1 connection when the server does not advertise runtime events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-plugin-old-events-"));
    let receivedRuntimeStatus: string | undefined;
    server = new DesktopPluginIpcServer({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      onRuntimeStatus: (_target, event) => { receivedRuntimeStatus = event.runtimeStatus; },
    });
    await server.start();
    client = new DesktopPluginIpcClient({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      target,
      capabilities: ["abort"],
      onRequest: async (request) => ({ type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "observed" }),
    });
    await client.connect();
    await client.sendRuntimeStatus({ type: "desktop_plugin_event", event: "runtime_status", runtimeStatus: "running" });

    expect(receivedRuntimeStatus).toBeUndefined();
    const gateway = new DesktopControlGatewayService(server.registry);
    await expect(gateway.execute(command("still-connected"))).resolves.toMatchObject({ status: "observed" });
  });

  it("returns a structured capability mismatch for an older Plugin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-plugin-old-model-"));
    server = new DesktopPluginIpcServer({ socketPath: join(dir, "plugin.sock"), secret: "test-secret" });
    await server.start();
    client = new DesktopPluginIpcClient({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      target,
      capabilities: ["abort"],
      onRequest: async (request): Promise<DesktopPluginResult> => ({ type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "observed" }),
    });
    await client.connect();
    await waitFor(() => server?.registry.resolve(target) !== undefined);
    const gateway = new DesktopControlGatewayService(server.registry);
    await expect(gateway.execute({ requestId: "old-model", target, kind: "set_model", modelId: "model" })).resolves.toMatchObject({
      status: "failed",
      error: { code: "capability_mismatch" },
    });
  });

  it("rejects a mismatched Plugin release before registry registration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-plugin-release-"));
    server = new DesktopPluginIpcServer({ socketPath: join(dir, "plugin.sock"), secret: "test-secret", releaseVersion: "0.4.0" });
    await server.start();
    client = new DesktopPluginIpcClient({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      target,
      releaseVersion: "0.5.0",
      capabilities: ["abort"],
      onRequest: async () => ({ type: "desktop_plugin_result", requestId: "r", operation: "abort", status: "observed" }),
    });
    await expect(client.connect()).rejects.toThrow();
    expect(server.registry.list()).toHaveLength(0);
  });

  it("returns unknown on disconnect and rejects stale generation or capability", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-plugin-disconnect-"));
    server = new DesktopPluginIpcServer({ socketPath: join(dir, "plugin.sock"), secret: "test-secret" });
    await server.start();
    client = new DesktopPluginIpcClient({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      target,
      capabilities: ["abort"],
      onRequest: async () => ({ type: "desktop_plugin_result", requestId: "r", operation: "abort", status: "observed" }),
    });
    await client.connect();
    await waitFor(() => server?.registry.resolve(target) !== undefined);
    const gateway = new DesktopControlGatewayService(server.registry);
    expect((await gateway.execute({ ...command("stale"), target: { ...target, processGeneration: "stale" } })).error?.code).toBe("target_unavailable");
    expect((await gateway.execute({ requestId: "prompt", target, kind: "prompt", message: "x" })).error?.code).toBe("capability_mismatch");
    client.close();
    await waitFor(() => server?.registry.resolve(target) === undefined);
    expect((await gateway.execute(command("after-disconnect"))).status).toBe("unknown");
  });

  it("turns an expired plugin request into unknown without replay", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-plugin-deadline-"));
    server = new DesktopPluginIpcServer({ socketPath: join(dir, "plugin.sock"), secret: "test-secret" });
    await server.start();
    client = new DesktopPluginIpcClient({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      target,
      capabilities: ["abort"],
      onRequest: async (request): Promise<DesktopPluginResult> => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "observed" };
      },
    });
    await client.connect();
    await waitFor(() => server?.registry.resolve(target) !== undefined);
    const gateway = new DesktopControlGatewayService(server.registry, 5);
    const response = await gateway.execute(command("deadline"));
    expect(response.status).toBe("unknown");
    expect(response.error?.code).toBe("deadline_exceeded");
  });
  it("routes an exact ask response back to the connected Plugin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-plugin-ask-"));
    let received: { toolCallId: string; selected?: string[] } | undefined;
    let resolveAnswer: ((value: { toolCallId: string; selected?: string[] }) => void) | undefined;
    const answer = new Promise<{ toolCallId: string; selected?: string[] }>((resolve) => { resolveAnswer = resolve; });
    server = new DesktopPluginIpcServer({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      onAskRequest: (connectedTarget, request) => {
        const registration = server?.registry.resolve(connectedTarget);
        registration?.transport.answerAsk?.({ type: "desktop_ask_response", requestId: request.requestId, toolCallId: request.toolCallId, response: { selected: ["yes"] } });
      },
    });
    await server.start();
    client = new DesktopPluginIpcClient({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      target,
      capabilities: ["ask-user-question"],
      onRequest: async (request) => ({ type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "observed" }),
      onAskResponse: async (response) => {
        received = { toolCallId: response.toolCallId, selected: response.response.selected };
        resolveAnswer?.(received);
      },
    });
    await client.connect();
    await client.sendAskRequest({ type: "desktop_ask_request", requestId: "question:call_a|fc_b", toolCallId: "call_a|fc_b", questions: [{ question: "Continue?" }], deadlineAt: Date.now() + 1000 });
    await expect(answer).resolves.toEqual({ toolCallId: "call_a|fc_b", selected: ["yes"] });
  });
  it("turns a rejected async ask answer into a correlated failed receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-plugin-ask-rejected-"));
    let receipt: Promise<DesktopAskResult> | undefined;
    server = new DesktopPluginIpcServer({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      onAskRequest: (connectedTarget, request) => {
        receipt = server?.registry.resolve(connectedTarget)?.transport.answerAsk?.({
          type: "desktop_ask_response",
          requestId: request.requestId,
          toolCallId: request.toolCallId,
          response: { selected: ["yes"] },
        }) as Promise<DesktopAskResult>;
      },
    });
    await server.start();
    client = new DesktopPluginIpcClient({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      target,
      capabilities: ["ask-user-question"],
      onRequest: async (request) => ({ type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "observed" }),
      onAskResponse: async () => { throw new Error("ask expired in Plugin"); },
    });
    await client.connect();
    await client.sendAskRequest({ type: "desktop_ask_request", requestId: "question:call-rejected", toolCallId: "call-rejected", questions: [{ question: "Continue?" }], deadlineAt: Date.now() + 1000 });
    await waitFor(() => receipt !== undefined);
    await expect(receipt).resolves.toMatchObject({ requestId: "question:call-rejected", toolCallId: "call-rejected", status: "failed", error: { code: "plugin_ask_rejected" } });
  });

  it("retries a rejected ask receipt without replaying an accepted answer", async () => {
    const registry = new DesktopPluginRegistry();
    let attempts = 0;
    registry.register({
      target,
      capabilities: ["ask-user-question"],
      transport: {
        close: () => undefined,
        request: async (request) => ({ type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "accepted" }),
        answerAsk: async (response) => ({
          type: "desktop_ask_result",
          requestId: response.requestId,
          toolCallId: response.toolCallId,
          status: ++attempts === 1 ? "failed" : "accepted",
          ...(attempts === 1 ? { error: { code: "response_write_failed" } } : {}),
        }),
      },
    });
    const gateway = new DesktopControlGatewayService(registry);
    const answer = () => gateway.answerAsk(target, "ask-retry", "tool-retry", { selected: ["yes"] });

    await expect(answer()).resolves.toMatchObject({ status: "failed", error: { code: "response_write_failed" } });
    await expect(answer()).resolves.toMatchObject({ status: "accepted" });
    await expect(answer()).resolves.toMatchObject({ status: "accepted" });
    expect(attempts).toBe(2);
  });

  it("isolates an oversized frame", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-plugin-frame-"));
    server = new DesktopPluginIpcServer({ socketPath: join(dir, "plugin.sock"), secret: "test-secret", maxFrameBytes: 128 });
    await server.start();
    await new Promise<void>((resolve) => {
      const socket = createConnection(join(dir, "plugin.sock"));
      socket.once("close", () => resolve());
      socket.write(`${"x".repeat(256)}\n`);
    });
    expect(server.registry.list()).toHaveLength(0);
  });
});
