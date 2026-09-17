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

  it("projects list identity and runtime from the active Desktop target", async () => {
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
      capabilities: ["prompt", "abort"],
      runner,
    });
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
        runtimeStatus: "idle",
        cwd: "/work/app",
        presentation: { control: { mode: "desktop_plugin", canPrompt: true, canAbort: true } },
      }],
    });
  });

  it("keeps an ambiguous directory session readonly instead of joining telemetry by sessionId", async () => {
    const directory = new SessionDirectory();
    const first: SessionTargetIdentity = {
      sessionId: "ambiguous-session",
      endpointId: "desktop-one",
      normalizedCwd: "/work/app",
      processGeneration: "generation-1",
    };
    directory.register({ identity: first, kind: "desktop", capabilities: ["abort"] });
    directory.register({ identity: { ...first, endpointId: "desktop-two", processGeneration: "generation-2" }, kind: "desktop", capabilities: ["abort"] });
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

    await expect(service.list({ includeMonitor: true })).resolves.toMatchObject({
      sessions: [{ endpointId: "history", runtimeStatus: "history", presentation: { control: { mode: "readonly" } } }],
    });
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
