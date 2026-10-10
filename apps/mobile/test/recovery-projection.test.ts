import { describe, expect, it } from "vitest";
import { projectRecoveryUpdate, type RecoveryProjectionAdapter } from "../src/recovery-projection.js";
import type { HostEvent, SessionTargetIdentity } from "@maestro-mobile/mobile-sdk/protocol";
import type { AppAction } from "../src/app-state.js";

const target: SessionTargetIdentity = {
  sessionId: "s1", endpointId: "desktop-1", normalizedCwd: "/work", processGeneration: "p1",
};

function adapter(actions: AppAction[], events: HostEvent[], flushes: string[]): RecoveryProjectionAdapter {
  return {
    dispatch: (action) => actions.push(action),
    flushPendingEvents: () => flushes.push("flush"),
    clearPendingEvents: () => flushes.push("clear"),
    dispatchBuffered: (event) => events.push(event),
    sessionTargets: new Map(),
  };
}

describe("recovery projection adapter", () => {
  it("projects snapshot and replay as one transaction after flushing UI microbatch", () => {
    const actions: AppAction[] = [];
    const events: HostEvent[] = [];
    const flushes: string[] = [];
    projectRecoveryUpdate({
      type: "snapshot", generation: 2, requestGeneration: 4, target,
      snapshot: { session: { id: "s1", cwd: "/work", title: "S", runState: "idle", messageCount: 0, pendingMessageCount: 0, updatedAt: "" }, timeline: [], nextSeq: 0, wireSeq: 10 },
      replayedEvents: [{ type: "timeline_item", sessionId: "s1", target, item: { id: "m1", kind: "assistant", text: "ok", createdAt: "" }, seq: 10 }],
    }, adapter(actions, events, flushes));
    expect(flushes).toEqual(["flush"]);
    expect(events).toEqual([]);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "__snapshot_transaction", events: [{ seq: 10 }] });
  });

  it("clears pending UI events before projecting a connection reset", () => {
    const actions: AppAction[] = [];
    const flushes: string[] = [];
    projectRecoveryUpdate({ type: "reset", generation: 3 }, adapter(actions, [], flushes));
    expect(flushes).toEqual(["clear"]);
    expect(actions).toEqual([{ type: "__connection_reset", connectionGeneration: 3 }]);
  });
});
