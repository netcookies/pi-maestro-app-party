import { describe, expect, it } from "vitest";
import type { HostSessionList, HostSessionSummary } from "@maestro-mobile/shared";
import { canLoadMoreSessions, filterSessionsByVisibility, isLoadMoreResponseCurrent, isServerSessionPresentation, isTargetedResponseCurrent, mergeHostSessionPage, mergeSessionPresentation, mergeTargetedHostSessions, patchHostSessionSummary, shouldBlockSessionListError, shouldRequestTargetedSummaries } from "../src/host-session-pagination";

function session(id: string, title = id): HostSessionSummary {
  return {
    id, title, cwd: "/project", cwdName: "project", path: `/sessions/${id}.jsonl`,
    messageCount: 1, updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function page(sessions: HostSessionSummary[], extra: Partial<HostSessionList> = {}): HostSessionList {
  return { sessions, observedAt: "2026-01-01T00:00:00.000Z", ...extra };
}

describe("host session pagination", () => {
  it("accepts and scopes only server-provided session presentations", () => {
    const visible = session("visible");
    visible.presentation = { role: "session", visibility: "session_list", control: { mode: "readonly", canPrompt: false, canSteer: false, canFollowUp: false, canAbort: false, canAnswerAsk: false }, revision: 3 };
    const monitor = session("monitor");
    monitor.presentation = { ...visible.presentation, role: "monitor", visibility: "monitor_tab" };
    expect(isServerSessionPresentation(visible.presentation)).toBe(true);
    expect(filterSessionsByVisibility([visible, monitor], "session_list").map((item) => item.id)).toEqual(["visible"]);
    expect(filterSessionsByVisibility([visible, monitor], "monitor_tab").map((item) => item.id)).toEqual(["monitor"]);
    expect(isServerSessionPresentation({ role: "session", visibility: "session_list" })).toBe(false);
  });

  it("keeps the newest server presentation when responses race", () => {
    const current = session("s");
    current.presentation = { role: "session", visibility: "session_list", control: { mode: "readonly", canPrompt: false, canSteer: false, canFollowUp: false, canAbort: false, canAnswerAsk: false }, revision: 4 };
    const stale = { ...current, title: "stale", presentation: { ...current.presentation, revision: 3 } };
    expect(mergeSessionPresentation(current, stale)).toBe(current);
  });


  it("merges pages in order and deduplicates overlapping sessions", () => {
    const result = mergeHostSessionPage(
      [session("a"), session("b", "old")],
      page([session("b", "new"), session("c")], { hasMore: true, nextCursor: "cursor-2", total: 4 }),
      false,
    );
    expect(result.sessions.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(result.sessions[1].title).toBe("new");
    expect(result).toMatchObject({ hasMore: true, nextCursor: "cursor-2", total: 4 });
  });

  it("keeps rows for sibling endpoints that share a sessionId", () => {
    const first = { ...session("same", "one"), targetKey: "same:endpoint-1", endpointId: "endpoint-1" };
    const second = { ...session("same", "two"), targetKey: "same:endpoint-2", endpointId: "endpoint-2" };
    const result = mergeHostSessionPage([], page([first, second], { hasMore: false, total: 2 }), true);

    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.map((item) => item.endpointId)).toEqual(["endpoint-1", "endpoint-2"]);
  });

  it("patches only the matching exact target card", () => {
    const target = { sessionId: "same", endpointId: "endpoint-1", normalizedCwd: "/project", processGeneration: "g1" };
    const sibling = { ...target, endpointId: "endpoint-2", processGeneration: "g2" };
    const current = [
      { ...session("same", "one"), target, targetKey: JSON.stringify([target.sessionId, target.endpointId, target.normalizedCwd, target.processGeneration]), runtimeStatus: "idle" as const },
      { ...session("same", "two"), target: sibling, targetKey: JSON.stringify([sibling.sessionId, sibling.endpointId, sibling.normalizedCwd, sibling.processGeneration]), runtimeStatus: "idle" as const },
    ];
    const result = patchHostSessionSummary(current, target, { runtimeStatus: "running", activeSince: "2026-01-01T00:00:00.000Z", messageCount: 7 }, 3);
    expect(result[0]).toMatchObject({ runtimeStatus: "running", messageCount: 7, activeSince: "2026-01-01T00:00:00.000Z" });
    expect(result[1]).toBe(current[1]);
  });

  it("clears prior live summary fields at a reset boundary", () => {
    const target = { sessionId: "reset", endpointId: "endpoint-1", normalizedCwd: "/project", processGeneration: "g1" };
    const row = {
      ...session("reset"),
      target,
      targetKey: JSON.stringify([target.sessionId, target.endpointId, target.normalizedCwd, target.processGeneration]),
      runtimeStatus: "running" as const,
      activeSince: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:01.000Z",
      messageCount: 7,
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: 0.2 },
      totalTokens: 18,
      cost: 0.2,
      context: { tokens: 18, contextWindow: 100, percent: 18 },
    };
    const [patched] = patchHostSessionSummary([row], target, { reset: true, runtimeStatus: "sleeping", activeSince: null }, 4);

    expect(patched).toMatchObject({ runtimeStatus: "sleeping", summaryRevision: 4 });
    expect(patched).not.toHaveProperty("messageCount");
    expect(patched).not.toHaveProperty("usage");
    expect(patched).not.toHaveProperty("totalTokens");
    expect(patched).not.toHaveProperty("cost");
    expect(patched).not.toHaveProperty("context");
    expect(patched.activeSince).toBeUndefined();
    expect(patched.lastActivityAt).toBeUndefined();
  });

  it("does not let an exact-target event patch a legacy row by sessionId fallback", () => {
    const target = { sessionId: "same", endpointId: "endpoint-1", normalizedCwd: "/project", processGeneration: "g1" };
    const legacy = { ...session("same", "legacy"), endpointId: "history", runtimeStatus: "history" as const };
    const result = patchHostSessionSummary([legacy], target, { runtimeStatus: "sleeping" }, 3);
    expect(result[0]).toBe(legacy);
  });

  it("resets the prior result for refresh and search", () => {
    const result = mergeHostSessionPage([session("old")], page([session("match")], { hasMore: false, total: 1 }), true);
    expect(result.sessions.map((item) => item.id)).toEqual(["match"]);
    expect(result.hasMore).toBe(false);
  });

  it("treats a legacy Host response without pagination fields as complete", () => {
    const result = mergeHostSessionPage([], page([session("a"), session("b")]), true);
    expect(result).toMatchObject({ hasMore: false, nextCursor: undefined, total: undefined });
  });

  it("blocks concurrent and repeated load-more requests", () => {
    const base = { connected: true, hasMore: true, nextCursor: "cursor-2" };
    expect(canLoadMoreSessions({ ...base, loading: false })).toBe(true);
    expect(canLoadMoreSessions({ ...base, loading: true })).toBe(false);
    expect(canLoadMoreSessions({ ...base, loading: false, firstPageInFlight: true })).toBe(false);
    expect(canLoadMoreSessions({ ...base, loading: false, lastRequestedCursor: "cursor-2" })).toBe(false);
    expect(canLoadMoreSessions({ ...base, loading: false, lastRequestedCursor: "cursor-1" })).toBe(true);
    expect(canLoadMoreSessions({ ...base, loading: false, nextCursor: undefined })).toBe(false);
  });

  it("merges targeted summaries without changing pagination metadata", () => {
    const current = { sessions: [session("page")], hasMore: true, nextCursor: "cursor-2", total: 50 };
    const result = mergeTargetedHostSessions(current, page([session("live")], { targeted: true }));
    expect(result.sessions.map((item) => item.id)).toEqual(["page", "live"]);
    expect(result).toMatchObject({ hasMore: true, nextCursor: "cursor-2", total: 50 });
    expect(mergeTargetedHostSessions(current, page([session("legacy-full")]))).toBe(current);
  });

  it("blocks stale load-more responses by generation, query, and cursor", () => {
    const base = { expectedGeneration: 2, currentGeneration: 2, expectedQuery: "new", currentQuery: "new", expectedCursor: "c2", currentCursor: "c2" };
    expect(isLoadMoreResponseCurrent(base)).toBe(true);
    expect(isLoadMoreResponseCurrent({ ...base, currentGeneration: 3 })).toBe(false);
    expect(isLoadMoreResponseCurrent({ ...base, currentQuery: "newer" })).toBe(false);
    expect(isLoadMoreResponseCurrent({ ...base, currentCursor: undefined })).toBe(false);
  });

  it("requires matching generation, Host identity, and connection for targeted commits", () => {
    const base = { expectedGeneration: 2, currentGeneration: 2, expectedHostIdentity: "host-a|1", currentHostIdentity: "host-a|1", connected: true };
    expect(isTargetedResponseCurrent(base)).toBe(true);
    expect(isTargetedResponseCurrent({ ...base, currentGeneration: 3 })).toBe(false);
    expect(isTargetedResponseCurrent({ ...base, currentHostIdentity: "host-b|2" })).toBe(false);
    expect(isTargetedResponseCurrent({ ...base, connected: false })).toBe(false);
  });

  it("probes unsupported targeted capability only once", () => {
    const base = { inFlight: false, failureCount: 0, maxFailures: 2, retryAt: 0, now: 10_000 };
    expect(shouldRequestTargetedSummaries({ ...base, capability: "unknown" })).toBe(true);
    expect(shouldRequestTargetedSummaries({ ...base, capability: "supported" })).toBe(true);
    expect(shouldRequestTargetedSummaries({ ...base, capability: "unsupported" })).toBe(false);
    expect(shouldRequestTargetedSummaries({ ...base, capability: "unknown", inFlight: true })).toBe(false);
    expect(shouldRequestTargetedSummaries({ ...base, capability: "unknown", failureCount: 2 })).toBe(false);
    expect(shouldRequestTargetedSummaries({ ...base, capability: "unknown", retryAt: 10_001 })).toBe(false);
  });

  it("only blocks list failures when no cached sessions remain", () => {
    expect(shouldBlockSessionListError(0)).toBe(true);
    expect(shouldBlockSessionListError(1)).toBe(false);
  });

  it("stops when hasMore has no usable next cursor", () => {
    const result = mergeHostSessionPage([], page([session("a")], { hasMore: true, total: 2 }), true);
    expect(result.hasMore).toBe(false);
  });
});
