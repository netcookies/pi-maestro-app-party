import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DesktopPlanRequest, DesktopPlanResponse, DesktopPluginTarget } from "@maestro-mobile/shared";
import { DesktopPluginIpcServer } from "../src/plugin/desktop-plugin-ipc.js";
import { createDesktopPluginExtension } from "../src/plugin/desktop-plugin-extension.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

type FlowPlanTransport = {
  open(request: {
    kind: "confirm" | "review";
    sessionId: string;
    operationId: number;
    cwd: string;
    mode: string;
    markdown: string;
    revision: number;
    pathLabel: string;
    availableActions: string[];
    decisionDocuments: string[];
    drafts: { revision: number; archivedAt: string; checksum: string }[];
    signal: AbortSignal;
  }): { promise: Promise<unknown>; cancel(reason: string): void | Promise<void> } | undefined;
};

function planTransports(): FlowPlanTransport[] {
  const registry = (globalThis as typeof globalThis & { [key: symbol]: { transports?: FlowPlanTransport[] } | undefined })[
    Symbol.for("pi-maestro-flow.plan-transports")
  ];
  return registry?.transports ?? [];
}

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const ctx = {
    cwd: "/work/app",
    sessionManager: {
      getSessionId: () => "plan-session",
      getSessionFile: () => "/sessions/plan-session.jsonl",
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
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getAllTools: () => [],
    getCommands: () => [],
    sendUserMessage: () => {},
    setModel: async () => true,
    getThinkingLevel: () => "medium",
    setThinkingLevel: () => {},
  };
  return {
    pi,
    ctx,
    handlers,
    emit(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached");
}

function request(signal: AbortSignal): Parameters<FlowPlanTransport["open"]>[0] {
  return {
    kind: "confirm",
    sessionId: "plan-session",
    operationId: 11,
    cwd: "/work/app",
    mode: "plan",
    markdown: "# Plan",
    revision: 4,
    pathLabel: "plans/current.md",
    availableActions: ["execute", "modify", "discuss"],
    decisionDocuments: ["docs/decision.md"],
    drafts: [],
    signal,
  };
}

describe("Desktop plugin Flow Plan transport", () => {
  let server: DesktopPluginIpcServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("registers plan capability, forwards the exact request, and resolves decision", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-flow-plan-extension-"));
    let planRequest: DesktopPlanRequest | undefined;
    server = new DesktopPluginIpcServer({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      onPlanRequest: (_target, next) => { planRequest = next; },
    });
    await server.start();

    const fake = fakePi();
    createDesktopPluginExtension({ socketPath: join(dir, "plugin.sock"), secret: "test-secret" })(fake.pi as never);
    fake.emit("session_start", { type: "session_start" });
    await waitFor(() => server!.registry.list().length === 1);
    expect(server.registry.list()[0].capabilities).toContain("plan");

    const handle = planTransports().at(-1)!.open(request(new AbortController().signal));
    expect(handle).toBeDefined();
    await waitFor(() => planRequest !== undefined);
    expect(planRequest).toMatchObject({
      type: "desktop_plan_request",
      requestId: "plan:plan-session:11",
      sessionId: "plan-session",
      operationId: 11,
      cwd: "/work/app",
      revision: 4,
    });

    const target = server.registry.list()[0].target as DesktopPluginTarget;
    const response: DesktopPlanResponse = {
      type: "desktop_plan_response",
      requestId: planRequest!.requestId,
      kind: planRequest!.kind,
      status: "decision",
      decision: { action: "execute", execution: { backend: "standalone", context: "current" } },
    };
    await expect(server.registry.resolve(target)!.transport.answerPlan!(response)).resolves.toMatchObject({ status: "accepted" });
    await expect(handle!.promise).resolves.toMatchObject({ status: "decision", decision: response.decision });
    fake.emit("session_shutdown", { type: "session_shutdown" });
  });

  it("rejects a late Plan response after local cancellation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-flow-plan-late-"));
    let planRequest: DesktopPlanRequest | undefined;
    server = new DesktopPluginIpcServer({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      onPlanRequest: (_target, next) => { planRequest = next; },
    });
    await server.start();

    const fake = fakePi();
    createDesktopPluginExtension({ socketPath: join(dir, "plugin.sock"), secret: "test-secret" })(fake.pi as never);
    fake.emit("session_start", { type: "session_start" });
    await waitFor(() => server!.registry.list().length === 1);
    const handle = planTransports().at(-1)!.open(request(new AbortController().signal));
    await waitFor(() => planRequest !== undefined);
    await handle!.cancel("tui_answered");
    await expect(handle!.promise).resolves.toEqual({ status: "cancelled" });

    const target = server.registry.list()[0].target as DesktopPluginTarget;
    await expect(server.registry.resolve(target)!.transport.answerPlan!({
      type: "desktop_plan_response",
      requestId: planRequest!.requestId,
      kind: planRequest!.kind,
      status: "decision",
      decision: { action: "execute" },
    })).resolves.toMatchObject({ status: "failed", error: { code: "plugin_plan_rejected" } });
    fake.emit("session_shutdown", { type: "session_shutdown" });
  });
});
