/**
 * 本地 refiningPlan 的清理判定（纯函数，便于单测覆盖）。
 *
 * 背景：Review & Refine 的弹窗由 `visiblePlan`（pending plan 或本地暂存的 refiningPlan）驱动。
 * apply / discard / cancel 之后 Flow 会继续推进 plan 版本，若本地暂存不被清理，弹窗会挂在
 * 旧版本的 refine 面板上；若切换到同一 session ID 但不同 target 的页面，也不得泄漏。
 *
 * 判定规则：
 * - 暂存 plan 的 target 与当前选中的 exact target 不匹配 → 清理；
 * - plan 仍在队列中等待裁决：同目标的 refine 达到终态 → 清理；
 * - plan 已移出队列：只有同目标且 request/revision 完全吻合的非终态 refine 才保留，否则清理。
 */
import { isMobilePlanRefineTerminalStatus } from "@maestro-mobile/mobile-sdk/protocol";
import type { PlanRefineState } from "@maestro-mobile/mobile-sdk";

export interface RefineCleanupInput {
  readonly refineState: PlanRefineState | undefined;
  /** `sessionTargetKey(refineTarget)`，refine 事件的 exact target。 */
  readonly refineTargetKey: string | undefined;
  /** 当前页面选中的 exact target key。 */
  readonly selectedTargetKey: string | undefined;
  /** 本地暂存 plan 的 target key（若存在）。 */
  readonly refiningPlanTargetKey?: string | undefined;
  /** 本地暂存 plan 的 requestId。 */
  readonly refiningPlanRequestId?: string | undefined;
  /** 本地暂存 plan 的 revision；缺失表示没有暂存 plan。 */
  readonly refiningPlanRevision?: number | undefined;
  /** 该 plan request 是否仍在 plan 队列中 pending。 */
  readonly hasPendingPlanRequest: boolean;
}

export function shouldClearRefiningPlan(input: RefineCleanupInput): boolean {
  // 1. Target 隔离：若暂存 plan 记录了 exact target，且当前已选 target 与之不一致，立即清理。
  if (input.refiningPlanTargetKey && input.selectedTargetKey && input.refiningPlanTargetKey !== input.selectedTargetKey) {
    return true;
  }

  const live = input.refineState?.kind === "live" ? input.refineState : undefined;
  const sameTarget = Boolean(
    input.refineTargetKey && input.selectedTargetKey && input.refineTargetKey === input.selectedTargetKey,
  );
  const terminal = live !== undefined && isMobilePlanRefineTerminalStatus(live.snapshot.status);

  // 2. 若 plan 还在等裁决（pending）：只有当同目标的 refine 已经达到终态时才丢弃本地暂存。
  if (input.hasPendingPlanRequest) {
    const isMatchingRequest = input.refiningPlanRequestId === undefined || live?.snapshot.planRequestId === input.refiningPlanRequestId;
    return Boolean(live && sameTarget && terminal && isMatchingRequest);
  }

  // 3. 若 plan 已不在 pending 队列（例如已提交/已取消）：
  // 只有当同目标、同 request、同 revision 的 refine 仍处于 live 非终态时才保留，否则清理。
  const isMatchingRefineLive = live !== undefined
    && sameTarget
    && !terminal
    && (input.refiningPlanRequestId === undefined || live.snapshot.planRequestId === input.refiningPlanRequestId)
    && (input.refiningPlanRevision === undefined || live.snapshot.revision === input.refiningPlanRevision);
  return !isMatchingRefineLive;
}
