import { describe, expect, it, afterEach } from "vitest";
import { createConnection } from "node:net";
import { mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DesktopPluginResult, DesktopPluginTarget } from "@maestro-mobile/shared";
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

  it("forwards set_model through the gateway and reports model_select events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-plugin-model-"));
    let receivedEvent: unknown;
    let receivedOperation: string | undefined;
    server = new DesktopPluginIpcServer({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      onModelSelect: (_target, event) => { receivedEvent = event; },
    });
    await server.start();
    client = new DesktopPluginIpcClient({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      target,
      capabilities: ["set_model"],
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

    await client.sendModelSelect({
      type: "desktop_plugin_event",
      event: "model_select",
      model: { provider: "provider-b", id: "shared-id", name: "Model B", reasoning: false, vision: true },
    });
    await waitFor(() => receivedEvent !== undefined);
    expect(receivedEvent).toMatchObject({ event: "model_select", model: { provider: "provider-b", id: "shared-id" } });
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
    await client.sendAskRequest({ type: "desktop_ask_request", requestId: "question:call-1", toolCallId: "call-1", questions: [{ question: "Continue?" }], deadlineAt: Date.now() + 1000 });
    await expect(answer).resolves.toEqual({ toolCallId: "call-1", selected: ["yes"] });
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
