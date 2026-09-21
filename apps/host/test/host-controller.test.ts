import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { HostController } from "../src/host-controller.js";
import { MaestroStateReader } from "../src/maestro-state.js";
import type { DesktopPluginTransport } from "../src/plugin/desktop-plugin-registry.js";
import { mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

function makeRuntime(sessionId = "desktop-session", cwd = "/work/app", sessionFile?: string) {
  const subscribers = new Set<(event: unknown) => void>();
  const session = {
    sessionId,
    sessionName: "desktop",
    cwd,
    messages: [] as unknown[],
    pendingMessageCount: 0,
    isStreaming: false,
    isCompacting: false,
    model: undefined,
    thinkingLevel: undefined,
    ...(sessionFile ? { sessionFile } : {}),
    prompt: async () => undefined,
    steer: async () => undefined,
    followUp: async () => undefined,
    abort: async () => undefined,
    subscribe: (listener: (event: unknown) => void) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    bindExtensions: async () => undefined,
  };
  return {
    session,
    cwd,
    dispose: vi.fn(async () => undefined),
    emit(event: unknown) {
      for (const listener of subscribers) listener(event);
    },
  };
}

describe("HostController", () => {
  let tmpDir: string;
  let controller: HostController;
  let reader: MaestroStateReader;
  let events: unknown[];

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `maestro-host-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    events = [];
    reader = new MaestroStateReader({ projectRoot: tmpDir });
    controller = new HostController(
      {
        createRuntime: async () => {
          throw new Error("Not implemented in test");
        },
        listSessions: async () => [],
      },
      reader,
    );
    controller.onEvent((event) => { events.push(event); });
  });

  afterEach(async () => {
    await controller.dispose();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns initial status", () => {
    const status = controller.getStatus();
    expect(status.ok).toBe(true);
    expect(status.version).toBe("0.4.0");
    expect(status.sessions).toBe(0);
    expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("starts and stops maestro poll", async () => {
    // 创建 flow-schedule 目录并写入一个调度，验证 poll 能读取
    const scheduleDir = join(tmpDir, ".pi", "flow-schedule", "v1", "schedules");
    await mkdir(scheduleDir, { recursive: true });
    await writeFile(
      join(scheduleDir, "sch-001.json"),
      JSON.stringify({
        scheduleId: "sch-001",
        state: "active",
        stepIds: [],
        steps: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await controller.startMaestroPoll(100);
    // 等待 poll 触发
    await new Promise((r) => setTimeout(r, 200));
    const maestroEvents = events.filter((e: unknown) => {
      const ev = e as { type?: string };
      return ev.type === "maestro_state";
    });
    expect(maestroEvents.length).toBeGreaterThanOrEqual(1);
    controller.stopMaestroPoll();
  });

  it("openSession returns error when runtime unavailable", async () => {
    await expect(controller.openSession({ cwd: tmpDir, mode: "create" })).rejects.toThrow();
  });

  it("keeps an existing exact Desktop target for snapshot and control", async () => {
    const sessionFile = join(tmpDir, "desktop-session.jsonl");
    await writeFile(sessionFile, "");
    const runtime = makeRuntime("desktop-session", "/work/app", sessionFile);
    const desktopController = new HostController({
      createRuntime: async () => runtime,
      listSessions: async () => [],
    }, reader);
    const target = {
      sessionId: "desktop-session",
      endpointId: "desktop-endpoint",
      normalizedCwd: "/work/app",
      processGeneration: "desktop-generation-1",
    };
    const request = vi.fn<DesktopPluginTransport["request"]>(async (command) => ({
      type: "desktop_plugin_result",
      requestId: command.requestId,
      operation: command.operation.type,
      status: "observed",
    }));
    const transport: DesktopPluginTransport = { request, close: vi.fn() };
    desktopController.desktopPlugins.register({
      target,
      sessionFile,
      capabilities: ["prompt", "steer", "follow_up", "abort", "set_thinking", "ask-user-question"],
      transport,
    });
    desktopController.registerDesktopTarget(target);

    try {
      await desktopController.openSession({ cwd: "/work/app", mode: "create", target });

      expect(desktopController.getSessionTarget(target.sessionId)).toEqual(target);
      await expect(desktopController.application.query({ kind: "session_snapshot", target })).resolves.toMatchObject({
        ok: true,
        value: { session: { presentation: { control: { mode: "desktop_plugin", canPrompt: true } } } },
      });
      await expect(desktopController.application.command({ requestId: "abort-1", target, kind: "abort" })).resolves.toMatchObject({
        status: "observed",
      });
      await expect(desktopController.application.command({ requestId: "thinking-1", target, kind: "set_thinking", level: "high" })).resolves.toMatchObject({
        status: "observed",
      });
      expect(request).toHaveBeenCalledWith(expect.objectContaining({ operation: { type: "set_thinking", level: "high" } }));
      expect(request).toHaveBeenCalledTimes(2);

      expect(await desktopController.closeSession(target.sessionId)).toBe(true);
      expect(desktopController.directory.resolve(target)?.kind).toBe("desktop");
      expect(desktopController.directory.resolve(target)?.runner).toBeUndefined();
    } finally {
      await desktopController.dispose();
    }
  });

  it("routes a readerless Desktop ask only to its exact endpoint and clears it after answering", async () => {
    const target = { sessionId: "desktop-ask", endpointId: "first", normalizedCwd: "/work/app", processGeneration: "g1" };
    const sibling = { ...target, endpointId: "second", processGeneration: "g2" };
    const answerAsk = vi.fn(async () => ({ type: "desktop_ask_result" as const, requestId: "ask-1", toolCallId: "tool-1", status: "accepted" as const }));
    const transport: DesktopPluginTransport = { close: vi.fn(), request: async (request) => ({ type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "accepted" }), answerAsk };
    controller.desktopPlugins.register({ target, capabilities: ["ask-user-question"], transport });
    controller.desktopPlugins.register({ target: sibling, capabilities: ["ask-user-question"], transport });
    controller.registerDesktopTarget(target);
    controller.registerDesktopTarget(sibling);
    const request = { type: "desktop_ask_request" as const, requestId: "ask-1", toolCallId: "tool-1", questions: [{ question: "Continue?" }], deadlineAt: Date.now() + 10_000 };
    controller.onDesktopAskRequest(target, request);
    const event = events.find((entry) => (entry as { type?: string }).type === "extension_ui_request") as { target: typeof target; request: { id: string; questions: unknown[] } };
    expect(event).toMatchObject({ target, request: { questions: request.questions } });
    expect(await controller.respondToExtensionUi(target.sessionId, event.request.id, { id: event.request.id, selected: ["yes"] }, sibling)).toBe(false);
    expect(answerAsk).not.toHaveBeenCalled();
    expect(await controller.respondToExtensionUi(target.sessionId, event.request.id, { id: event.request.id, selected: ["yes"] }, target)).toBe(true);
    expect(answerAsk).toHaveBeenCalledWith(expect.objectContaining({ requestId: "ask-1", toolCallId: "tool-1" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "extension_ui_cleared", target, requestId: event.request.id }));
    expect(await controller.respondToExtensionUi(target.sessionId, event.request.id, { id: event.request.id, selected: ["yes"] }, target)).toBe(false);
  });

  it("keeps the Mobile ask pending when Plugin rejects the answer receipt", async () => {
    const target = { sessionId: "desktop-ask-rejected", endpointId: "first", normalizedCwd: "/work/app", processGeneration: "g1" };
    const transport: DesktopPluginTransport = {
      close: vi.fn(),
      request: async (request) => ({ type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "accepted" }),
      answerAsk: async (response) => ({ type: "desktop_ask_result", requestId: response.requestId, toolCallId: response.toolCallId, status: "failed", error: { code: "deadline_exceeded" } }),
    };
    controller.desktopPlugins.register({ target, capabilities: ["ask-user-question"], transport });
    controller.registerDesktopTarget(target);
    controller.onDesktopAskRequest(target, { type: "desktop_ask_request", requestId: "ask-rejected", toolCallId: "tool-rejected", questions: [{ question: "Continue?" }], deadlineAt: Date.now() + 10_000 });
    const event = events.find((entry) => (entry as { type?: string }).type === "extension_ui_request") as { request: { id: string } };
    expect(await controller.respondToExtensionUi(target.sessionId, event.request.id, { id: event.request.id, selected: ["yes"] }, target)).toBe(false);
    expect(events.filter((entry) => (entry as { type?: string }).type === "extension_ui_cleared")).toHaveLength(0);
  });

  it("keeps a new exact Desktop target readerless until its JSONL file exists", async () => {
    const sessionFile = join(tmpDir, "desktop-session-not-created.jsonl");
    const createRuntime = vi.fn(async () => { throw new Error("reader must not open a missing file"); });
    const desktopController = new HostController({
      createRuntime,
      listSessions: async () => [],
    }, reader);
    const target = {
      sessionId: "desktop-session-new",
      endpointId: "desktop-endpoint-new",
      normalizedCwd: "/work/app",
      processGeneration: "desktop-generation-new",
    };
    const request = vi.fn<DesktopPluginTransport["request"]>(async (command) => ({
      type: "desktop_plugin_result",
      requestId: command.requestId,
      operation: command.operation.type,
      status: "observed",
    }));
    try {
      desktopController.desktopPlugins.register({ target, sessionFile, capabilities: ["abort"], transport: { request, close: vi.fn() } });
      desktopController.registerDesktopTarget(target);
      await expect(desktopController.openSession({ cwd: "/work/app", mode: "create", target })).resolves.toEqual({ id: target.sessionId });
      expect(createRuntime).not.toHaveBeenCalled();
      expect(desktopController.directory.resolve(target)?.runner).toBeUndefined();
      await expect(desktopController.application.command({ requestId: "abort-new", target, kind: "abort" })).resolves.toMatchObject({ status: "observed" });
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      await desktopController.dispose();
    }
  });

  it("publishes readerless thinking changes, clears stale values, and refreshes capabilities", async () => {
    const target = { sessionId: "readerless", endpointId: "desktop", normalizedCwd: "/work/app", processGeneration: "g1" };
    const transport: DesktopPluginTransport = { request: vi.fn(), close: vi.fn() };
    const record = { target, capabilities: ["abort"] as const, runtimeStatus: "idle" as const };
    controller.desktopPlugins.register({ ...record, transport });
    controller.applyDesktopProjection([record]);

    const changed = { ...record, capabilities: ["abort", "set_thinking"] as const, thinkingLevel: "high" };
    controller.desktopPlugins.register({ ...changed, transport });
    controller.applyDesktopProjection([changed]);
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "session_updated", target, session: expect.objectContaining({ thinkingLevel: "high" }),
    })));
    expect(controller.directory.resolve(target)?.capabilities).toContain("set_thinking");
    const eventCount = events.filter((event) => (event as { type?: string }).type === "session_updated").length;
    controller.applyDesktopProjection([changed]);
    await Promise.resolve();
    expect(events.filter((event) => (event as { type?: string }).type === "session_updated")).toHaveLength(eventCount);

    controller.desktopPlugins.register({ ...record, transport });
    controller.applyDesktopProjection([record]);
    await vi.waitFor(() => expect(controller.directory.resolve(target)?.thinkingLevel).toBeUndefined());
    expect(controller.directory.resolve(target)?.capabilities).not.toContain("set_thinking");
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "session_updated", target, session: expect.not.objectContaining({ thinkingLevel: "high" }),
    })));
  });

  it("streams appended readerless Desktop JSONL items to the exact open target", async () => {
    const sessionFile = join(tmpDir, "desktop-session-live.jsonl");
    await writeFile(sessionFile, JSON.stringify({ type: "message", message: { role: "user", content: "before", timestamp: 1756800000000 } }) + "\n");
    const target = { sessionId: "desktop-live", endpointId: "desktop-endpoint", normalizedCwd: "/work/app", processGeneration: "live-generation" };
    const sibling = { ...target, endpointId: "other-endpoint", processGeneration: "other-generation" };
    const transport: DesktopPluginTransport = { request: vi.fn(), close: vi.fn() };
    const registration = { target, sessionFile, capabilities: ["prompt"] as const, runtimeStatus: "idle" as const, transport };
    const siblingRegistration = { target: sibling, sessionFile, capabilities: ["prompt"] as const, runtimeStatus: "idle" as const, transport };

    controller.desktopPlugins.register(registration);
    controller.desktopPlugins.register(siblingRegistration);
    controller.applyDesktopProjection([registration, siblingRegistration]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    events = [];

    await appendFile(sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: "live", timestamp: 1756800100000 } }) + "\n");
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "timeline_item",
      sessionId: target.sessionId,
      target,
      item: expect.objectContaining({ text: "live" }),
    })), { timeout: 1_500, interval: 50 });
    expect(events.filter((event) => (event as { type?: string; target?: unknown }).type === "timeline_item" && (event as { target?: unknown }).target === target)).toHaveLength(1);
    expect(events.filter((event) => (event as { type?: string; target?: unknown }).type === "timeline_item" && (event as { target?: unknown }).target === sibling)).toHaveLength(1);
  });

  it("replaces readerless timeline after compact without emitting replay items", async () => {
    const sessionFile = join(tmpDir, "desktop-session-compact.jsonl");
    await writeFile(sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: "old history ".repeat(100) } }) + "\n");
    const target = { sessionId: "desktop-compact", endpointId: "desktop-endpoint", normalizedCwd: "/work/app", processGeneration: "compact-generation" };
    const transport: DesktopPluginTransport = { request: vi.fn(), close: vi.fn() };
    const registration = { target, sessionFile, capabilities: ["prompt"] as const, runtimeStatus: "idle" as const, transport };
    controller.desktopPlugins.register(registration);
    controller.applyDesktopProjection([registration]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    events = [];

    await writeFile(sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: "compact summary" } }) + "\n");
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "timeline_snapshot",
      target,
      items: [expect.objectContaining({ text: "compact summary" })],
    })), { timeout: 1_500, interval: 50 });
    expect(events.some((event) => (event as { type?: string }).type === "timeline_item")).toBe(false);

    events = [];
    await writeFile(sessionFile, "");
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "timeline_snapshot",
      target,
      items: [],
    })), { timeout: 1_500, interval: 50 });
  });

  it("keeps projected Desktop targets readerless for open and snapshot", async () => {
    const sessionFile = join(tmpDir, "desktop-session-materialized.jsonl");
    const runtime = makeRuntime("desktop-session-materialized", "/work/app", sessionFile);
    const createRuntime = vi.fn(async () => runtime);
    const desktopController = new HostController({
      createRuntime,
      listSessions: async () => [],
    }, reader);
    const target = {
      sessionId: "desktop-session-materialized",
      endpointId: "desktop-endpoint-materialized",
      normalizedCwd: "/work/app",
      processGeneration: "desktop-generation-materialized",
    };
    const transport: DesktopPluginTransport = { request: vi.fn(), close: vi.fn() };
    const registration = {
      target,
      sessionFile,
      capabilities: ["prompt", "abort"] as const,
      runtimeStatus: "idle" as const,
      transport,
    };

    try {
      desktopController.desktopPlugins.register(registration);
      desktopController.applyDesktopProjection([registration]);
      await Promise.resolve();
      expect(createRuntime).not.toHaveBeenCalled();

      await writeFile(sessionFile, [
        JSON.stringify({ type: "message", message: { role: "user", content: "older", timestamp: 1756800000000 } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "latest", timestamp: 1756800100000 } }),
      ].join("\n") + "\n");
      desktopController.applyDesktopProjection([registration]);
      await Promise.resolve();
      expect(createRuntime).not.toHaveBeenCalled();
      expect(desktopController.directory.resolve(target)?.runner).toBeUndefined();
      await expect(desktopController.application.query({ kind: "session_snapshot", target })).resolves.toMatchObject({
        ok: true,
        value: { timeline: [{ text: "older" }, { text: "latest" }], historyAvailable: true },
      });

      await desktopController.openSession({ cwd: "/work/app", mode: "create", target });
      expect(createRuntime).not.toHaveBeenCalled();
      expect(desktopController.directory.resolve(target)?.runner).toBeUndefined();
    } finally {
      await desktopController.dispose();
    }
  });

  it("keeps a Host reader separate from a Desktop target and on Desktop disconnect", async () => {
    const runtime = makeRuntime();
    const desktopController = new HostController({
      createRuntime: async () => runtime,
      listSessions: async () => [],
    }, reader);
    const hostEvents: unknown[] = [];
    desktopController.onEvent((event) => hostEvents.push(event));
    const target = {
      sessionId: "desktop-session",
      endpointId: "desktop-endpoint",
      normalizedCwd: "/work/app",
      processGeneration: "desktop-generation-1",
    };
    const transport: DesktopPluginTransport = {
      request: vi.fn(async (command) => ({
        type: "desktop_plugin_result",
        requestId: command.requestId,
        operation: command.operation.type,
        status: "observed",
      })),
      close: vi.fn(),
    };

    try {
      await desktopController.openSession({ cwd: "/work/app", mode: "create" });
      expect(desktopController.getSessionTarget(target.sessionId)?.endpointId).toBe("host");
      runtime.emit({ type: "message_end", message: { role: "assistant", content: "done", timestamp: 1756800100000 } });
      expect(hostEvents).toContainEqual(expect.objectContaining({ type: "timeline_item", target: desktopController.getSessionTarget(target.sessionId) }));

      desktopController.desktopPlugins.register({ target, capabilities: ["prompt", "abort"], transport });
      desktopController.registerDesktopTarget(target);
      expect(desktopController.getSessionTarget(target.sessionId)?.endpointId).toBe("host");
      expect(desktopController.directory.resolve(target)?.runner).toBeUndefined();

      desktopController.desktopPlugins.unregister(target);
      desktopController.unregisterDesktopTarget(target);
      const fallback = desktopController.getSessionTarget(target.sessionId);
      expect(fallback?.endpointId).toBe("host");
      await expect(desktopController.application.query({ kind: "session_snapshot", target: fallback! })).resolves.toMatchObject({
        ok: true,
        value: { session: { presentation: { control: { mode: "host", canPrompt: true } } } },
      });
    } finally {
      await desktopController.dispose();
    }
  });

  it("keeps the reader attached when the same Desktop target reconnects", async () => {
    const sessionFile = join(tmpDir, "desktop-session.jsonl");
    await writeFile(sessionFile, "");
    const runtime = makeRuntime("desktop-session", "/work/app", sessionFile);
    const desktopController = new HostController({
      createRuntime: async () => runtime,
      listSessions: async () => [],
    }, reader);
    const target = {
      sessionId: "desktop-session",
      endpointId: "desktop-endpoint",
      normalizedCwd: "/work/app",
      processGeneration: "desktop-generation-1",
    };
    const firstTransport: DesktopPluginTransport = { request: vi.fn(), close: vi.fn() };
    const secondTransport: DesktopPluginTransport = { request: vi.fn(), close: vi.fn() };

    try {
      desktopController.desktopPlugins.register({ target, sessionFile, capabilities: ["prompt", "abort"], transport: firstTransport });
      desktopController.registerDesktopTarget(target);
      await desktopController.openSession({ cwd: "/work/app", mode: "create", target });
      expect(desktopController.directory.resolve(target)?.runner).toBeUndefined();

      desktopController.desktopPlugins.register({ target, sessionFile, capabilities: ["prompt", "abort"], transport: secondTransport });
      desktopController.registerDesktopTarget(target);

      expect(desktopController.getSessionTarget(target.sessionId)).toEqual(target);
      expect(desktopController.directory.resolve(target)?.runner).toBeUndefined();
      await expect(desktopController.application.query({ kind: "session_snapshot", target })).resolves.toMatchObject({ ok: true });
    } finally {
      await desktopController.dispose();
    }
  });

  it("does not keep an implicit target when two Desktop targets share a session", async () => {
    const runtime = makeRuntime();
    const desktopController = new HostController({
      createRuntime: async () => runtime,
      listSessions: async () => [],
    }, reader);
    const first = {
      sessionId: "desktop-session",
      endpointId: "desktop-endpoint-1",
      normalizedCwd: "/work/app",
      processGeneration: "desktop-generation-1",
    };
    const second = { ...first, endpointId: "desktop-endpoint-2", processGeneration: "desktop-generation-2" };
    const transport = (): DesktopPluginTransport => ({ request: vi.fn(), close: vi.fn() });

    try {
      await desktopController.openSession({ cwd: "/work/app", mode: "create" });
      desktopController.desktopPlugins.register({ target: first, capabilities: ["abort"], transport: transport() });
      desktopController.registerDesktopTarget(first);
      desktopController.desktopPlugins.register({ target: second, capabilities: ["abort"], transport: transport() });
      desktopController.registerDesktopTarget(second);

      expect(desktopController.getSessionTarget(first.sessionId)?.endpointId).toBe("host");
      expect(desktopController.directory.resolve(first)?.runner).toBeUndefined();
      expect(desktopController.directory.resolve(second)?.runner).toBeUndefined();
    } finally {
      await desktopController.dispose();
    }
  });

  it("opens and reuses the exact requested Desktop target when a session has multiple endpoints", async () => {
    const sessionFile = join(tmpDir, "desktop-session.jsonl");
    await writeFile(sessionFile, "");
    const runtime = makeRuntime("desktop-session", "/work/app", sessionFile);
    const createRuntime = vi.fn(async () => runtime);
    const desktopController = new HostController({
      createRuntime,
      listSessions: async () => [],
    }, reader);
    const first = {
      sessionId: "desktop-session",
      endpointId: "desktop-endpoint-1",
      normalizedCwd: "/work/app",
      processGeneration: "desktop-generation-1",
    };
    const second = { ...first, endpointId: "desktop-endpoint-2", processGeneration: "desktop-generation-2" };
    const transport = (): DesktopPluginTransport => ({ request: vi.fn(), close: vi.fn() });

    try {
      desktopController.desktopPlugins.register({ target: first, capabilities: ["prompt", "abort"], transport: transport() });
      desktopController.registerDesktopTarget(first);
      desktopController.desktopPlugins.register({ target: second, sessionFile, capabilities: ["prompt", "abort"], transport: transport() });
      desktopController.registerDesktopTarget(second);

      const opened = await desktopController.openSession({ cwd: "/work/app", mode: "create", target: second });
      expect(desktopController.getSessionTarget(second.sessionId)).toEqual(second);
      expect(desktopController.directory.resolve(first)?.runner).toBeUndefined();
      expect(desktopController.directory.resolve(second)?.runner).toBeUndefined();
      expect(opened).toEqual({ id: second.sessionId });
      expect(createRuntime).not.toHaveBeenCalled();
      await expect(desktopController.application.query({ kind: "session_snapshot", target: second })).resolves.toMatchObject({
        ok: true,
        value: { session: { presentation: { control: { mode: "desktop_plugin", canPrompt: true } } } },
      });

      await expect(desktopController.openSession({ cwd: "/work/app", mode: "create", target: second })).resolves.toEqual({ id: second.sessionId });
      expect(createRuntime).not.toHaveBeenCalled();
    } finally {
      await desktopController.dispose();
    }
  });

  it("opens an older live Desktop target without creating a mismatched Host session", async () => {
    const createRuntime = vi.fn(async () => makeRuntime("different-host-session"));
    const desktopController = new HostController({ createRuntime, listSessions: async () => [] }, reader);
    const target = {
      sessionId: "live-only-session",
      endpointId: "desktop-endpoint",
      normalizedCwd: "/work/app",
      processGeneration: "desktop-generation",
    };
    const request = vi.fn<DesktopPluginTransport["request"]>(async (command) => ({
      type: "desktop_plugin_result",
      requestId: command.requestId,
      operation: command.operation.type,
      status: "observed",
    }));

    try {
      desktopController.desktopPlugins.register({ target, capabilities: ["prompt", "abort"], transport: { request, close: vi.fn() } });
      desktopController.registerDesktopTarget(target);

      await expect(desktopController.openSession({ cwd: "/work/app", target })).resolves.toEqual({ id: target.sessionId });
      expect(createRuntime).not.toHaveBeenCalled();
      await expect(desktopController.application.query({ kind: "session_snapshot", target })).resolves.toMatchObject({
        ok: true,
        value: {
          session: { id: target.sessionId, cwd: target.normalizedCwd, presentation: { control: { mode: "desktop_plugin", canPrompt: true } } },
          timeline: [],
          hasMoreHistory: false,
        },
      });
      await expect(desktopController.application.sessionOperation({ kind: "load_more_history", target })).resolves.toEqual({
        items: [],
        hasMore: false,
        historyAvailable: false,
        totalEntries: 0,
      });
      await expect(desktopController.application.sessionOperation({ kind: "list_skills", target })).resolves.toEqual([]);
      await expect(desktopController.application.sessionOperation({ kind: "list_models", target })).resolves.toEqual([]);
      await expect(desktopController.application.command({ requestId: "live-prompt", target, kind: "prompt", message: "hello" })).resolves.toMatchObject({ status: "observed" });
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      await desktopController.dispose();
    }
  });

  it("rejects stale exact targets for lifecycle operations without disposing the runner", async () => {
    const sessionFile = join(tmpDir, "desktop-session.jsonl");
    await writeFile(sessionFile, "");
    const runtime = makeRuntime("desktop-session", "/work/app", sessionFile);
    const local = new HostController({ createRuntime: async () => runtime, listSessions: async () => [] }, reader);
    const target = { sessionId: "desktop-session", endpointId: "desktop-endpoint", normalizedCwd: "/work/app", processGeneration: "generation-1" };
    local.desktopPlugins.register({ target, sessionFile, capabilities: ["abort"], transport: { request: vi.fn(), close: vi.fn() } });
    local.registerDesktopTarget(target);

    try {
      await local.openSession({ cwd: "/work/app", mode: "create", target });
      const stale = { ...target, processGeneration: "stale-generation" };
      expect(await local.closeSession(target.sessionId, stale)).toBe(false);
      expect(runtime.dispose).not.toHaveBeenCalled();
      expect(local.getSession(target.sessionId)).toBeUndefined();
      expect(await local.respondToExtensionUi(target.sessionId, "request", { id: "request", value: "x" }, stale)).toBe(false);
    } finally {
      await local.dispose();
    }
  });

  it("replays a model event that arrived before the session was opened", async () => {
    const sessionFile = join(tmpDir, "desktop-session.jsonl");
    await writeFile(sessionFile, "");
    const runtime = makeRuntime("desktop-session", "/work/app", sessionFile);
    const desktopController = new HostController({
      createRuntime: async () => runtime,
      listSessions: async () => [],
    }, reader);
    const target = {
      sessionId: "desktop-session",
      endpointId: "desktop-endpoint",
      normalizedCwd: "/work/app",
      processGeneration: "desktop-generation-1",
    };
    const transport: DesktopPluginTransport = {
      request: vi.fn(async (command) => ({
        type: "desktop_plugin_result",
        requestId: command.requestId,
        operation: command.operation.type,
        status: "observed",
      })),
      close: vi.fn(),
    };

    try {
      desktopController.desktopPlugins.register({ target, sessionFile, capabilities: ["prompt", "set_model", "set_thinking"], transport });
      desktopController.registerDesktopTarget(target);
      desktopController.syncDesktopModel(target, { provider: "provider-a", id: "shared-id", name: "Model A", reasoning: true, vision: false });
      desktopController.syncDesktopThinking(target, "high");

      await desktopController.openSession({ cwd: "/work/app", mode: "create", target });

      await expect(desktopController.application.query({ kind: "session_snapshot", target })).resolves.toMatchObject({
        ok: true,
        value: { session: { model: { provider: "provider-a", id: "shared-id" }, thinkingLevel: "high" } },
      });
    } finally {
      await desktopController.dispose();
    }
  });

  it("broadcasts exact-target summary changes once and keeps sibling endpoints isolated", () => {
    const first = { sessionId: "same", endpointId: "desktop-1", normalizedCwd: "/work/app", processGeneration: "g1" };
    const second = { ...first, endpointId: "desktop-2", processGeneration: "g2" };
    const transport = { request: vi.fn(), close: vi.fn() };
    controller.desktopPlugins.register({ target: first, capabilities: ["abort"], transport });
    controller.registerDesktopTarget(first);
    controller.desktopPlugins.register({ target: second, capabilities: ["abort"], transport });
    controller.registerDesktopTarget(second);

    controller.syncDesktopRuntimeStatus(first, "running");
    controller.syncDesktopRuntimeStatus(first, "running");
    controller.syncDesktopSessionSummary(first, {
      runtimeStatus: "running",
      activeSince: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:01.000Z",
      messageCount: 3,
    });

    const summaries = events.filter((event) => (event as { type?: string }).type === "session_summary_updated") as Array<{
      target: { endpointId: string };
      patch: { runtimeStatus?: string; messageCount?: number };
    }>;
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({ target: { endpointId: "desktop-1" }, patch: { runtimeStatus: "running" } });
    expect(summaries[1]).toMatchObject({ target: { endpointId: "desktop-1" }, patch: { messageCount: 3 } });
    expect(controller.directory.resolve(second)?.runtimeStatus).toBe("idle");
  });

  it("getSession returns undefined for unknown session", () => {
    expect(controller.getSession("unknown")).toBeUndefined();
  });

  it("closeSession returns false for unknown session", async () => {
    expect(await controller.closeSession("unknown")).toBe(false);
  });
});