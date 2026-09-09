import { describe, expect, it } from "vitest";
import type { HostSessionList, HostSessionSummary } from "@maestro-mobile/shared";
import { canLoadMoreSessions, isLoadMoreResponseCurrent, isTargetedResponseCurrent, mergeHostSessionPage, mergeTargetedHostSessions, shouldBlockSessionListError, shouldRequestTargetedSummaries } from "../src/host-session-pagination";

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
