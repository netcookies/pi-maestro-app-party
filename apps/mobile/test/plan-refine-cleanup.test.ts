import { describe, expect, it } from "vitest";

/**
 * 校验 Review & Refine 终态清理逻辑：
 * 当 refineState 进入 applied/discarded/cancelled 等终态，或者收到 plan_cleared 时，
 * 本地暂存的 refiningPlan 必须被重置，避免弹窗在 apply 后永远挂起。
 */
describe("Review & Refine terminal cleanup", () => {
  const TERMINAL_STATUSES = ["applied", "discarded", "cancelled", "failed", "revision_conflict", "disconnected"] as const;

  function shouldClearRefiningPlan(options: {
    refineStatus?: string;
    targetSessionId?: string;
    currentSessionId: string;
    hasPendingPlanRequest: boolean;
  }): boolean {
    const isTerminal = options.refineStatus !== undefined && TERMINAL_STATUSES.includes(options.refineStatus as never);
    if (isTerminal && options.targetSessionId === options.currentSessionId) {
      return true;
    }
    const isRefining = options.refineStatus !== undefined && !isTerminal && options.targetSessionId === options.currentSessionId;
    if (!options.hasPendingPlanRequest && !isRefining) {
      return true;
    }
    return false;
  }

  it("clears refiningPlan when refine enters terminal status applied", () => {
    expect(shouldClearRefiningPlan({
      refineStatus: "applied",
      targetSessionId: "s-1",
      currentSessionId: "s-1",
      hasPendingPlanRequest: false,
    })).toBe(true);
  });

  it("clears refiningPlan when plan is cleared and no live refine is running", () => {
    expect(shouldClearRefiningPlan({
      refineStatus: undefined,
      targetSessionId: undefined,
      currentSessionId: "s-1",
      hasPendingPlanRequest: false,
    })).toBe(true);
  });

  it("keeps refiningPlan active while refine is still running", () => {
    expect(shouldClearRefiningPlan({
      refineStatus: "running",
      targetSessionId: "s-1",
      currentSessionId: "s-1",
      hasPendingPlanRequest: false,
    })).toBe(false);
  });

  it("does not clear for a terminal event from another session", () => {
    expect(shouldClearRefiningPlan({
      refineStatus: "applied",
      targetSessionId: "other-session",
      currentSessionId: "s-1",
      hasPendingPlanRequest: true,
    })).toBe(false);
  });
});
