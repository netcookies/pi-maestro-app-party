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
  it("resolves only the complete target identity and capability", () => {
    const directory = new SessionDirectory();
    const { runner } = fakeRunner();
    const identity = directory.registerHostRunner(runner);

    expect(directory.resolve(identity, "abort")?.runner).toBe(runner);
    expect(directory.resolve({ ...identity, normalizedCwd: "/work/other" }, "abort")).toBeUndefined();
    expect(directory.resolve({ ...identity, processGeneration: "stale" }, "abort")).toBeUndefined();
    expect(directory.resolve(identity, "ask")).toBeUndefined();
  });

  it("does not reuse a removed target or infer a replacement", () => {
    const directory = new SessionDirectory();
    const first = fakeRunner("same-session");
    const firstIdentity = directory.registerHostRunner(first.runner);
    directory.unregister(firstIdentity);
    const secondIdentity = directory.registerHostRunner(fakeRunner("same-session").runner);

    expect(secondIdentity.processGeneration).not.toBe(firstIdentity.processGeneration);
    expect(directory.resolve(firstIdentity)).toBeUndefined();
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

  it("serves snapshots and usage only through an exact Host target", async () => {
    const directory = new SessionDirectory();
    const { runner } = fakeRunner();
    const target = directory.registerHostRunner(runner);
    const service = new SessionQueryService({ listSessions: async () => [] }, directory);

    await expect(service.snapshot(target)).resolves.toMatchObject({ ok: true, value: { session: { id: "session-1" } } });
    await expect(service.usage({ ...target, normalizedCwd: "/wrong" })).resolves.toMatchObject({
      ok: false,
      status: "unknown",
      error: { code: "target_unavailable" },
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
