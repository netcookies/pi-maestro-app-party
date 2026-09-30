import { describe, expect, it, vi } from "vitest";
import { SessionDirectory, type SessionTargetIdentity } from "../src/control/SessionDirectory.js";
import { SessionCommandService } from "../src/application/session-command-service.js";
import { SessionQueryService } from "../src/application/session-query-service.js";
import { ApplicationCommandRouter } from "../src/application/application-command-router.js";
import { MonitorQueryService } from "../src/application/monitor-query-service.js";
import { MonitorReadService } from "../src/application/monitor-read-service.js";

describe("SessionDirectory", () => {
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
    const target: SessionTargetIdentity = { sessionId: "same", endpointId: "desktop", normalizedCwd: "/work/app", processGeneration: "generation" };
    const service = new SessionCommandService(directory);
    const stale: SessionTargetIdentity = { ...target, processGeneration: "stale" };

    await expect(service.execute({ requestId: "missing", target: stale, kind: "abort" })).resolves.toMatchObject({
      status: "unknown",
      error: { code: "target_unavailable" },
    });

    directory.register({ identity: target, kind: "desktop", capabilities: ["abort"] });
    await expect(service.execute({ requestId: "desktop", target, kind: "abort" })).resolves.toMatchObject({
      status: "unknown",
      error: { code: "desktop_gateway_unavailable" },
    });
  });
});

describe("SessionQueryService", () => {
  it("does not infer Monitor placement from a session ID alone", async () => {
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
    expect(page.sessions.map((session) => session.id)).toEqual(["monitor"]);
    expect(page.total).toBe(2);
    expect(page.sessions[0]?.presentation).toMatchObject({ role: "session", visibility: "session_list" });
    expect(source.listSessions).toHaveBeenCalledWith(undefined);
  });

  it("does not attribute an owner Monitor role to a history target without an exact identity", async () => {
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
      sessions: [{ id: "monitor", presentation: { role: "session", visibility: "session_list" }, runtimeStatus: "history" }],
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
          endpointId: "desktop-endpoint",
          target,
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
            canPlan: false,
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

  it("attributes Monitor placement only through the exact Desktop identity", async () => {
    const directory = new SessionDirectory();
    const target = { sessionId: "shared", endpointId: "desktop-endpoint", normalizedCwd: "/work/app", processGeneration: "g1" };
    directory.registerDesktopTarget(target, ["abort"]);
    const monitorPresentation = {
      role: "monitor" as const,
      visibility: "monitor_tab" as const,
      control: { mode: "readonly" as const, canPrompt: false, canSteer: false, canFollowUp: false, canAbort: false, canAnswerAsk: false },
      revision: 2,
    };
    const service = new SessionQueryService(
      { listSessions: async () => [{ id: "shared", cwd: "/work/app", path: "/sessions/shared.jsonl" }] },
      directory,
      undefined,
      Date.now,
      async () => ({
        windows: [{
          sessionId: "shared", endpointId: "desktop-endpoint", target, runtimeStatus: "idle",
          identity: { workspaceId: "ws", ownerId: "owner", ownerNonce: "nonce", endpointId: "shared" },
          name: "Monitor", cwd: "/work/app", status: "idle", lifecycle: "settled", workStatus: "idle",
          todos: [], attention: [], facets: [], presentation: monitorPresentation,
        }],
        observedAt: "2026-01-03T00:00:00Z",
      }),
    );

    const all = await service.list({ includeMonitor: true });
    expect(all.sessions).toHaveLength(2);
    const desktopRow = all.sessions.find((session) => session.targetKey === JSON.stringify([target.sessionId, target.endpointId, target.normalizedCwd, target.processGeneration]));
    const historyRow = all.sessions.find((session) => session.target?.endpointId === "history");
    expect(desktopRow?.presentation)
      .toMatchObject({ role: "monitor", visibility: "monitor_tab", control: { mode: "desktop_plugin", canAbort: true } });
    expect(historyRow?.presentation).toMatchObject({ role: "session", visibility: "session_list" });
    const defaultList = await service.list();
    expect(defaultList.sessions.some((session) => session.targetKey === desktopRow?.targetKey)).toBe(false);
    expect(defaultList.sessions.some((session) => session.target?.endpointId === "history")).toBe(true);
  });

  it("does not leak Monitor placement across ambiguous sibling Desktop targets", async () => {
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
          sessionId: "shared", endpointId: monitor.endpointId, target: monitor, runtimeStatus: "idle",
          identity: { workspaceId: "ws", ownerId: "owner", ownerNonce: "nonce", endpointId: "shared" },
          name: "Monitor", cwd: "/work/app", status: "idle", lifecycle: "settled", workStatus: "idle",
          todos: [], attention: [], facets: [], presentation: monitorPresentation,
        }],
        observedAt: "2026-01-03T00:00:00Z",
      }),
    );

    const all = await service.list({ includeMonitor: true });
    expect(all.sessions).toHaveLength(2);
    expect(all.sessions.find((session) => session.target?.endpointId === regular.endpointId)?.presentation)
      .toMatchObject({ role: "session", visibility: "session_list" });
    expect(all.sessions.find((session) => session.target?.endpointId === monitor.endpointId)?.presentation)
      .toMatchObject({ role: "monitor", visibility: "monitor_tab" });
  });

  it("does not attribute Monitor placement when a unique Desktop target has no exact owner identity", async () => {
    const directory = new SessionDirectory();
    const target = { sessionId: "shared", endpointId: "desktop", normalizedCwd: "/work/app", processGeneration: "g1" };
    directory.registerDesktopTarget(target, ["abort"]);
    const monitorPresentation = {
      role: "monitor" as const,
      visibility: "monitor_tab" as const,
      control: { mode: "readonly" as const, canPrompt: false, canSteer: false, canFollowUp: false, canAbort: false, canAnswerAsk: false },
      revision: 1,
    };
    const service = new SessionQueryService(
      { listSessions: async () => [{ id: "shared", cwd: "/work/app" }] },
      directory,
      undefined,
      Date.now,
      async () => ({
        windows: [{
          sessionId: "shared", endpointId: "shared", runtimeStatus: "idle",
          identity: { workspaceId: "ws", ownerId: "owner", ownerNonce: "nonce", endpointId: "shared" },
          name: "Monitor", cwd: "/work/app", status: "idle", lifecycle: "settled", workStatus: "idle",
          todos: [], attention: [], facets: [], presentation: monitorPresentation,
        }],
        observedAt: "2026-01-03T00:00:00Z",
      }),
    );

    const list = await service.list({ includeMonitor: true });
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0]?.target).toEqual(target);
    expect(list.sessions[0]?.presentation).toMatchObject({ role: "session", visibility: "session_list" });
  });

  it("applies Monitor placement to only the exact sibling Desktop target", async () => {
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
          sessionId: "shared", endpointId: monitor.endpointId, target: monitor, runtimeStatus: "idle",
          identity: { workspaceId: "ws", ownerId: "owner", ownerNonce: "nonce", endpointId: "shared" },
          name: "Monitor", cwd: "/work/app", status: "idle", lifecycle: "settled", workStatus: "idle",
          todos: [], attention: [], facets: [], presentation: monitorPresentation,
        }],
        observedAt: "2026-01-03T00:00:00Z",
      }),
    );

    const list = await service.list({ includeMonitor: true });
    expect(list.sessions.find((session) => session.target?.endpointId === regular.endpointId)?.presentation)
      .toMatchObject({ role: "session", visibility: "session_list" });
    expect(list.sessions.find((session) => session.target?.endpointId === monitor.endpointId)?.presentation)
      .toMatchObject({ role: "monitor", visibility: "monitor_tab" });
  });

  it("does not expose an owner target as Monitor unless the Desktop registry confirms it", async () => {
    const directory = new SessionDirectory();
    const target = { sessionId: "orphaned", endpointId: "desktop-orphan", normalizedCwd: "/work/app", processGeneration: "g1" };
    const monitorPresentation = {
      role: "monitor" as const,
      visibility: "monitor_tab" as const,
      control: { mode: "readonly" as const, canPrompt: false, canSteer: false, canFollowUp: false, canAbort: false, canAnswerAsk: false },
      revision: 1,
    };
    const service = new SessionQueryService(
      { listSessions: async () => [] },
      directory,
      undefined,
      Date.now,
      async () => ({
        windows: [{
          sessionId: target.sessionId,
          endpointId: target.endpointId,
          target,
          runtimeStatus: "idle",
          identity: { workspaceId: "ws", ownerId: "owner", ownerNonce: "nonce", endpointId: target.sessionId },
          name: "Monitor", cwd: target.normalizedCwd, status: "idle", lifecycle: "settled", workStatus: "idle",
          todos: [], attention: [], facets: [], presentation: monitorPresentation,
        }],
        observedAt: "2026-01-03T00:00:00Z",
      }),
    );

    await expect(service.list({ includeMonitor: true })).resolves.toMatchObject({ sessions: [] });
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

  it("serves snapshots and usage only through an exact Desktop target", async () => {
    const directory = new SessionDirectory();
    const target = directory.registerDesktopTarget({
      sessionId: "desktop-session",
      endpointId: "desktop-endpoint",
      normalizedCwd: "/work/app",
      processGeneration: "generation-1",
    }, ["abort"]);
    const service = new SessionQueryService({ listSessions: async () => [] }, directory);

    await expect(service.snapshot(target)).resolves.toMatchObject({
      ok: true,
      value: { session: { id: "desktop-session", presentation: { control: { mode: "desktop_plugin", canAbort: true } } } },
    });
    await expect(service.usage({ ...target, normalizedCwd: "/wrong" })).resolves.toMatchObject({
      ok: false,
      status: "unknown",
      error: { code: "target_unavailable" },
    });
  });

  it("projects the exact Desktop target presentation into a snapshot", async () => {
    const directory = new SessionDirectory();
    const target: SessionTargetIdentity = directory.registerDesktopTarget({
      sessionId: "desktop-session",
      endpointId: "desktop-endpoint",
      normalizedCwd: "/work/app",
      processGeneration: "generation-1",
    }, ["prompt", "abort", "ask-user-question"]);
    const service = new SessionQueryService({ listSessions: async () => [] }, directory);

    await expect(service.snapshot(target)).resolves.toMatchObject({
      ok: true,
      value: {
        session: {
          id: "desktop-session",
          presentation: { control: { mode: "desktop_plugin", canPrompt: true, canAbort: true, canAnswerAsk: true } },
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
