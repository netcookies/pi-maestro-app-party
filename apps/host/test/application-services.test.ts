import { describe, expect, it, vi } from "vitest";
import type { SessionRunner } from "../src/types.js";
import { SessionDirectory, type SessionTargetIdentity } from "../src/control/SessionDirectory.js";
import { SessionCommandService } from "../src/application/session-command-service.js";
import { SessionQueryService } from "../src/application/session-query-service.js";
import { ApplicationCommandRouter } from "../src/application/application-command-router.js";
import { MonitorQueryService } from "../src/application/monitor-query-service.js";
import { MonitorReadService } from "../src/application/monitor-read-service.js";

function fakeRunner(id = "session-1", cwd = "/work/app") {
  const calls = { prompt: 0, steer: 0, followUp: 0, abort: 0 };
  const state = {
    id,
    cwd,
    title: "Test session",
    runState: "idle" as const,
    messageCount: 2,
    pendingMessageCount: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const runner = {
    id,
    state,
    hasMoreHistory: false,
    snapshot: () => ({ session: state, timeline: [], nextSeq: 1 }),
    eventsSince: () => [],
    loadMoreHistory: async () => ({ items: [], hasMore: false, totalEntries: 0 }),
    searchHistory: async () => ({ matches: [], totalEntries: 0 }),
    prompt: async () => { calls.prompt += 1; },
    steer: async () => { calls.steer += 1; },
    followUp: async () => { calls.followUp += 1; },
    abort: async () => { calls.abort += 1; },
    getUsage: async () => ({ entries: 1, input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 3, cost: 0 }),
    respondToExtensionUi: () => false,
    dispose: async () => {},
  } as SessionRunner;
  return { runner, calls };
}

describe("SessionDirectory", () => {
  it("resolves only the complete target identity and replaces stale runner presentation", () => {
    const directory = new SessionDirectory();
    const { runner } = fakeRunner();
    runner.state.presentation = {
      role: "session",
      visibility: "session_list",
      control: {
        mode: "readonly",
        canPrompt: false,
        canSteer: false,
        canFollowUp: false,
        canAbort: false,
        canAnswerAsk: false,
      },
      revision: 99,
    };
    const identity = directory.registerHostRunner(runner);

    expect(directory.resolve(identity, "abort")?.runner).toBe(runner);
    expect(runner.state.presentation).toMatchObject({
      control: { mode: "host", canPrompt: true, canAbort: true },
    });
    expect(directory.resolve({ ...identity, normalizedCwd: "/work/other" }, "abort")).toBeUndefined();
    expect(directory.resolve({ ...identity, processGeneration: "stale" }, "abort")).toBeUndefined();
    expect(directory.resolve(identity, "ask")).toBeUndefined();
  });

  it("does not attach a Host runner when the Desktop cwd differs", () => {
    const directory = new SessionDirectory();
    const { runner } = fakeRunner("desktop-session", "/work/app");
    const target: SessionTargetIdentity = {
      sessionId: "desktop-session",
      endpointId: "desktop-endpoint",
      normalizedCwd: "/work/other",
      processGeneration: "generation-1",
    };
    directory.register({ identity: target, kind: "desktop", capabilities: ["abort"] });

    expect(directory.attachRunner(target, runner)).toBe(false);
    expect(directory.resolve(target)?.runner).toBeUndefined();
  });

  it("projects real Desktop Plugin capabilities instead of readonly", () => {
    const directory = new SessionDirectory();
    const identity = directory.registerDesktopTarget({
      sessionId: "desktop-session",
      endpointId: "desktop-endpoint",
      normalizedCwd: "/work/app",
      processGeneration: "generation-1",
    }, ["prompt", "steer", "follow_up", "abort", "ask-user-question"]);

    expect(directory.resolve(identity)?.presentation).toMatchObject({
      role: "session",
      visibility: "session_list",
      control: {
        mode: "desktop_plugin",
        canPrompt: true,
        canSteer: true,
        canFollowUp: true,
        canAbort: true,
        canAnswerAsk: true,
      },
    });
    expect(directory.resolve(identity)?.runtimeStatus).toBe("idle");
    expect(directory.updateDesktopRuntimeStatus(identity, "running")).toBe(true);
    expect(directory.resolve(identity)?.runtimeStatus).toBe("running");
    const revision = directory.resolve(identity)?.presentation?.revision ?? 0;
    directory.registerDesktopTarget(identity, ["abort"]);
    expect(directory.resolve(identity)?.presentation?.control).toMatchObject({ canPrompt: false, canAnswerAsk: false, canAbort: true });
    expect(directory.resolve(identity)?.presentation?.revision).toBeGreaterThan(revision);
    directory.updateDesktopSummary(identity, { messageCount: 5, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 } });
    const cleared = directory.updateDesktopSummary(identity, { reset: true, runtimeStatus: "sleeping" });
    expect(cleared?.patch.reset).toBe(true);
    expect(directory.resolve(identity)?.messageCount).toBeUndefined();
    expect(directory.resolve(identity)?.usage).toBeUndefined();
  });
});

describe("SessionCommandService", () => {
  it("executes Host abort through runner.abort exactly once for duplicate requests", async () => {
    const directory = new SessionDirectory();
    const { runner, calls } = fakeRunner();
    const target = directory.registerHostRunner(runner);
    const service = new SessionCommandService(directory);
    const command = { requestId: "req-1", target, kind: "abort" as const };

    const [first, second] = await Promise.all([service.execute(command), service.execute(command)]);

    expect(first.status).toBe("observed");
    expect(second).toEqual(first);
    expect(calls.abort).toBe(1);
  });

  it("does not reuse a request across Desktop generations", async () => {
    const directory = new SessionDirectory();
    const gateway = vi.fn(async (command: { target: SessionTargetIdentity }) => ({
      requestId: "same", operation: "set_thinking", status: "observed" as const, revision: 1,
      result: command.target.processGeneration,
    }));
    const service = new SessionCommandService(directory, { execute: gateway });
    const first: SessionTargetIdentity = { sessionId: "same", endpointId: "desktop", normalizedCwd: "/work/app", processGeneration: "first" };
    const second = { ...first, processGeneration: "second" };
    directory.registerDesktopTarget(first, ["set_thinking"]);
    directory.registerDesktopTarget(second, ["set_thinking"]);

    const results = await Promise.all([first, second].map((target) => service.execute({ requestId: "same", target, kind: "set_thinking", level: "high" })));
    expect(gateway).toHaveBeenCalledTimes(2);
    expect(results.map((result) => result.result)).toEqual(["first", "second"]);
  });

  it("returns unknown for an unavailable exact target and a missing Desktop gateway", async () => {
    const directory = new SessionDirectory();
    const { runner } = fakeRunner();
    const target = directory.registerHostRunner(runner);
    const service = new SessionCommandService(directory);
    const stale: SessionTargetIdentity = { ...target, processGeneration: "stale" };

    await expect(service.execute({ requestId: "missing", target: stale, kind: "abort" })).resolves.toMatchObject({
      status: "unknown",
      error: { code: "target_unavailable" },
    });

    directory.unregister(target);
    directory.register({ identity: target, kind: "desktop", capabilities: ["abort"] });
    await expect(service.execute({ requestId: "desktop", target, kind: "abort" })).resolves.toMatchObject({
      status: "unknown",
      error: { code: "desktop_gateway_unavailable" },
    });
  });
});

describe("SessionQueryService", () => {
  it("filters by project and excludes monitor sessions while paginating", async () => {
    const directory = new SessionDirectory();
    const source = {
      listSessions: vi.fn(async () => [
        { id: "monitor", cwd: "/work/app", title: "control", updatedAt: "2026-01-03T00:00:00Z" },
        { id: "a", cwd: "/work/app", title: "Alpha", updatedAt: "2026-01-02T00:00:00Z" },
        { id: "b", cwd: "/work/other", title: "Beta", updatedAt: "2026-01-01T00:00:00Z" },
      ]),
    };
    const readonly = {
      role: "session" as const,
      visibility: "session_list" as const,
      control: { mode: "readonly" as const, canPrompt: false, canSteer: false, canFollowUp: false, canAbort: false, canAnswerAsk: false },
      revision: 7,
    };
    const monitor = { ...readonly, role: "monitor" as const, visibility: "monitor_tab" as const };
    const service = new SessionQueryService(source, directory, (id) => id === "monitor" ? monitor : readonly);

    const page = await service.list({ projectCwds: ["/work/app"], limit: 1 });
    expect(page.sessions.map((session) => session.id)).toEqual(["a"]);
    expect(page.total).toBe(1);
    expect(page.sessions[0]?.presentation).toEqual(readonly);
    expect(source.listSessions).toHaveBeenCalledWith(undefined);
  });

  it("keeps a monitor presentation when telemetry overlays an existing history record", async () => {
    const directory = new SessionDirectory();
    const monitorPresentation = {
      role: "monitor" as const,
      visibility: "monitor_tab" as const,
      control: { mode: "readonly" as const, canPrompt: false, canSteer: false, canFollowUp: false, canAbort: false, canAnswerAsk: false },
      revision: 0,
    };
    const service = new SessionQueryService(
      { listSessions: async () => [{ id: "monitor", cwd: "/work/app", updatedAt: "2026-01-03T00:00:00Z" }] },
      directory,
      undefined,
      Date.now,
      async () => ({
        windows: [{
          sessionId: "monitor",
          endpointId: "monitor",
          runtimeStatus: "idle",
          identity: { workspaceId: "ws", ownerId: "owner", ownerNonce: "nonce", endpointId: "monitor" },
          name: "monitor",
          cwd: "/work/app",
          status: "idle",
          lifecycle: "settled",
          workStatus: "idle",
          todos: [],
          attention: [],
          facets: [],
          presentation: monitorPresentation,
        }],
        observedAt: "2026-01-03T00:00:00Z",
      }),
    );

    await expect(service.list({ includeMonitor: true })).resolves.toMatchObject({
      sessions: [{ id: "monitor", presentation: monitorPresentation, runtimeStatus: "idle" }],
    });
  });

  it("keeps an explicit monitor placement when composing an exact Desktop target", async () => {
    const directory = new SessionDirectory();
    const target = directory.registerDesktopTarget({
      sessionId: "monitor",
      endpointId: "desktop-endpoint",
      normalizedCwd: "/work/app",
      processGeneration: "generation-1",
    }, ["abort"]);
    const monitorPresentation = {
      role: "monitor" as const,
      visibility: "monitor_tab" as const,
      control: { mode: "readonly" as const, canPrompt: false, canSteer: false, canFollowUp: false, canAbort: false, canAnswerAsk: false },
      revision: 9,
    };
    const service = new SessionQueryService(
      { listSessions: async () => [] },
      directory,
      undefined,
      () => Date.parse("2026-01-03T00:00:00Z"),
      async () => ({
        windows: [{
          sessionId: "monitor",
          endpointId: "telemetry-endpoint",
          runtimeStatus: "running",
          identity: { workspaceId: "ws", ownerId: "owner", ownerNonce: "nonce", endpointId: "telemetry-endpoint" },
          name: "Monitor owner",
          cwd: "/work/app",
          status: "running",
          lifecycle: "running",
          workStatus: "active",
          todos: [],
          attention: [],
          facets: [],
          presentation: monitorPresentation,
        }],
        observedAt: "2026-01-03T00:00:00Z",
      }),
    );

    await expect(service.list()).resolves.toMatchObject({ sessions: [] });
    await expect(service.list({ includeMonitor: true })).resolves.toMatchObject({
      sessions: [{
        endpointId: "desktop-endpoint",
        target,
        presentation: {
          role: "monitor",
          visibility: "monitor_tab",
          control: { mode: "desktop_plugin", canAbort: true },
        },
      }],
    });
  });

  it("projects list identity and runtime from the connected Desktop target", async () => {
    const directory = new SessionDirectory();
    const target = directory.registerDesktopTarget({
      sessionId: "desktop-session",
      endpointId: "desktop-endpoint",
      normalizedCwd: "/work/app",
      processGeneration: "generation-1",
    }, ["prompt", "abort"], { sessionFile: "/sessions/desktop-session.jsonl" });
    const readonly = {
      role: "session" as const,
      visibility: "session_list" as const,
      control: { mode: "readonly" as const, canPrompt: false, canSteer: false, canFollowUp: false, canAbort: false, canAnswerAsk: false },
      revision: 0,
    };
    const service = new SessionQueryService(
      { listSessions: async () => [{ id: "desktop-session", cwd: "/stale", updatedAt: "2026-01-03T00:00:00Z" }] },
      directory,
      undefined,
      Date.now,
      async () => ({
        windows: [{
          sessionId: "desktop-session",
          endpointId: "telemetry-endpoint",
          runtimeStatus: "running",
          identity: { workspaceId: "ws", ownerId: "owner", ownerNonce: "nonce", endpointId: "telemetry-endpoint" },
          name: "desktop-session",
          cwd: "/work/app",
          status: "running",
          lifecycle: "running",
          workStatus: "active",
          todos: [],
          attention: [],
          facets: [],
          presentation: readonly,
        }],
        observedAt: "2026-01-03T00:00:00Z",
      }),
      () => directory.resolve(target),
    );

    await expect(service.list()).resolves.toMatchObject({
      sessions: [{
        id: "desktop-session",
        sessionId: "desktop-session",
        endpointId: "desktop-endpoint",
        target,
        runtimeStatus: "idle",
        cwd: "/work/app",
        path: "/sessions/desktop-session.jsonl",
        presentation: { control: { mode: "desktop_plugin", canPrompt: true, canAbort: true } },
      }],
    });

    directory.updateDesktopRuntimeStatus(target, "running");
    await expect(service.list()).resolves.toMatchObject({
      sessions: [{ id: "desktop-session", runtimeStatus: "running" }],
    });
  });

  it("lists a readerless Desktop target without a persisted session record", async () => {
    const directory = new SessionDirectory();
    const target = directory.registerDesktopTarget({
      sessionId: "readerless-session",
      endpointId: "desktop-endpoint",
      normalizedCwd: "/work/readerless-app",
      processGeneration: "generation-1",
    }, ["prompt", "follow_up", "ask-user-question"]);
    const service = new SessionQueryService(
      { listSessions: async () => [] },
      directory,
      undefined,
      () => Date.parse("2026-01-04T00:00:00Z"),
    );

    await expect(service.list()).resolves.toEqual({
      sessions: [{
        id: "readerless-session",
        sessionId: "readerless-session",
        endpointId: "desktop-endpoint",
        target,
        targetKey: JSON.stringify(["readerless-session", "desktop-endpoint", "/work/readerless-app", "generation-1"]),
        runtimeStatus: "idle",
        cwd: "/work/readerless-app",
        cwdName: "readerless-app",
        path: "",
        title: "readerless-app",
        messageCount: 0,
        updatedAt: "2026-01-04T00:00:00.000Z",
        presentation: {
          role: "session",
          visibility: "session_list",
          control: {
            mode: "desktop_plugin",
            canPrompt: true,
            canSteer: false,
            canFollowUp: true,
            canAbort: false,
            canAnswerAsk: true,
          },
          revision: 1,
        },
      }],
      observedAt: "2026-01-04T00:00:00.000Z",
    });
  });

  it("projects one exact selectable row per Desktop endpoint sharing a session", async () => {
    const directory = new SessionDirectory();
    const first: SessionTargetIdentity = {
      sessionId: "ambiguous-session",
      endpointId: "desktop-one",
      normalizedCwd: "/work/app",
      processGeneration: "generation-1",
    };
    const second: SessionTargetIdentity = { ...first, endpointId: "desktop-two", processGeneration: "generation-2" };
    directory.register({ identity: first, kind: "desktop", capabilities: ["abort"] });
    directory.register({ identity: second, kind: "desktop", capabilities: ["abort"] });
    const service = new SessionQueryService(
      { listSessions: async () => [{ id: first.sessionId, cwd: "/work/app", updatedAt: "2026-01-03T00:00:00Z" }] },
      directory,
      undefined,
      Date.now,
      async () => ({
        windows: [{
          sessionId: first.sessionId,
          endpointId: "monitor-endpoint",
          runtimeStatus: "running",
          identity: { workspaceId: "ws", ownerId: "owner", ownerNonce: "nonce", endpointId: "monitor-endpoint" },
          name: first.sessionId,
          cwd: first.normalizedCwd,
          status: "running",
          lifecycle: "running",
          workStatus: "active",
          todos: [],
          attention: [],
          facets: [],
          presentation: { role: "session", visibility: "session_list", control: { mode: "readonly", canPrompt: false, canSteer: false, canFollowUp: false, canAbort: false, canAnswerAsk: false }, revision: 0 },
        }],
        observedAt: "2026-01-03T00:00:00Z",
      }),
      () => undefined,
    );

    const list = await service.list({ includeMonitor: true });
    expect(list.sessions).toHaveLength(2);
    expect(list.sessions.map((session) => session.target)).toEqual(expect.arrayContaining([first, second]));
    expect(new Set(list.sessions.map((session) => session.targetKey)).size).toBe(2);
    expect(list.sessions.every((session) => session.presentation?.control.mode === "desktop_plugin")).toBe(true);
  });

  it("does not leak Monitor placement across sibling Desktop targets", async () => {
    const directory = new SessionDirectory();
    const regular = { sessionId: "shared", endpointId: "regular", normalizedCwd: "/work/app", processGeneration: "g1" };
    const monitor = { ...regular, endpointId: "monitor-endpoint", processGeneration: "g2" };
    directory.registerDesktopTarget(regular, ["prompt"]);
    directory.registerDesktopTarget(monitor, ["abort"]);
    const monitorPresentation = {
      role: "monitor" as const,
      visibility: "monitor_tab" as const,
      control: { mode: "readonly" as const, canPrompt: false, canSteer: false, canFollowUp: false, canAbort: false, canAnswerAsk: false },
      revision: 2,
    };
    const service = new SessionQueryService(
      { listSessions: async () => [{ id: "shared", cwd: "/work/app" }] },
      directory,
      undefined,
      Date.now,
      async () => ({
        windows: [{
          sessionId: "shared", endpointId: monitor.endpointId, runtimeStatus: "idle",
          identity: { workspaceId: "ws", ownerId: "owner", ownerNonce: "nonce", endpointId: monitor.endpointId },
          name: "Monitor", cwd: "/work/app", status: "idle", lifecycle: "settled", workStatus: "idle",
          todos: [], attention: [], facets: [], presentation: monitorPresentation,
        }],
        observedAt: "2026-01-03T00:00:00Z",
      }),
    );

    await expect(service.list()).resolves.toMatchObject({ sessions: [{ target: regular, presentation: { visibility: "session_list" } }] });
    const all = await service.list({ includeMonitor: true });
    expect(all.sessions).toHaveLength(2);
    expect(all.sessions.find((session) => session.target?.endpointId === monitor.endpointId)?.presentation)
      .toMatchObject({ role: "monitor", visibility: "monitor_tab", control: { mode: "desktop_plugin", canAbort: true } });
  });

  it("honors targeted session IDs and latest cwd without paging", async () => {
    const directory = new SessionDirectory();
    const service = new SessionQueryService(
      { listSessions: async () => [
        { id: "old", cwd: "/work/app", updatedAt: "2026-01-01T00:00:00Z" },
        { id: "latest", cwd: "/work/app", updatedAt: "2026-01-02T00:00:00Z" },
        { id: "other", cwd: "/work/other", updatedAt: "2026-01-03T00:00:00Z" },
      ] },
      directory,
    );

    await expect(service.list({ latestForCwds: ["/work/app"] })).resolves.toMatchObject({
      targeted: true,
      sessions: [{ id: "latest" }],
    });
    await expect(service.list({ sessionIds: ["old"], latestForCwds: ["/work/app"] })).resolves.toMatchObject({
      targeted: true,
      sessions: [{ id: "latest" }, { id: "old" }],
    });
    await expect(service.list({ sessionIds: ["missing"] })).resolves.toMatchObject({ targeted: true, sessions: [] });
    await expect(service.list({ sessionIds: ["old"], limit: 1 })).rejects.toThrow("cannot be combined");
  });

  it("paginates sibling Desktop endpoints without collapsing them by sessionId", async () => {
    const directory = new SessionDirectory();
    const first: SessionTargetIdentity = { sessionId: "same", endpointId: "endpoint-a", normalizedCwd: "/work/app", processGeneration: "generation-a" };
    const second: SessionTargetIdentity = { ...first, endpointId: "endpoint-b", processGeneration: "generation-b" };
    directory.register({ identity: first, kind: "desktop", capabilities: ["abort"] });
    directory.register({ identity: second, kind: "desktop", capabilities: ["abort"] });
    const service = new SessionQueryService(
      { listSessions: async () => [{ id: "same", cwd: "/work/app", updatedAt: "2026-01-01T00:00:00Z" }] },
      directory,
    );

    const page1 = await service.list({ limit: 1 });
    expect(page1.sessions).toHaveLength(1);
    expect(page1.hasMore).toBe(true);
    const page2 = await service.list({ limit: 1, cursor: page1.nextCursor });
    expect(page2.sessions).toHaveLength(1);
    expect(page2.sessions[0]?.target?.endpointId).not.toBe(page1.sessions[0]?.target?.endpointId);
    expect(page2.hasMore).toBe(false);
  });

  it("serves snapshots and usage only through an exact Host target", async () => {
    const directory = new SessionDirectory();
    const { runner } = fakeRunner();
    const target = directory.registerHostRunner(runner);
    const service = new SessionQueryService({ listSessions: async () => [] }, directory);

    await expect(service.snapshot(target)).resolves.toMatchObject({
      ok: true,
      value: {
        session: {
          id: "session-1",
          presentation: { control: { mode: "host", canPrompt: true, canAbort: true } },
        },
      },
    });
    await expect(service.usage({ ...target, normalizedCwd: "/wrong" })).resolves.toMatchObject({
      ok: false,
      status: "unknown",
      error: { code: "target_unavailable" },
    });
  });

  it("projects the exact Desktop target presentation into a snapshot", async () => {
    const directory = new SessionDirectory();
    const { runner } = fakeRunner("desktop-session");
    const target: SessionTargetIdentity = {
      sessionId: "desktop-session",
      endpointId: "desktop-endpoint",
      normalizedCwd: "/work/app",
      processGeneration: "generation-1",
    };
    directory.register({
      identity: target,
      kind: "desktop",
      capabilities: ["prompt", "abort", "ask"],
      runner,
    });
    const service = new SessionQueryService({ listSessions: async () => [] }, directory);

    await expect(service.snapshot(target)).resolves.toMatchObject({
      ok: true,
      value: {
        session: {
          id: "desktop-session",
          presentation: {
            control: {
              mode: "desktop_plugin",
              canPrompt: true,
              canAbort: true,
              canAnswerAsk: true,
            },
          },
        },
      },
    });
  });

  it("keeps history without an exact target readonly", async () => {
    const directory = new SessionDirectory();
    const service = new SessionQueryService(
      { listSessions: async () => [{ id: "history", cwd: "/work/app", updatedAt: "2026-01-01T00:00:00Z" }] },
      directory,
    );

    await expect(service.list()).resolves.toMatchObject({
      sessions: [{ id: "history", presentation: { control: { mode: "readonly", canPrompt: false } } }],
    });
  });

  it("routes session queries through the application facade", async () => {
    const directory = new SessionDirectory();
    const commands = new SessionCommandService(directory);
    const sessions = new SessionQueryService({ listSessions: async () => [{ id: "s-1", cwd: "/work/app", updatedAt: "2026-01-01T00:00:00Z" }] }, directory);
    const monitor = new MonitorQueryService(new MonitorReadService({ read: async () => ({ owners: [], observedAt: "2026-01-01T00:00:00Z", aliveCount: 0 }) }));
    const router = new ApplicationCommandRouter(commands, sessions, monitor);

    await expect(router.query({ kind: "session_list", options: { limit: 10 } })).resolves.toMatchObject({ sessions: [{ id: "s-1" }] });
  });
});
