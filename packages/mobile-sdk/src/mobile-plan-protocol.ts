export type DesktopPlanExecutionBackend = "standalone" | "workflow";
export type DesktopPlanExecutionContext = "current" | "compact";
export type DesktopPlanWorkflowTarget = "current" | "new";

export interface DesktopPlanExecutionChoice {
  backend: DesktopPlanExecutionBackend;
  context: DesktopPlanExecutionContext;
  workflowTarget?: DesktopPlanWorkflowTarget;
  sourceDocument?: string;
}

export interface DesktopPlanWorkflowTargetInfo {
  sessionId: string;
  intent: string;
  available: boolean;
  reason?: string;
}

export interface DesktopPlanWorkflowOptions {
  current?: DesktopPlanWorkflowTargetInfo;
  allowNew: boolean;
}

export interface DesktopPlanModelTransition {
  current: string;
  act?: string;
}

export interface DesktopPlanDraft {
  revision: number;
  archivedAt: string;
  checksum: string;
}

export interface DesktopPlanRequest {
  type: "desktop_plan_request";
  requestId: string;
  kind: "confirm" | "review";
  sessionId: string;
  operationId: number;
  cwd: string;
  mode: string;
  sessionFile?: string;
  markdown: string;
  revision: number;
  pathLabel: string;
  availableActions: string[];
  defaultExecution?: DesktopPlanExecutionChoice;
  workflow?: DesktopPlanWorkflowOptions;
  modelTransition?: DesktopPlanModelTransition;
  decisionDocuments: string[];
  drafts: DesktopPlanDraft[];
}

export interface DesktopPlanDecision {
  action: string;
  execution?: DesktopPlanExecutionChoice;
  discussion?: string;
}

export type DesktopPlanResponse =
  | { type: "desktop_plan_response"; requestId: string; kind: "confirm" | "review"; status: "decision"; decision: DesktopPlanDecision }
  | { type: "desktop_plan_response"; requestId: string; kind: "confirm" | "review"; status: "edited"; markdown: string; expectedRevision: number }
  | { type: "desktop_plan_response"; requestId: string; kind: "confirm" | "review"; status: "cancelled" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isExecutionChoice(value: unknown): value is DesktopPlanExecutionChoice {
  if (!isRecord(value) || (value.backend !== "standalone" && value.backend !== "workflow") || (value.context !== "current" && value.context !== "compact")) return false;
  if (value.sourceDocument !== undefined && !isString(value.sourceDocument)) return false;
  return value.backend === "standalone"
    ? value.workflowTarget === undefined
    : value.workflowTarget === "current" || value.workflowTarget === "new";
}

function isWorkflow(value: unknown): value is DesktopPlanWorkflowOptions {
  if (!isRecord(value) || typeof value.allowNew !== "boolean") return false;
  if (value.current === undefined) return true;
  return isRecord(value.current) && isString(value.current.sessionId) && isString(value.current.intent)
    && typeof value.current.available === "boolean"
    && (value.current.reason === undefined || isString(value.current.reason));
}

function isDraft(value: unknown): value is DesktopPlanDraft {
  return isRecord(value) && isNonNegativeInteger(value.revision) && isString(value.archivedAt) && isString(value.checksum);
}

function isDecision(value: unknown): value is DesktopPlanDecision {
  return isRecord(value) && isString(value.action)
    && (value.discussion === undefined || isString(value.discussion))
    && (value.execution === undefined || isExecutionChoice(value.execution));
}

export function isDesktopPlanRequest(value: unknown): value is DesktopPlanRequest {
  return isRecord(value)
    && isString(value.requestId) && (value.kind === "confirm" || value.kind === "review")
    && isString(value.sessionId) && isNonNegativeInteger(value.operationId)
    && isString(value.cwd) && isString(value.mode)
    && (value.sessionFile === undefined || isString(value.sessionFile))
    && isString(value.markdown) && isNonNegativeInteger(value.revision)
    && isString(value.pathLabel)
    && Array.isArray(value.availableActions) && value.availableActions.every(isString)
    && (value.defaultExecution === undefined || isExecutionChoice(value.defaultExecution))
    && (value.workflow === undefined || isWorkflow(value.workflow))
    && (value.modelTransition === undefined || (isRecord(value.modelTransition) && isString(value.modelTransition.current)
      && (value.modelTransition.act === undefined || isString(value.modelTransition.act))))
    && Array.isArray(value.decisionDocuments) && value.decisionDocuments.every(isString)
    && Array.isArray(value.drafts) && value.drafts.every(isDraft);
}

export function isDesktopPlanResponse(value: unknown): value is DesktopPlanResponse {
  if (!isRecord(value) || !isString(value.requestId) || (value.kind !== "confirm" && value.kind !== "review")) return false;
  if (value.status === "cancelled") return true;
  if (value.status === "edited") return isString(value.markdown) && isNonNegativeInteger(value.expectedRevision);
  return value.status === "decision" && isDecision(value.decision);
}
