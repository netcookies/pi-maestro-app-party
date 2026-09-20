import { describe, expect, it } from "vitest";
import type { MonitorState, MonitorWindowSummary } from "@maestro-mobile/shared";
import { monitorStateFromCommandResult, monitorWindowKey, monitorWindows } from "../src/monitor-data.js";

function window(overrides: Partial<MonitorWindowSummary> = {}): MonitorWindowSummary {
  return {
    sessionId: "session-1",
    endpointId: "endpoint-1",
    runtimeStatus: "running",
    identity: { workspaceId: "workspace-1", ownerId: "owner-1", ownerNonce: "nonce-1", endpointId: "telemetry-1" },
    name: "Monitor window",
    cwd: "/work",
    status: "running",
    lifecycle: "active",
    workStatus: "working",
    todos: [],
    attention: [],
    facets: [],
    presentation: {
      role: "monitor",
      visibility: "monitor_tab",
      control: { mode: "readonly", canPrompt: false, canSteer: false, canFollowUp: false, canAbort: false, canAnswerAsk: false },
      revision: 1,
    },
    ...overrides,
  };
}

describe("monitor projection data", () => {
  it("extracts the Host monitor read envelope without converting windows into sessions", () => {
    const state: MonitorState = { windows: [window()], observedAt: "2026-01-01T00:00:00.000Z", revision: 4 };
    const parsed = monitorStateFromCommandResult({ state, stableKey: "stable", revision: 4 });

    expect(parsed).toBe(state);
    expect(monitorWindows(parsed)).toBe(state.windows);
    expect(monitorWindows(parsed)[0]).toMatchObject({ lifecycle: "active", workStatus: "working" });
  });

  it("keys telemetry windows from their provided identity fields", () => {
    const first = window();
    const nextGeneration = window({ identity: { ...first.identity, ownerNonce: "nonce-2" } });
    expect(monitorWindowKey(first)).not.toBe(monitorWindowKey(nextGeneration));
    expect(monitorWindowKey(first)).toBe(JSON.stringify(["workspace-1", "owner-1", "nonce-1", "telemetry-1"]));
  });

  it("rejects malformed monitor command results", () => {
    expect(() => monitorStateFromCommandResult({ state: { observedAt: "now" } })).toThrow("Invalid monitor state response");
  });
});
