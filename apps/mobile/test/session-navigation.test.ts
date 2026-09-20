import { describe, expect, it } from "vitest";
import { sessionTargetKey, type HostSessionSummary } from "@maestro-mobile/shared";
import { resolveOpenedSession, routeForOpenedSession } from "../src/session-navigation.js";

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
  it("uses the exact target newly returned while opening a legacy history row", () => {
    const target = {
      sessionId: "history-1",
      endpointId: "host-1",
      normalizedCwd: "/work",
      processGeneration: "generation-1",
    };
    const opened = resolveOpenedSession(historyRow(), { sessionId: "history-1", target });

    expect(opened.targetKey).toBe(sessionTargetKey(target));
    expect(routeForOpenedSession(opened)).toEqual({
      pathname: "/session",
      params: { id: "history-1", targetKey: sessionTargetKey(target) },
    });
  });

  it("rejects a returned target that differs from the selected exact endpoint", () => {
    const selectedTarget = {
      sessionId: "history-1",
      endpointId: "desktop-1",
      normalizedCwd: "/work",
      processGeneration: "generation-1",
    };
    expect(() => resolveOpenedSession(
      historyRow({ target: selectedTarget, targetKey: sessionTargetKey(selectedTarget) }),
      { sessionId: "history-1", target: { ...selectedTarget, endpointId: "desktop-2" } },
    )).toThrow("does not match the selected endpoint");
  });
});
