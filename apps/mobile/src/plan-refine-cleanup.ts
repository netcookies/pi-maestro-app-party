/**
 * 本地 refiningPlan 的清理判定（纯函数，便于单测覆盖）。
 *
 * 背景：Review & Refine 的弹窗由 `visiblePlan`（pending plan 或本地暂存的 refiningPlan）驱动。
 * apply / discard / cancel 之后 Flow 会继续推进 plan 版本，若本地暂存不被清理，弹窗会挂在
 * 旧版本的 refine 面板上。
 *
 * 判定规则：
 * - plan 仍在队列中且 refine 处于同目标的非终态 → 保留；
 * - refine 已终态、已切到别的 exact target、或版本已推进 → 清理。
 */
import { isMobilePlanRefineTerminalStatus } from "@maestro-mobile/mobile-sdk/protocol";
import type { PlanRefineState } from "@maestro-mobile/mobile-sdk";

export interface RefineCleanupInput {
  readonly refineState: PlanRefineState | undefined;
  /** `sessionTargetKey(refineTarget)`，refine 事件的 exact target。 */
  readonly refineTargetKey: string | undefined;
  /** 当前页面选中的 exact target key。 */
  readonly selectedTargetKey: string | undefined;
  /** 本地暂存 plan 的 revision；缺失表示没有暂存 plan。 */
  readonly refiningPlanRevision: number | undefined;
  /** 该 plan request 是否仍在 plan 队列中 pending。 */
  readonly hasPendingPlanRequest: boolean;
}

export function shouldClearRefiningPlan(input: RefineCleanupInput): boolean {
  const live = input.refineState?.kind === "live" ? input.refineState : undefined;
  const sameTarget = Boolean(
    input.refineTargetKey && input.selectedTargetKey && input.refineTargetKey === input.selectedTargetKey,
  );
  const terminal = live !== undefined && isMobilePlanRefineTerminalStatus(live.snapshot.status);
  if (input.hasPendingPlanRequest) {
    // plan 还在等裁决：只有当同目标的 refine 已经终结时才需要丢弃本地暂存。
    return Boolean(live && sameTarget && terminal);
  }
  const refineLive = live !== undefined
    && sameTarget
    && !terminal
    && (input.refiningPlanRevision === undefined || live.snapshot.revision === input.refiningPlanRevision);
  return !refineLive;
}
