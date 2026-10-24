/**
 * Project Desktop Plugin/Broker refine wire frames into canonical Mobile SDK
 * HostEvent envelopes.
 *
 * This mapping is Host-owned: Shared does not know about Mobile SDK events, and
 * the SDK does not import Shared. All fields are translated explicitly.
 */

import type {
  DesktopPlanRefineRole,
  DesktopPlanRefineSnapshot,
  DesktopPlanRefineTurn,
  DesktopPlanRefineUpdate,
  DesktopPluginTarget,
} from "@maestro-mobile/shared";
import type {
  HostEvent,
  MobilePlanRefineAvailableAction,
  MobilePlanRefineErrorCode,
  MobilePlanRefineRole,
  MobilePlanRefineSnapshot,
  MobilePlanRefineTurn,
  MobilePlanRefineUpdate,
  MobilePlanRefineActionResult,
  SessionTargetIdentity,
} from "@maestro-mobile/mobile-sdk/protocol";

const ROLES: Record<DesktopPlanRefineRole, MobilePlanRefineRole> = {
  reviewer: "reviewer",
  decomposer: "decomposer",
  optimizer: "optimizer",
  brainstormer: "brainstormer",
};

export function toMobileTarget(target: DesktopPluginTarget): SessionTargetIdentity {
  return {
    sessionId: target.sessionId,
    endpointId: target.endpointId,
    normalizedCwd: target.normalizedCwd,
    processGeneration: target.processGeneration,
  };
}

function toMobileTurn(turn: DesktopPlanRefineTurn): MobilePlanRefineTurn {
  return {
    turnId: turn.turnId,
    role: ROLES[turn.role],
    model: turn.model,
    modelLabel: turn.model,
    userInput: turn.userInput ?? "",
    output: turn.output ?? "",
    appliesAs: turn.appliesAs,
    createdAt: new Date(turn.createdAt).toISOString(),
  };
}

function toMobileActions(
  actions: DesktopPlanRefineSnapshot["availableActions"],
): MobilePlanRefineAvailableAction[] {
  return actions.filter(
    (action): action is MobilePlanRefineAvailableAction =>
      action === "select_role" || action === "select_model" || action === "run"
      || action === "apply" || action === "discard" || action === "cancel",
  );
}

export function toMobileSnapshot(
  snapshot: DesktopPlanRefineSnapshot,
): MobilePlanRefineSnapshot {
  return {
    type: "plan_refine_snapshot",
    sequence: snapshot.sequence,
    highWaterSequence: snapshot.sequence,
    refineSessionId: snapshot.refineSessionId,
    planRequestId: snapshot.planRequestId,
    operationId: snapshot.operationId,
    revision: snapshot.revision,
    status: snapshot.status,
    markdown: snapshot.markdown,
    turns: snapshot.turns.map(toMobileTurn),
    currentRole: ROLES[snapshot.currentRole],
    currentModel: snapshot.currentModel,
    modelOptions: snapshot.modelOptions.map((opt) => ({ id: opt.id, name: opt.name })),
    availableActions: toMobileActions(snapshot.availableActions),
  };
}

export function toMobileUpdate(
  update: DesktopPlanRefineUpdate,
): MobilePlanRefineUpdate {
  return {
    type: "plan_refine_update",
    sequence: update.sequence,
    refineSessionId: update.refineSessionId,
    planRequestId: update.planRequestId,
    operationId: update.operationId,
    revision: update.revision,
    status: update.status,
    turn: update.turn ? toMobileTurn(update.turn) : undefined,
    error: update.error
      ? { code: (update.error.code as MobilePlanRefineErrorCode) || "run_failed", message: update.error.message }
      : undefined,
  };
}

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

export function toMobileRefineHostEvent(
  target: DesktopPluginTarget,
  message: DesktopPlanRefineSnapshot | DesktopPlanRefineUpdate,
): DistributiveOmit<HostEvent, "seq"> | undefined {
  const mobileTarget = toMobileTarget(target);
  if (message.type === "desktop_plan_refine_snapshot") {
    return {
      type: "plan_refine_snapshot",
      sessionId: target.sessionId,
      target: mobileTarget,
      snapshot: toMobileSnapshot(message),
    };
  }
  if (message.type === "desktop_plan_refine_update") {
    if (message.status === "applied" || message.status === "discarded" || message.status === "cancelled"
      || message.status === "failed" || message.status === "revision_conflict" || message.status === "disconnected") {
      return {
        type: "plan_refine_terminal",
        sessionId: target.sessionId,
        target: mobileTarget,
        terminal: {
          type: "plan_refine_terminal",
          sequence: message.sequence,
          refineSessionId: message.refineSessionId,
          planRequestId: message.planRequestId,
          operationId: message.operationId,
          status: message.status,
          ...(message.error ? { error: { code: (message.error.code as MobilePlanRefineErrorCode) || "run_failed", message: message.error.message } } : {}),
        },
      };
    }
  }
  if (message.type === "desktop_plan_refine_update" && message.actionResult) {
    return {
      type: "plan_refine_action_result",
      sessionId: target.sessionId,
      target: mobileTarget,
      result: {
        type: "plan_refine_action_result",
        sequence: message.sequence,
        refineSessionId: message.refineSessionId,
        planRequestId: message.planRequestId,
        operationId: message.operationId,
        actionId: message.actionResult.actionId,
        status: message.actionResult.status,
        ...(message.actionResult.turnId ? { turnId: message.actionResult.turnId } : {}),
        ...(message.actionResult.error ? { error: { code: (message.actionResult.error.code as MobilePlanRefineErrorCode) || "run_failed", message: message.actionResult.error.message } } : {}),
      } satisfies MobilePlanRefineActionResult,
    };
  }
  if (message.type === "desktop_plan_refine_update") {
    return {
      type: "plan_refine_update",
      sessionId: target.sessionId,
      target: mobileTarget,
      update: toMobileUpdate(message),
    };
  }
  return undefined;
}
