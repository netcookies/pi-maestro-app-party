/**
 * Explicit Host projection between the Mobile SDK refine contract and the
 * Desktop Plugin/Broker refine wire contract.
 *
 * The two protocols have different owners, so the mapping is written out field by
 * field. Nothing is inferred from `sessionId`, and no field is invented: a target
 * that cannot be mapped exactly is rejected instead of being approximated.
 */

import type {
  DesktopPlanRefineAction,
  DesktopPlanRefineActionPayload,
  DesktopPlanRefineRole,
  DesktopPluginTarget,
} from "@maestro-mobile/shared";
import type {
  MobilePlanRefineAction,
  MobilePlanRefineActionPayload,
  MobilePlanRefineRole,
} from "@maestro-mobile/mobile-sdk/protocol";
import type { SessionTargetIdentity } from "../control/SessionDirectory.js";

const ROLES: Record<MobilePlanRefineRole, DesktopPlanRefineRole> = {
  reviewer: "reviewer",
  decomposer: "decomposer",
  optimizer: "optimizer",
  brainstormer: "brainstormer",
};

/**
 * Map the four-field Mobile target to the Desktop Plugin target.
 * Returns undefined when any field is missing rather than fabricating one.
 */
export function toDesktopTarget(target: SessionTargetIdentity): DesktopPluginTarget | undefined {
  if (!target.sessionId || !target.endpointId || !target.normalizedCwd || !target.processGeneration) return undefined;
  return {
    sessionId: target.sessionId,
    endpointId: target.endpointId,
    normalizedCwd: target.normalizedCwd,
    processGeneration: target.processGeneration,
  };
}

function toDesktopAction(action: MobilePlanRefineActionPayload): DesktopPlanRefineActionPayload | undefined {
  switch (action.action) {
    case "select_role":
      return { action: "select_role", role: ROLES[action.role] };
    case "select_model":
      return { action: "select_model", model: action.model };
    case "run":
      return { action: "run", userInput: action.userInput };
    case "apply":
      return { action: "apply", turnId: action.turnId };
    case "discard":
      return { action: "discard" };
    case "cancel":
      return { action: "cancel" };
    case "snapshot":
      return { action: "snapshot" };
    default:
      return undefined;
  }
}

/** Project one SDK refine action onto the Desktop wire frame. */
export function toDesktopRefineAction(
  refine: MobilePlanRefineAction,
  target: SessionTargetIdentity,
): DesktopPlanRefineAction | undefined {
  const desktopTarget = toDesktopTarget(target);
  if (!desktopTarget) return undefined;
  const action = toDesktopAction(refine.action);
  if (!action) return undefined;
  return {
    type: "desktop_plan_refine_action",
    target: desktopTarget,
    refineSessionId: refine.refineSessionId,
    planRequestId: refine.planRequestId,
    operationId: refine.operationId,
    revision: refine.revision,
    actionId: refine.actionId,
    action,
  };
}
