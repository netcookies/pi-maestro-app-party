/**
 * Host↔Mobile Review & Refine protocol.
 *
 * This module is the single authority for the Mobile-facing refine contract.
 * The Desktop Plugin/Broker wire schema lives in `@maestro-mobile/shared`; the
 * Host is responsible for translating between the two. Nothing here may import
 * the Shared Desktop protocol.
 *
 * Flow remains the business authority for role subagents, model resolution,
 * Plan revisions, Artifacts, and terminal outcomes. Frames below only carry that
 * authoritative state to the phone and relay user intent back.
 */

export type MobilePlanRefineRole = "reviewer" | "decomposer" | "optimizer" | "brainstormer";
export type MobilePlanRefineApplyKind = "feedback" | "draft";
export type MobilePlanRefineTerminalStatus =
  | "applied"
  | "discarded"
  | "cancelled"
  | "failed"
  | "revision_conflict"
  | "disconnected";
export type MobilePlanRefineStatus = "opening" | "ready" | "running" | MobilePlanRefineTerminalStatus;

export const MOBILE_PLAN_REFINE_CAPABILITY = "plan_refine" as const;

export const MOBILE_PLAN_REFINE_MAX_OUTPUT_LENGTH = 64_000;
export const MOBILE_PLAN_REFINE_MAX_ACTION_TEXT_LENGTH = 16_384;

export type MobilePlanRefineErrorCode =
  | "capability_mismatch"
  | "target_mismatch"
  | "revision_conflict"
  | "invalid_state"
  | "session_terminal"
  | "sequence_gap"
  | "deadline_exceeded"
  | "disconnected"
  | "run_failed"
  | "apply_failed";

export interface MobilePlanRefineModelOption {
  id: string;
  name: string;
}

export interface MobilePlanRefineTurn {
  turnId: string;
  role: MobilePlanRefineRole;
  model: string;
  modelLabel: string;
  userInput: string;
  output: string;
  appliesAs: MobilePlanRefineApplyKind;
  createdAt: string;
}

/**
 * Complete authoritative state for one refine session. A client that receives a
 * snapshot replaces its whole local projection; it never merges field by field.
 */
export interface MobilePlanRefineSnapshot {
  type: "plan_refine_snapshot";
  /** Refine-scoped ordering, starting at 1 for the session. */
  sequence: number;
  highWaterSequence: number;
  refineSessionId: string;
  planRequestId: string;
  operationId: number;
  revision: number;
  status: MobilePlanRefineStatus;
  markdown: string;
  turns: MobilePlanRefineTurn[];
  currentRole: MobilePlanRefineRole;
  currentModel: string;
  modelOptions: MobilePlanRefineModelOption[];
  availableActions: MobilePlanRefineAvailableAction[];
}

export type MobilePlanRefineAvailableAction =
  | "select_role"
  | "select_model"
  | "run"
  | "apply"
  | "discard"
  | "cancel";

export interface MobilePlanRefineUpdate {
  type: "plan_refine_update";
  sequence: number;
  refineSessionId: string;
  planRequestId: string;
  operationId: number;
  revision: number;
  status: MobilePlanRefineStatus;
  turn?: MobilePlanRefineTurn;
  error?: { code: MobilePlanRefineErrorCode; message?: string };
}

export interface MobilePlanRefineActionResult {
  type: "plan_refine_action_result";
  sequence: number;
  refineSessionId: string;
  planRequestId: string;
  operationId: number;
  actionId: string;
  status: "accepted" | "succeeded" | "rejected" | "failed";
  turnId?: string;
  error?: { code: MobilePlanRefineErrorCode; message?: string };
}

export interface MobilePlanRefineTerminal {
  type: "plan_refine_terminal";
  sequence: number;
  refineSessionId: string;
  planRequestId: string;
  operationId: number;
  status: MobilePlanRefineTerminalStatus;
  error?: { code: MobilePlanRefineErrorCode; message?: string };
}

export type MobilePlanRefineEvent =
  | MobilePlanRefineSnapshot
  | MobilePlanRefineUpdate
  | MobilePlanRefineActionResult
  | MobilePlanRefineTerminal;

export type MobilePlanRefineActionPayload =
  | { action: "select_role"; role: MobilePlanRefineRole }
  | { action: "select_model"; model: string }
  | { action: "run"; userInput: string }
  | { action: "apply"; turnId: string }
  | { action: "discard" }
  | { action: "cancel" }
  | { action: "snapshot" };

/**
 * Client→Host refine intent. `actionId` is the idempotency key: the Host must
 * return the first action result for a repeated `(refineSessionId, actionId)`
 * instead of executing it twice.
 */
export interface MobilePlanRefineAction {
  type: "plan_refine_action";
  refineSessionId: string;
  planRequestId: string;
  operationId: number;
  revision: number;
  actionId: string;
  action: MobilePlanRefineActionPayload;
}

export function isMobilePlanRefineRole(value: unknown): value is MobilePlanRefineRole {
  return value === "reviewer" || value === "decomposer" || value === "optimizer" || value === "brainstormer";
}

export function isMobilePlanRefineTerminalStatus(value: unknown): value is MobilePlanRefineTerminalStatus {
  return value === "applied" || value === "discarded" || value === "cancelled"
    || value === "failed" || value === "revision_conflict" || value === "disconnected";
}

export function isMobilePlanRefineStatus(value: unknown): value is MobilePlanRefineStatus {
  return value === "opening" || value === "ready" || value === "running" || isMobilePlanRefineTerminalStatus(value);
}

export function isMobilePlanRefineErrorCode(value: unknown): value is MobilePlanRefineErrorCode {
  return value === "capability_mismatch" || value === "target_mismatch" || value === "revision_conflict"
    || value === "invalid_state" || value === "session_terminal" || value === "sequence_gap"
    || value === "deadline_exceeded" || value === "disconnected" || value === "run_failed"
    || value === "apply_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSequence(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 1;
}

function isErrorEnvelope(value: unknown): boolean {
  if (value === undefined) return true;
  return isRecord(value) && isMobilePlanRefineErrorCode(value.code)
    && (value.message === undefined || isString(value.message));
}

function isTurn(value: unknown): value is MobilePlanRefineTurn {
  return isRecord(value)
    && isString(value.turnId) && value.turnId.length > 0
    && isMobilePlanRefineRole(value.role)
    && isString(value.model)
    && isString(value.modelLabel)
    && isString(value.userInput)
    && isString(value.output)
    && (value.output as string).length <= MOBILE_PLAN_REFINE_MAX_OUTPUT_LENGTH
    && (value.appliesAs === "feedback" || value.appliesAs === "draft")
    && isString(value.createdAt);
}

function isModelOption(value: unknown): value is MobilePlanRefineModelOption {
  return isRecord(value) && isString(value.id) && isString(value.name);
}

function isAvailableAction(value: unknown): value is MobilePlanRefineAvailableAction {
  return value === "select_role" || value === "select_model" || value === "run"
    || value === "apply" || value === "discard" || value === "cancel";
}

export function isMobilePlanRefineSnapshot(value: unknown): value is MobilePlanRefineSnapshot {
  return isRecord(value) && value.type === "plan_refine_snapshot"
    && isSequence(value.sequence) && isSequence(value.highWaterSequence)
    && isString(value.refineSessionId) && value.refineSessionId.length > 0
    && isString(value.planRequestId)
    && isFiniteNumber(value.operationId)
    && isFiniteNumber(value.revision) && value.revision >= 0
    && isMobilePlanRefineStatus(value.status)
    && isString(value.markdown)
    && Array.isArray(value.turns) && value.turns.every(isTurn)
    && isMobilePlanRefineRole(value.currentRole)
    && isString(value.currentModel)
    && Array.isArray(value.modelOptions) && value.modelOptions.every(isModelOption)
    && Array.isArray(value.availableActions) && value.availableActions.every(isAvailableAction);
}

export function isMobilePlanRefineUpdate(value: unknown): value is MobilePlanRefineUpdate {
  return isRecord(value) && value.type === "plan_refine_update"
    && isSequence(value.sequence)
    && isString(value.refineSessionId) && value.refineSessionId.length > 0
    && isString(value.planRequestId)
    && isFiniteNumber(value.operationId)
    && isFiniteNumber(value.revision) && value.revision >= 0
    && isMobilePlanRefineStatus(value.status)
    && (value.turn === undefined || isTurn(value.turn))
    && isErrorEnvelope(value.error);
}

export function isMobilePlanRefineActionResult(value: unknown): value is MobilePlanRefineActionResult {
  return isRecord(value) && value.type === "plan_refine_action_result"
    && isSequence(value.sequence)
    && isString(value.refineSessionId) && value.refineSessionId.length > 0
    && isString(value.planRequestId)
    && isFiniteNumber(value.operationId)
    && isString(value.actionId) && value.actionId.length > 0
    && (value.status === "accepted" || value.status === "succeeded"
      || value.status === "rejected" || value.status === "failed")
    && (value.turnId === undefined || isString(value.turnId))
    && isErrorEnvelope(value.error);
}

export function isMobilePlanRefineTerminal(value: unknown): value is MobilePlanRefineTerminal {
  return isRecord(value) && value.type === "plan_refine_terminal"
    && isSequence(value.sequence)
    && isString(value.refineSessionId) && value.refineSessionId.length > 0
    && isString(value.planRequestId)
    && isFiniteNumber(value.operationId)
    && isMobilePlanRefineTerminalStatus(value.status)
    && isErrorEnvelope(value.error);
}

export function isMobilePlanRefineEvent(value: unknown): value is MobilePlanRefineEvent {
  return isMobilePlanRefineSnapshot(value)
    || isMobilePlanRefineUpdate(value)
    || isMobilePlanRefineActionResult(value)
    || isMobilePlanRefineTerminal(value);
}

export function isMobilePlanRefineAction(value: unknown): value is MobilePlanRefineAction {
  if (!isRecord(value) || value.type !== "plan_refine_action") return false;
  if (!isString(value.refineSessionId) || !value.refineSessionId) return false;
  if (!isString(value.planRequestId)) return false;
  if (!isFiniteNumber(value.operationId)) return false;
  if (!isFiniteNumber(value.revision) || value.revision < 0) return false;
  if (!isString(value.actionId) || !value.actionId) return false;
  const action = value.action;
  if (!isRecord(action) || !isString(action.action)) return false;
  switch (action.action) {
    case "select_role":
      return isMobilePlanRefineRole(action.role);
    case "select_model":
      return isString(action.model) && action.model.length > 0;
    case "run":
      return isString(action.userInput)
        && action.userInput.length <= MOBILE_PLAN_REFINE_MAX_ACTION_TEXT_LENGTH;
    case "apply":
      return isString(action.turnId) && action.turnId.length > 0;
    case "discard":
    case "cancel":
    case "snapshot":
      return true;
    default:
      return false;
  }
}
