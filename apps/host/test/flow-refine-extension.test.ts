import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DesktopPlanRefineAction, DesktopPluginTarget } from "@maestro-mobile/shared";
import { DESKTOP_PLAN_REFINE_FEATURE } from "@maestro-mobile/shared";
import { DesktopPluginIpcServer } from "../src/plugin/desktop-plugin-ipc.js";
import { createDesktopPluginExtension } from "../src/plugin/desktop-plugin-extension.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

type FlowRefineTransport = {
  open(request: {
    sessionId: string;
    refineSessionId: string;
    operationId: number;
    target: { sessionId: string; endpointId?: string; normalizedCwd: string; processGeneration?: number };
    cwd: string;
    mode: string;
    markdown: string;
    revision: number;
    initialRole: string;
    signal: AbortSignal;
    handleAction: (action: unknown) => Promise<void>;
  }): { promise: Promise<unknown>; emit: (event: unknown) => void; cancel(reason: string): void | Promise<void> } | undefined;
};

function refineTransports(): FlowRefineTransport[] {
  const registry = (globalThis as typeof globalThis & { [key: symbol]: { transports?: FlowRefineTransport[] } | undefined })[
    Symbol.for("pi-maestro-flow.refine-transports")
  ];
  return registry?.transports ?? [];
}

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const registeredCommands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
  const ctx = {
    cwd: "/work/app",
    sessionManager: {
      getSessionId: () => "refine-session",
      getSessionFile: () => "/sessions/refine-session.jsonl",
    },
    model: { provider: "provider-a", id: "model-a", name: "Model A", reasoning: false, input: ["text"] },
    modelRegistry: {
      find: () => undefined,
      getAll: () => [],
      getAvailable: () => [],
      hasConfiguredAuth: () => true,
    },
    isIdle: () => true,
    abort: () => {},
  };
  const pi = {
    getThinkingLevel: () => "medium",
    setThinkingLevel: () => {},
    sendUserMessage: () => {},
    setModel: async () => true,
    getAllTools: () => [],
    getCommands: () => [],
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => unknown }) => registeredCommands.set(name, command),
    registerMessageRenderer: () => undefined,
    registerTool: () => undefined,
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    emit(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
    },
  };
  return { pi, ctx };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached");
}

describe("flow refine transport integration with desktop plugin extension", () => {
  let server: DesktopPluginIpcServer | undefined;
  let extensionStop: (() => void) | undefined;

  afterEach(async () => {
    extensionStop?.();
    extensionStop = undefined;
    await server?.close();
    server = undefined;
  });

  it("registers flow refine transport, negotiates feature over UDS, and relays frames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flow-refine-test-"));
    const socketPath = join(dir, "desktop-plugin.sock");
    const secret = "test-secret";
    const serverRefineActions: DesktopPlanRefineAction[] = [];

    server = new DesktopPluginIpcServer({
      socketPath,
      secret,
      onPlanRefine: (_target, action) => { serverRefineActions.push(action); },
    });
    await server.start();

    const fake = fakePi();
    createDesktopPluginExtension({
      socketPath,
      secret,
      endpointId: "endpoint-1",
      processGeneration: "gen-1",
    })(fake.pi as never);

    fake.pi.emit("session_start", { type: "session_start" });
    await waitFor(() => server!.registry.list().length === 1);

    const transports = refineTransports();
    expect(transports.length).toBeGreaterThan(0);

    const flowTransport = transports.at(-1)!;
    let actionReceived: unknown;
    const handle = flowTransport.open({
      sessionId: "refine-session",
      refineSessionId: "ref-1",
      operationId: 1,
      target: { sessionId: "refine-session", normalizedCwd: "/work/app" },
      cwd: "/work/app",
      mode: "plan",
      markdown: "# P",
      revision: 1,
      initialRole: "reviewer",
      signal: new AbortController().signal,
      handleAction: async (action) => { actionReceived = action; },
    });

    expect(handle).toBeDefined();

    // Server sends an action frame into the client over UDS
    const actionFrame: DesktopPlanRefineAction = {
      type: "desktop_plan_refine_action",
      target: {
        sessionId: "refine-session",
        endpointId: "endpoint-1",
        normalizedCwd: "/work/app",
        processGeneration: "gen-1",
      },
      refineSessionId: "ref-1",
      planRequestId: "ref-1",
      operationId: 1,
      revision: 1,
      actionId: "a-1",
      action: { action: "run", userInput: "tighten" },
    };

    // Server relays action through answerRefine over the real UDS connection
    const target = server.registry.list()[0].target as DesktopPluginTarget;
    const ipcTransport = server.registry.resolve(target)!.transport;
    const selected = await ipcTransport.answerRefine!({
      ...actionFrame,
      actionId: "a-model",
      action: { action: "select_model", model: "provider/test" },
    });
    expect(selected).toBe(true);
    const handled = await ipcTransport.answerRefine!(actionFrame);
    expect(handled).toBe(true);

    await waitFor(() => actionReceived !== undefined);
    expect(actionReceived).toMatchObject({
      type: "run",
      actionId: "a-1",
      userInput: "tighten",
    });

    handle?.cancel("cancelled");
    fake.pi.emit("session_shutdown", { type: "session_shutdown" });
  });
});
