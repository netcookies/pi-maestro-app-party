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
    expect(routeForOpenedSession(opened, "sessions")).toEqual({
      pathname: "/session",
      params: { id: "history-1", targetKey: sessionTargetKey(target), from: "sessions" },
    });
  });

  it("uses the canonical key instead of a mismatched advertised key", () => {
    const target = { sessionId: "history-1", endpointId: "history", normalizedCwd: "/work", processGeneration: "persisted" };
    const opened = selectSessionTarget(historyRow({ target, targetKey: JSON.stringify(["other", "history", "/work", "persisted"]) }));
    expect(opened.targetKey).toBe(sessionTargetKey(target));
  });

  it("keeps Monitor classification separate while opening its ordinary exact target", () => {
    const target = {
      sessionId: "history-1",
      endpointId: "desktop-monitor",
      normalizedCwd: "/work",
      processGeneration: "generation-2",
    };
    const monitor = historyRow({
      endpointId: target.endpointId,
      target,
      targetKey: sessionTargetKey(target),
      presentation: {
        role: "monitor",
        visibility: "monitor_tab",
        control: { mode: "readonly", canPrompt: false, canSteer: false, canFollowUp: false, canAbort: false, canAnswerAsk: false },
        revision: 3,
      },
    });

    const opened = selectSessionTarget(monitor);
    expect(opened).toEqual({ sessionId: "history-1", targetKey: sessionTargetKey(target) });
    expect(routeForOpenedSession(opened, "monitor")).toEqual({
      pathname: "/session",
      params: { id: "history-1", targetKey: sessionTargetKey(target), from: "monitor" },
    });
  });

  it("rejects target metadata that disagrees with the session row", () => {
    const target = { sessionId: "other", endpointId: "history", normalizedCwd: "/work", processGeneration: "persisted" };
    expect(() => selectSessionTarget(historyRow({ target }))).toThrow("session_target_unavailable");
  });
  it("requires a server-issued exact target before opening", () => {
    expect(() => selectSessionTarget(historyRow())).toThrow("session_target_unavailable");
  });
  it("passes the model through navigation so the header and floating toolbar can render it before projection arrives", () => {
    const target = { sessionId: "history-1", endpointId: "history", normalizedCwd: "/work", processGeneration: "persisted" };
    const opened = selectSessionTarget(historyRow({ target, model: "gpt-6.1-sol" }));
    expect(opened.model).toBe("gpt-6.1-sol");
    expect(routeForOpenedSession(opened, "sessions")).toEqual({
      pathname: "/session",
      params: { id: "history-1", targetKey: sessionTargetKey(target), from: "sessions", model: "gpt-6.1-sol" },
    });
  });
  it("accepts model objects with an id field", () => {
    const target = { sessionId: "history-1", endpointId: "history", normalizedCwd: "/work", processGeneration: "persisted" };
    const opened = selectSessionTarget(historyRow({ target, model: { id: "deepseek-v4.1-flash" } as unknown as HostSessionSummary["model"] }));
    expect(opened.model).toBe("deepseek-v4.1-flash");
  });
});
