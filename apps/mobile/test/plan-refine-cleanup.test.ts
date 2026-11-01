import { describe, expect, it } from "vitest";
import type { PlanRefineState } from "@maestro-mobile/mobile-sdk";
import { shouldClearRefiningPlan } from "../src/plan-refine-cleanup";

function live(status: string, revision = 1, planRequestId = "plan-1"): PlanRefineState {
  return {
    kind: "live",
    snapshot: {
      type: "plan_refine_snapshot",
      refineSessionId: "rs-1",
      planRequestId,
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
const otherTarget = "s-1:ep-2:/work:g2";

describe("shouldClearRefiningPlan", () => {
  it("keeps the stored plan while the same-target refine is still live", () => {
    expect(shouldClearRefiningPlan({
      refineState: live("running"),
      refineTargetKey: target,
      selectedTargetKey: target,
      refiningPlanTargetKey: target,
      refiningPlanRequestId: "plan-1",
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
        refiningPlanTargetKey: target,
        refiningPlanRequestId: "plan-1",
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
      refiningPlanTargetKey: target,
      refiningPlanRequestId: "plan-1",
      refiningPlanRevision: 1,
      hasPendingPlanRequest: false,
    })).toBe(true);
  });

  it("clears if the stored plan belongs to a different exact target than the selected target", () => {
    // REV2-001 核心修复：即使 hasPendingPlanRequest 为 true，只要 selectedTarget 与 refiningPlanTarget 不一致就必须清理
    expect(shouldClearRefiningPlan({
      refineState: live("running"),
      refineTargetKey: otherTarget,
      selectedTargetKey: target,
      refiningPlanTargetKey: otherTarget,
      refiningPlanRequestId: "plan-1",
      refiningPlanRevision: 1,
      hasPendingPlanRequest: true,
    })).toBe(true);
  });

  it("clears when the refine snapshot moved to a newer plan revision", () => {
    expect(shouldClearRefiningPlan({
      refineState: live("ready", 2),
      refineTargetKey: target,
      selectedTargetKey: target,
      refiningPlanTargetKey: target,
      refiningPlanRequestId: "plan-1",
      refiningPlanRevision: 1,
      hasPendingPlanRequest: false,
    })).toBe(true);
  });

  it("clears if the refine snapshot belongs to a different plan request ID", () => {
    expect(shouldClearRefiningPlan({
      refineState: live("ready", 1, "different-plan-request"),
      refineTargetKey: target,
      selectedTargetKey: target,
      refiningPlanTargetKey: target,
      refiningPlanRequestId: "plan-1",
      refiningPlanRevision: 1,
      hasPendingPlanRequest: false,
    })).toBe(true);
  });

  it("does not clear when pending on the same target while refine is not terminal", () => {
    expect(shouldClearRefiningPlan({
      refineState: live("ready"),
      refineTargetKey: target,
      selectedTargetKey: target,
      refiningPlanTargetKey: target,
      refiningPlanRequestId: "plan-1",
      refiningPlanRevision: 1,
      hasPendingPlanRequest: true,
    })).toBe(false);
  });
});
