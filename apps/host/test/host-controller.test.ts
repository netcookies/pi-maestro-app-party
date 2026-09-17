import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { HostController } from "../src/host-controller.js";
import { MaestroStateReader } from "../src/maestro-state.js";
import type { DesktopPluginTransport } from "../src/plugin/desktop-plugin-registry.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

function makeRuntime(sessionId = "desktop-session", cwd = "/work/app") {
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
    const runtime = makeRuntime();
    const desktopEvents: unknown[] = [];
    const desktopController = new HostController({
      createRuntime: async () => runtime,
      listSessions: async () => [],
    }, reader);
    desktopController.onEvent((event) => desktopEvents.push(event));
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
      capabilities: ["prompt", "steer", "follow_up", "abort", "ask-user-question"],
      transport,
    });
    desktopController.registerDesktopTarget(target);

    try {
      await desktopController.openSession({ cwd: "/work/app", mode: "create" });

      expect(desktopController.getSessionTarget(target.sessionId)).toEqual(target);
      await expect(desktopController.application.query({ kind: "session_snapshot", target })).resolves.toMatchObject({
        ok: true,
        value: { session: { presentation: { control: { mode: "desktop_plugin", canPrompt: true } } } },
      });
      runtime.emit({ type: "message_end", message: { role: "assistant", content: "done", timestamp: 1756800100000 } });
      const sessionUpdate = desktopEvents.findLast((event) => (event as { type?: string }).type === "session_updated") as {
        session?: { presentation?: { control?: { mode?: string } } };
      } | undefined;
      expect(sessionUpdate?.session?.presentation?.control?.mode).toBe("desktop_plugin");
      await expect(desktopController.application.command({ requestId: "abort-1", target, kind: "abort" })).resolves.toMatchObject({
        status: "observed",
      });
      expect(request).toHaveBeenCalledTimes(1);

      expect(await desktopController.closeSession(target.sessionId)).toBe(true);
      expect(desktopController.directory.resolve(target)?.kind).toBe("desktop");
      expect(desktopController.directory.resolve(target)?.runner).toBeUndefined();
    } finally {
      await desktopController.dispose();
    }
  });

  it("migrates a Host reader to one Desktop target and falls back when it disconnects", async () => {
    const runtime = makeRuntime();
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
      await desktopController.openSession({ cwd: "/work/app", mode: "create" });
      expect(desktopController.getSessionTarget(target.sessionId)?.endpointId).toBe("host");

      desktopController.desktopPlugins.register({ target, capabilities: ["prompt", "abort"], transport });
      desktopController.registerDesktopTarget(target);
      expect(desktopController.getSessionTarget(target.sessionId)).toEqual(target);

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
    const runtime = makeRuntime();
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
      await desktopController.openSession({ cwd: "/work/app", mode: "create" });
      desktopController.desktopPlugins.register({ target, capabilities: ["prompt", "abort"], transport: firstTransport });
      desktopController.registerDesktopTarget(target);
      expect(desktopController.directory.resolve(target)?.runner).toBeDefined();

      desktopController.desktopPlugins.register({ target, capabilities: ["prompt", "abort"], transport: secondTransport });
      desktopController.registerDesktopTarget(target);

      expect(desktopController.getSessionTarget(target.sessionId)).toEqual(target);
      expect(desktopController.directory.resolve(target)?.runner).toBe(desktopController.getSession(target.sessionId));
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

      expect(desktopController.getSessionTarget(first.sessionId)).toBeUndefined();
      expect(desktopController.directory.resolve(first)?.runner).toBeDefined();
      expect(desktopController.directory.resolve(second)?.runner).toBeUndefined();
    } finally {
      await desktopController.dispose();
    }
  });

  it("replays a model event that arrived before the session was opened", async () => {
    const runtime = makeRuntime();
    const desktopController = new HostController({
      createRuntime: async () => runtime,
      listSessions: async () => [],
    }, reader);
    const events: unknown[] = [];
    desktopController.onEvent((event) => events.push(event));
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
      desktopController.desktopPlugins.register({ target, capabilities: ["prompt", "set_model"], transport });
      desktopController.registerDesktopTarget(target);
      desktopController.syncDesktopModel(target, { provider: "provider-a", id: "shared-id", name: "Model A", reasoning: true, vision: false });

      await desktopController.openSession({ cwd: "/work/app", mode: "create" });

      const last = events.filter((event) => (event as { type?: string }).type === "session_updated").at(-1) as {
        session?: { model?: { id?: string; provider?: string } };
      } | undefined;
      expect(last?.session?.model).toMatchObject({ provider: "provider-a", id: "shared-id" });
    } finally {
      await desktopController.dispose();
    }
  });

  it("getSession returns undefined for unknown session", () => {
    expect(controller.getSession("unknown")).toBeUndefined();
  });

  it("closeSession returns false for unknown session", async () => {
    expect(await controller.closeSession("unknown")).toBe(false);
  });
});