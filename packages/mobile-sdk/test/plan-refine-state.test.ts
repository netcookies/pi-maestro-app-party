import { describe, expect, it } from "vitest";
import {
  isMobilePlanRefineAction,
  isMobilePlanRefineEvent,
  type MobilePlanRefineSnapshot,
  type MobilePlanRefineTurn,
} from "../src/mobile-plan-refine-protocol.js";
import { PlanRefineTracker } from "../src/plan-refine-state.js";

const turn = (id: string, role: "reviewer" | "optimizer" = "reviewer"): MobilePlanRefineTurn => ({
  turnId: id,
  role,
  model: "p/m",
  modelLabel: "p/m",
  userInput: "",
  output: "out",
  appliesAs: role === "optimizer" ? "draft" : "feedback",
  createdAt: "2026-10-23T00:00:00.000Z",
});

const snapshot = (overrides: Partial<MobilePlanRefineSnapshot> = {}): MobilePlanRefineSnapshot => ({
  type: "plan_refine_snapshot",
  sequence: 3,
  highWaterSequence: 3,
  refineSessionId: "refine-1",
  planRequestId: "plan-1",
  operationId: 7,
  revision: 2,
  status: "ready",
  markdown: "# Plan",
  turns: [],
  currentRole: "reviewer",
  currentModel: "p/m",
  modelOptions: [{ id: "p/m", name: "p/m" }],
  availableActions: ["select_role", "select_model", "run", "apply", "discard", "cancel"],
  ...overrides,
});

describe("plan refine protocol validation", () => {
  it("accepts a well-formed snapshot and rejects a malformed one", () => {
    expect(isMobilePlanRefineEvent(snapshot())).toBe(true);
    expect(isMobilePlanRefineEvent({ ...snapshot(), status: "bogus" })).toBe(false);
    expect(isMobilePlanRefineEvent({ ...snapshot(), sequence: 0 })).toBe(false);
    expect(isMobilePlanRefineEvent({ ...snapshot(), turns: [{ turnId: "" }] })).toBe(false);
    expect(isMobilePlanRefineEvent({ ...snapshot(), availableActions: ["explode"] })).toBe(false);
  });

  it("rejects unknown error codes instead of accepting arbitrary strings", () => {
    const terminal = {
      type: "plan_refine_terminal",
      sequence: 4,
      refineSessionId: "refine-1",
      planRequestId: "plan-1",
      operationId: 7,
      status: "failed",
      error: { code: "made_up" },
    };
    expect(isMobilePlanRefineEvent(terminal)).toBe(false);
    expect(isMobilePlanRefineEvent({ ...terminal, error: { code: "run_failed" } })).toBe(true);
  });

  it("validates client actions including bounded run input", () => {
    const base = {
      type: "plan_refine_action",
      refineSessionId: "refine-1",
      planRequestId: "plan-1",
      operationId: 7,
      revision: 2,
      actionId: "a-1",
    };
    expect(isMobilePlanRefineAction({ ...base, action: { action: "run", userInput: "hi" } })).toBe(true);
    expect(isMobilePlanRefineAction({ ...base, action: { action: "run", userInput: "x".repeat(20_000) } })).toBe(false);
    expect(isMobilePlanRefineAction({ ...base, action: { action: "apply", turnId: "t1" } })).toBe(true);
    expect(isMobilePlanRefineAction({ ...base, action: { action: "apply" } })).toBe(false);
    expect(isMobilePlanRefineAction({ ...base, action: { action: "nope" } })).toBe(false);
  });
});

describe("plan refine tracker sequencing", () => {
  it("applies a snapshot and re-bases the expected sequence", () => {
    const tracker = new PlanRefineTracker();
    expect(tracker.apply(snapshot({ highWaterSequence: 3 }))).toBe("applied");
    const state = tracker.current;
    expect(state.kind).toBe("live");
    if (state.kind !== "live") throw new Error("expected live");
    expect(state.expectedSequence).toBe(4);
    expect(state.turns).toHaveLength(0);
  });

  it("ignores duplicates, requests a snapshot on gaps, and applies in-order updates", () => {
    const reasons: string[] = [];
    const tracker = new PlanRefineTracker({ requestSnapshot: (reason) => reasons.push(reason) });
    tracker.apply(snapshot({ sequence: 1, highWaterSequence: 1 }));

    const update = (sequence: number) => ({
      type: "plan_refine_update" as const,
      sequence,
      refineSessionId: "refine-1",
      planRequestId: "plan-1",
      operationId: 7,
      revision: 2,
      status: "running" as const,
    });

    expect(tracker.apply(update(1))).toBe("duplicate");
    expect(tracker.apply(update(3))).toBe("gap");
    expect(reasons).toEqual(["gap"]);
    expect(tracker.apply(update(2))).toBe("applied");

    const state = tracker.current;
    if (state.kind !== "live") throw new Error("expected live");
    expect(state.expectedSequence).toBe(3);
  });

  it("upserts a turn by turnId instead of duplicating it", () => {
    const tracker = new PlanRefineTracker();
    tracker.apply(snapshot({ sequence: 1, highWaterSequence: 1 }));
    const base = {
      type: "plan_refine_update" as const,
      refineSessionId: "refine-1",
      planRequestId: "plan-1",
      operationId: 7,
      revision: 2,
      status: "ready" as const,
    };
    tracker.apply({ ...base, sequence: 2, turn: turn("t1") });
    tracker.apply({ ...base, sequence: 3, turn: { ...turn("t1"), output: "updated" } });

    const state = tracker.current;
    if (state.kind !== "live") throw new Error("expected live");
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]!.output).toBe("updated");
  });

  it("stops applying state after a terminal frame", () => {
    const tracker = new PlanRefineTracker();
    tracker.apply(snapshot({ sequence: 1, highWaterSequence: 1 }));
    expect(tracker.apply({
      type: "plan_refine_terminal",
      sequence: 2,
      refineSessionId: "refine-1",
      planRequestId: "plan-1",
      operationId: 7,
      status: "applied",
    })).toBe("applied");

    const state = tracker.current;
    if (state.kind !== "live") throw new Error("expected live");
    expect(state.terminal).toBe("applied");

    expect(tracker.apply({
      type: "plan_refine_update",
      sequence: 3,
      refineSessionId: "refine-1",
      planRequestId: "plan-1",
      operationId: 7,
      revision: 3,
      status: "running",
    })).toBe("terminal");
    if (tracker.current.kind !== "live") throw new Error("expected live");
    expect(tracker.current.snapshot.status).toBe("applied");
  });

  it("ignores frames from a different refine session or operation", () => {
    const tracker = new PlanRefineTracker();
    tracker.apply(snapshot({ sequence: 1, highWaterSequence: 1 }));
    expect(tracker.apply({
      type: "plan_refine_update",
      sequence: 2,
      refineSessionId: "other-session",
      planRequestId: "plan-1",
      operationId: 7,
      revision: 2,
      status: "running",
    })).toBe("ignored");
    expect(tracker.apply({
      type: "plan_refine_update",
      sequence: 2,
      refineSessionId: "refine-1",
      planRequestId: "plan-1",
      operationId: 99,
      revision: 2,
      status: "running",
    })).toBe("ignored");
  });

  it("requests a snapshot when a frame arrives before any baseline", () => {
    const reasons: string[] = [];
    const tracker = new PlanRefineTracker({ requestSnapshot: (reason) => reasons.push(reason) });
    expect(tracker.apply({
      type: "plan_refine_update",
      sequence: 1,
      refineSessionId: "refine-1",
      planRequestId: "plan-1",
      operationId: 7,
      revision: 2,
      status: "running",
    })).toBe("gap");
    expect(reasons).toEqual(["unknown"]);
  });

  it("records action results by actionId and keeps them across updates", () => {
    const tracker = new PlanRefineTracker();
    tracker.apply(snapshot({ sequence: 1, highWaterSequence: 1 }));
    tracker.apply({
      type: "plan_refine_action_result",
      sequence: 2,
      refineSessionId: "refine-1",
      planRequestId: "plan-1",
      operationId: 7,
      actionId: "a-1",
      status: "accepted",
    });
    tracker.apply({
      type: "plan_refine_update",
      sequence: 3,
      refineSessionId: "refine-1",
      planRequestId: "plan-1",
      operationId: 7,
      revision: 2,
      status: "running",
    });
    const state = tracker.current;
    if (state.kind !== "live") throw new Error("expected live");
    expect(state.actionResults.get("a-1")?.status).toBe("accepted");
  });
});
