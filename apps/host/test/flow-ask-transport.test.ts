import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DesktopAskRequest, DesktopPluginTarget } from "@maestro-mobile/shared";
import { DesktopPluginIpcServer } from "../src/plugin/desktop-plugin-ipc.js";
import { createDesktopPluginExtension } from "../src/plugin/desktop-plugin-extension.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

type FlowTransport = {
  open(request: {
    toolCallId: string;
    questions: readonly { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[];
    cwd: string;
    mode: string;
    signal: AbortSignal;
  }): { promise: Promise<{ status: "answered"; answers: unknown[] } | { status: "cancelled" }>; cancel(reason: string): void } | undefined;
};

function flowTransports(): FlowTransport[] {
  const registry = (globalThis as typeof globalThis & { [key: symbol]: { transports?: FlowTransport[] } | undefined })[
    Symbol.for("pi-maestro-flow.ask-transports")
  ];
  return registry?.transports ?? [];
}

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  let sessionId = "transport-session";
  const ctx = {
    cwd: "/work/app",
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/sessions/${sessionId}.jsonl`,
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
    getAllTools: () => [{ name: "ask-user-question" }],
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
    async emitAsync(event: string, payload: unknown) {
      await Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload, ctx)));
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

describe("Desktop plugin Flow Ask transport", () => {
  let server: DesktopPluginIpcServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("sends an exact Desktop Ask request and resolves the full Mobile answer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-flow-transport-"));
    let askRequest: DesktopAskRequest | undefined;
    server = new DesktopPluginIpcServer({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      onAskRequest: (_target, request) => { askRequest = request; },
    });
    await server.start();

    const fake = fakePi();
    createDesktopPluginExtension({ socketPath: join(dir, "plugin.sock"), secret: "test-secret" })(fake.pi as never);
    fake.emit("session_start", { type: "session_start", reason: "startup" });
    await waitFor(() => server!.registry.list().length === 1);

    const transport = flowTransports().at(-1)!;
    const handle = transport.open({
      toolCallId: "raw-call|fc-123",
      questions: [
        { question: "Pick one", header: "Choice", options: [{ label: "A" }, { label: "B" }] },
        { question: "Why?" },
      ],
      cwd: "/work/app",
      mode: "tui",
      signal: new AbortController().signal,
    });
    expect(handle).toBeDefined();
    await waitFor(() => askRequest !== undefined);
    expect(askRequest).toMatchObject({
      requestId: "question:raw-call|fc-123",
      toolCallId: "raw-call|fc-123",
      questions: [
        { question: "Pick one", header: "Choice", options: [{ label: "A" }, { label: "B" }] },
        { question: "Why?" },
      ],
    });
    expect(fake.handlers.has("tool_call")).toBe(false);

    const target = server.registry.list()[0].target as DesktopPluginTarget;
    const response = {
      type: "desktop_ask_response" as const,
      requestId: askRequest!.requestId,
      toolCallId: askRequest!.toolCallId,
      response: {
        id: "desktop-response",
        value: JSON.stringify({
          answers: [
            { question: "Pick one", header: "Choice", selected: ["B"] },
            { question: "Why?", selected: [], text: "because" },
          ],
          summary: "ignored by Flow",
        }),
      },
    };
    await expect(server.registry.resolve(target)!.transport.answerAsk!(response)).resolves.toMatchObject({ status: "accepted" });
    await expect(handle!.promise).resolves.toEqual({
      status: "answered",
      answers: [
        { question: "Pick one", header: "Choice", selected: ["B"] },
        { question: "Why?", selected: [], text: "because" },
      ],
    });

    await fake.emitAsync("session_shutdown", { type: "session_shutdown" });
  });

  it("cancels a remote handle and ignores a late Mobile response", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-flow-transport-cancel-"));
    let askRequest: DesktopAskRequest | undefined;
    server = new DesktopPluginIpcServer({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      onAskRequest: (_target, request) => { askRequest = request; },
    });
    await server.start();

    const fake = fakePi();
    createDesktopPluginExtension({ socketPath: join(dir, "plugin.sock"), secret: "test-secret" })(fake.pi as never);
    fake.emit("session_start", { type: "session_start", reason: "startup" });
    await waitFor(() => server!.registry.list().length === 1);

    const handle = flowTransports().at(-1)!.open({
      toolCallId: "cancel-call",
      questions: [{ question: "Cancel?" }],
      cwd: "/work/app",
      mode: "tui",
      signal: new AbortController().signal,
    });
    await waitFor(() => askRequest !== undefined);
    handle!.cancel("tui_answered");
    await expect(handle!.promise).resolves.toEqual({ status: "cancelled" });

    const target = server.registry.list()[0].target as DesktopPluginTarget;
    await expect(server.registry.resolve(target)!.transport.answerAsk!({
      type: "desktop_ask_response",
      requestId: askRequest!.requestId,
      toolCallId: askRequest!.toolCallId,
      response: { id: "late", value: JSON.stringify({ answers: [{ question: "Cancel?", selected: ["late"] }] }) },
    })).resolves.toMatchObject({ status: "accepted" });
    await fake.emitAsync("session_shutdown", { type: "session_shutdown" });
  });
});
