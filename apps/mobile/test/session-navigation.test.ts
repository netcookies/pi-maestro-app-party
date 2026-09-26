import { describe, expect, it } from "vitest";
import { sessionTargetKey, type HostSessionSummary } from "@maestro-mobile/shared";
import { routeForOpenedSession, selectSessionTarget } from "../src/session-navigation.js";

function historyRow(overrides: Partial<HostSessionSummary> = {}): HostSessionSummary {
  return {
    id: "history-1",
    sessionId: "history-1",
    endpointId: "history",
    cwd: "/work",
    cwdName: "work",
    path: "/sessions/history-1.jsonl",
    title: "History",
    messageCount: 4,
    updatedAt: "2026-01-01T00:00:00.000Z",
    runtimeStatus: "history",
    ...overrides,
  };
}

describe("history session navigation", () => {
  it("uses the exact target already published in a history row", () => {
    const target = {
      sessionId: "history-1",
      endpointId: "history",
      normalizedCwd: "/work",
      processGeneration: "persisted",
    };
    const opened = selectSessionTarget(historyRow({ target, targetKey: sessionTargetKey(target) }));

    expect(opened).toEqual({ sessionId: "history-1", targetKey: sessionTargetKey(target) });
    expect(routeForOpenedSession(opened)).toEqual({
      pathname: "/session",
      params: { id: "history-1", targetKey: sessionTargetKey(target) },
    });
  });

  it("requires a server-issued exact target before opening", () => {
    expect(() => selectSessionTarget(historyRow())).toThrow("session_target_unavailable");
  });
});
