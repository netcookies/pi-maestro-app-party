import { describe, expect, it } from "vitest";
import type { PlanRefineState } from "@maestro-mobile/mobile-sdk";
import { shouldClearRefiningPlan } from "../src/plan-refine-cleanup";

function live(status: string, revision = 1): PlanRefineState {
  return {
    kind: "live",
    snapshot: {
      type: "plan_refine_snapshot",
      refineSessionId: "rs-1",
      planRequestId: "plan-1",
      operationId: 1,
      revision,
      sequence: 1,
      status,
      markdown: "# plan",
      session: { currentRole: "reviewer", currentModel: { model: "p/m", label: "p/m" } },
      turns: [],
      highWaterSequence: 1,
      target: { sessionId: "s-1", endpointId: "ep-1", normalizedCwd: "/work", processGeneration: "g1" },
    } as never,
    turns: [],
    expectedSequence: 2,
    actionResults: new Map(),
  };
}

const target = "s-1:ep-1:/work:g1";

describe("shouldClearRefiningPlan", () => {
  it("keeps the stored plan while the same-target refine is still live", () => {
    expect(shouldClearRefiningPlan({
      refineState: live("running"),
      refineTargetKey: target,
      selectedTargetKey: target,
      refiningPlanRevision: 1,
      hasPendingPlanRequest: false,
    })).toBe(false);
  });

  it("clears once the refine reaches a terminal status", () => {
    for (const status of ["applied", "discarded", "cancelled", "failed", "revision_conflict", "disconnected"]) {
      expect(shouldClearRefiningPlan({
        refineState: live(status),
        refineTargetKey: target,
        selectedTargetKey: target,
        refiningPlanRevision: 1,
        hasPendingPlanRequest: true,
      })).toBe(true);
    }
  });

  it("clears when the plan is gone from the queue and nothing is refining", () => {
    expect(shouldClearRefiningPlan({
      refineState: { kind: "idle" },
      refineTargetKey: undefined,
      selectedTargetKey: target,
      refiningPlanRevision: 1,
      hasPendingPlanRequest: false,
    })).toBe(true);
  });

  it("keeps a pending plan that is not the refining target", () => {
    expect(shouldClearRefiningPlan({
      refineState: live("running"),
      refineTargetKey: "s-2:ep-2:/other:g2",
      selectedTargetKey: target,
      refiningPlanRevision: 1,
      hasPendingPlanRequest: true,
    })).toBe(false);
  });

  it("clears when the refine snapshot moved to a newer plan revision", () => {
    expect(shouldClearRefiningPlan({
      refineState: live("ready", 2),
      refineTargetKey: target,
      selectedTargetKey: target,
      refiningPlanRevision: 1,
      hasPendingPlanRequest: false,
    })).toBe(true);
  });

  it("does not clear another exact target's terminal refine", () => {
    expect(shouldClearRefiningPlan({
      refineState: live("applied"),
      refineTargetKey: "s-2:ep-2:/other:g2",
      selectedTargetKey: target,
      refiningPlanRevision: 1,
      hasPendingPlanRequest: true,
    })).toBe(false);
  });
});
