import type {
  ExtensionUiResponse,
  JsonValue,
  HostError,
  OperationStatus,
  SessionRuntimeStatus,
  SessionSummaryPatch,
  SessionExecutionSummary,
} from "./protocol.js";
import { isSessionSummaryPatch, isHostError, isBackgroundJobSummary } from "./protocol.js";

/**
 * Bump only for a breaking wire change. Additive events require ready.supportedEvents negotiation.
 */
export const DESKTOP_PLUGIN_PROTOCOL_VERSION = 2 as const;
export type DesktopPluginProtocolVersion = typeof DESKTOP_PLUGIN_PROTOCOL_VERSION;

export type DesktopPluginCapability =
  | "prompt"
  | "steer"
  | "follow_up"
  | "abort"
  | "set_model"
  | "set_thinking"
  | "list_models"
  | "list_skills"
  | "ask-user-question"
  | "plan";

/** Negotiated multi-round native Review & Refine transport. */
export const DESKTOP_PLAN_REFINE_FEATURE = "plan-refine-v1" as const;
export const DESKTOP_PLAN_REFINE_MAX_MARKDOWN_LENGTH = 256_000;
export const DESKTOP_PLAN_REFINE_MAX_OUTPUT_LENGTH = 64_000;
export const DESKTOP_PLAN_REFINE_MAX_ACTION_TEXT_LENGTH = 16_384;

export type DesktopPlanRefineRole = "reviewer" | "decomposer" | "optimizer" | "brainstormer";
export type DesktopPlanRefineApplyKind = "feedback" | "draft";
export type DesktopPlanRefineTerminalStatus = "applied" | "discarded" | "cancelled" | "failed" | "revision_conflict" | "disconnected";
export type DesktopPlanRefineStatus = "opening" | "ready" | "running" | DesktopPlanRefineTerminalStatus;

export interface DesktopPlanRefineTurn {
  turnId: string;
  role: DesktopPlanRefineRole;
  model: string;
  userInput?: string;
  output?: string;
  error?: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  appliesAs: DesktopPlanRefineApplyKind;
  createdAt: number;
}

export interface DesktopPlanRefineModelOption {
  id: string;
  name: string;
}

export interface DesktopPlanRefineSnapshot {
  type: "desktop_plan_refine_snapshot";
  target: DesktopPluginTarget;
  refineSessionId: string;
  planRequestId: string;
  operationId: number;
  revision: number;
  sequence: number;
  status: DesktopPlanRefineStatus;
  markdown: string;
  turns: DesktopPlanRefineTurn[];
  currentRole: DesktopPlanRefineRole;
  currentModel: string;
  modelOptions: DesktopPlanRefineModelOption[];
  availableActions: Array<"select_role" | "select_model" | "run" | "apply" | "discard" | "cancel">;
}

export type DesktopPlanRefineActionPayload =
  | { action: "select_role"; role: DesktopPlanRefineRole }
  | { action: "select_model"; model: string }
  | { action: "run"; userInput: string }
  | { action: "apply"; turnId: string }
  | { action: "discard" }
  | { action: "cancel" }
  | { action: "snapshot" };

export interface DesktopPlanRefineAction {
  type: "desktop_plan_refine_action";
  target: DesktopPluginTarget;
  refineSessionId: string;
  planRequestId: string;
  operationId: number;
  revision: number;
  actionId: string;
  action: DesktopPlanRefineActionPayload;
}

export type DesktopPlanRefineActionStatus = "accepted" | "succeeded" | "rejected" | "failed";

export interface DesktopPlanRefineActionResult {
  actionId: string;
  status: DesktopPlanRefineActionStatus;
  turnId?: string;
  error?: { code: string; message?: string };
}

export interface DesktopPlanRefineUpdate {
  type: "desktop_plan_refine_update";
  target: DesktopPluginTarget;
  refineSessionId: string;
  planRequestId: string;
  operationId: number;
  revision: number;
  sequence: number;
  status: DesktopPlanRefineStatus;
  turn?: DesktopPlanRefineTurn;
  actionResult?: DesktopPlanRefineActionResult;
  error?: { code: string; message?: string };
}


/** Additive Plugin-to-Broker feature, independent of Host commands. */
export const DESKTOP_PEER_FEATURE = "peer-message-v2" as const;
export const DESKTOP_PLUGIN_FEATURES = [DESKTOP_PEER_FEATURE, DESKTOP_PLAN_REFINE_FEATURE] as const;

export const DESKTOP_PEER_MAX_MESSAGE_BYTES = 16_384;
export const DESKTOP_PEER_MAX_DEADLINE_MS = 30_000;
export const DESKTOP_PEER_MAX_PEERS = 64;
export type DesktopPeerAccessDirection = "one_way" | "bidirectional";
export interface DesktopPeerAccessGrant {
  grantId: string;
  sourceCwd: string;
  targetCwd: string;
  direction: DesktopPeerAccessDirection;
  createdAt: number;
  managed: boolean;
}
export type DesktopPeerRequest =
  | { type: "desktop_peer_list"; requestId: string; deadlineAt: number }
  | { type: "desktop_peer_send"; requestId: string; deadlineAt: number; target: DesktopPluginTarget; message: string }
  | { type: "desktop_peer_access_list"; requestId: string; deadlineAt: number }
  | { type: "desktop_peer_access_grant"; requestId: string; deadlineAt: number; target: DesktopPluginTarget; direction: DesktopPeerAccessDirection }
  | { type: "desktop_peer_access_revoke"; requestId: string; deadlineAt: number; grantId: string };
export interface DesktopPeerDelivery {
  type: "desktop_peer_delivery";
  requestId: string;
  deliveryId: string;
  source: DesktopPluginTarget;
  target: DesktopPluginTarget;
  deadlineAt: number;
  message: string;
}
export interface DesktopPeerAck {
  type: "desktop_peer_ack";
  deliveryId: string;
  status: "accepted" | "rejected";
}
export interface DesktopPeerResult {
  type: "desktop_peer_result";
  requestId: string;
  status: "listed" | "accepted" | "rejected" | "failed" | "unknown" | "access_listed" | "access_granted" | "access_revoked";
  peers?: DesktopPluginTarget[];
  grants?: DesktopPeerAccessGrant[];
  grant?: DesktopPeerAccessGrant;
  authorization?: { sourceCwd: string; targetCwd: string };
  grantId?: string;
  truncated?: boolean;
  deliveryId?: string;
  error?: { code: string };
}
export function isDesktopPeerRequest(value: unknown): value is DesktopPeerRequest {
  const common = isRecord(value) && stringFields(value, "requestId") && typeof value.requestId === "string" && value.requestId.length <= 128
    && finiteNumber(value.deadlineAt);
  if (!common) return false;
  if (value.type === "desktop_peer_list" || value.type === "desktop_peer_access_list") return true;
  if (value.type === "desktop_peer_send") return isDesktopPluginTarget(value.target) && isDesktopPeerMessage(value.message);
  if (value.type === "desktop_peer_access_grant") return isDesktopPluginTarget(value.target)
    && (value.direction === "one_way" || value.direction === "bidirectional");
  return value.type === "desktop_peer_access_revoke" && typeof value.grantId === "string" && value.grantId.length > 0 && value.grantId.length <= 128;
}
function isAbsoluteNormalizedCwd(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  let separator: string;
  let tail: string;
  if (value.startsWith("/")) {
    separator = "/";
    tail = value.slice(1);
  } else {
    const root = /^(?:[A-Za-z]:\\|\\\\[^\\/]+\\[^\\/]+\\|\\(?!\\))/.exec(value);
    if (!root || value.includes("/")) return false;
    separator = "\\";
    tail = value.slice(root[0].length);
  }
  if (!tail) return true;
  if (tail.endsWith(separator)) tail = tail.slice(0, -1);
  return tail.length > 0 && tail.split(separator).every((part) => part !== "" && part !== "." && part !== "..");
}
export function isDesktopPeerAccessGrant(value: unknown): value is DesktopPeerAccessGrant {
  return isRecord(value) && stringFields(value, "grantId", "sourceCwd", "targetCwd")
    && isAbsoluteNormalizedCwd(value.sourceCwd) && isAbsoluteNormalizedCwd(value.targetCwd)
    && (value.direction === "one_way" || value.direction === "bidirectional")
    && finiteNumber(value.createdAt) && typeof value.managed === "boolean";
}
export function isDesktopPeerMessage(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && new TextEncoder().encode(value).byteLength <= DESKTOP_PEER_MAX_MESSAGE_BYTES;
}
export function isDesktopPeerDelivery(value: unknown): value is DesktopPeerDelivery {
  return isRecord(value) && value.type === "desktop_peer_delivery"
    && stringFields(value, "requestId", "deliveryId") && finiteNumber(value.deadlineAt)
    && isDesktopPluginTarget(value.source) && isDesktopPluginTarget(value.target) && isDesktopPeerMessage(value.message);
}
export function isDesktopPeerAck(value: unknown): value is DesktopPeerAck {
  return isRecord(value) && value.type === "desktop_peer_ack" && stringFields(value, "deliveryId")
    && (value.status === "accepted" || value.status === "rejected");
}
export function isDesktopPeerResult(value: unknown): value is DesktopPeerResult {
  if (!isRecord(value) || value.type !== "desktop_peer_result" || !stringFields(value, "requestId")) return false;
  if (value.deliveryId !== undefined && !stringFields(value, "deliveryId")) return false;
  if (value.status === "listed") return Array.isArray(value.peers) && value.peers.length <= DESKTOP_PEER_MAX_PEERS
    && value.peers.every(isDesktopPluginTarget) && typeof value.truncated === "boolean";
  if (value.status === "access_listed") return Array.isArray(value.grants) && value.grants.length <= DESKTOP_PEER_MAX_PEERS
    && value.grants.every(isDesktopPeerAccessGrant)
    && Array.isArray(value.peers) && value.peers.length <= DESKTOP_PEER_MAX_PEERS
    && value.peers.every(isDesktopPluginTarget) && typeof value.truncated === "boolean";
  if (value.status === "access_granted") return isDesktopPeerAccessGrant(value.grant);
  if (value.status === "access_revoked") return stringFields(value, "grantId");
  if (value.authorization !== undefined && (!isRecord(value.authorization)
    || !isAbsoluteNormalizedCwd(value.authorization.sourceCwd) || !isAbsoluteNormalizedCwd(value.authorization.targetCwd))) return false;
  if (value.status === "accepted" || value.status === "rejected") return stringFields(value, "deliveryId");
  return (value.status === "failed" || value.status === "unknown") && isRecord(value.error) && stringFields(value.error, "code");
}

export interface DesktopPluginModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  vision: boolean;
}

export interface DesktopPluginTarget {
  sessionId: string;
  endpointId: string;
  normalizedCwd: string;
  processGeneration: string;
}

export type DesktopPluginOperation =
  | { type: "prompt"; message: string; images?: Array<{ data: string; mime: string }> }
  | { type: "steer"; message: string }
  | { type: "follow_up"; message: string }
  | { type: "abort" }
  | { type: "set_model"; provider?: string; modelId: string }
  | { type: "set_thinking"; level: string }
  | { type: "list_models" }
  | { type: "list_skills" };

export interface DesktopPluginHello {
  type: "desktop_plugin_hello";
  protocolVersion: DesktopPluginProtocolVersion;
  endpointId: string;
  sessionId: string;
  normalizedCwd: string;
  /** Session JSONL owned by this exact Pi runtime. Not part of target identity. */
  sessionFile?: string;
  processGeneration: string;
  capabilities: DesktopPluginCapability[];
  features?: string[];
  clientNonce: string;
  secret: string;
  /** Release coupling is optional for older development plugins. */
  releaseVersion?: string;
}

export interface DesktopPluginRequest {
  type: "desktop_plugin_request";
  requestId: string;
  commandId: string;
  deadlineAt: number;
  target: DesktopPluginTarget;
  operation: DesktopPluginOperation;
}

export type DesktopPluginRuntimeStatus = Extract<SessionRuntimeStatus, "running" | "idle">;
export type DesktopPluginSessionSummary = Omit<SessionSummaryPatch, "runtimeStatus"> & {
  runtimeStatus: DesktopPluginRuntimeStatus;
};

/** A bounded same-process execution projection; the authenticated connection supplies its target. */
export type DesktopPluginExecutionSummary = Omit<SessionExecutionSummary, "target">;

export const DESKTOP_PLUGIN_MAX_EXECUTION_TODOS = 32 as const;
export const DESKTOP_PLUGIN_MAX_EXECUTION_AGENTS = 64 as const;
export const DESKTOP_PLUGIN_MAX_EXECUTION_BACKGROUND_JOBS = 64 as const;
export const DESKTOP_PLUGIN_MAX_EXECUTION_TEXT_LENGTH = 512 as const;

export type DesktopPluginEvent =
  | {
      type: "desktop_plugin_event";
      event: "model_select";
      model: DesktopPluginModel;
    }
  | {
      type: "desktop_plugin_event";
      event: "thinking_level_select";
      level: string;
    }
  | {
      type: "desktop_plugin_event";
      event: "runtime_status";
      runtimeStatus: DesktopPluginRuntimeStatus;
    }
  | {
      type: "desktop_plugin_event";
      event: "session_summary";
      summary: DesktopPluginSessionSummary;
    }
  | {
      type: "desktop_plugin_event";
      event: "execution_summary";
      summary: DesktopPluginExecutionSummary;
    };

export interface DesktopAskRequest {
  type: "desktop_ask_request";
  requestId: string;
  toolCallId: string;
  questions: JsonValue[];
}

export interface DesktopAskResponse {
  type: "desktop_ask_response";
  requestId: string;
  toolCallId: string;
  response: ExtensionUiResponse;
}

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

export interface DesktopPlanResult {
  type: "desktop_plan_result";
  requestId: string;
  kind: "confirm" | "review";
  status: "accepted" | "failed" | "unknown";
  error?: { code: string; message?: string };
}

export interface DesktopPlanCancel {
  type: "desktop_plan_cancel";
  requestId: string;
  kind: "confirm" | "review";
}


/** Result of applying a DesktopAskResponse inside the originating Plugin. */
export interface DesktopAskResult {
  type: "desktop_ask_result";
  requestId: string;
  toolCallId: string;
  status: Extract<OperationStatus, "accepted" | "failed" | "unknown">;
  error?: { code: string; message?: string };
}

export interface DesktopPluginGoodbye {
  type: "desktop_plugin_goodbye";
  reason?: "shutdown" | "session_closed";
}

export type DesktopPluginClientFrame =
  | DesktopPeerRequest
  | DesktopPeerAck
  | DesktopPluginHello
  | DesktopPluginRequest
  | DesktopPluginEvent
  | DesktopAskRequest
  | DesktopAskResponse
  | DesktopAskResult
  | DesktopPlanRequest
  | DesktopPlanCancel
  | DesktopPlanResult
  | DesktopPlanRefineSnapshot
  | DesktopPlanRefineUpdate
  | DesktopPluginGoodbye;

export interface DesktopPluginChallenge {
  type: "desktop_plugin_challenge";
  protocolVersion: DesktopPluginProtocolVersion;
  nonce: string;
}

export interface DesktopPluginReady {
  type: "desktop_plugin_ready";
  protocolVersion: DesktopPluginProtocolVersion;
  endpointId: string;
  capabilities: DesktopPluginCapability[];
  releaseVersion?: string;
  supportedEvents?: DesktopPluginEvent["event"][];
  supportedFeatures?: string[];
}

export interface DesktopPluginReceipt {
  type: "desktop_plugin_receipt";
  requestId: string;
  operation: string;
  status: Extract<OperationStatus, "requested" | "accepted" | "unknown">;
}

export interface DesktopPluginResult {
  type: "desktop_plugin_result";
  requestId: string;
  operation: string;
  status: Extract<OperationStatus, "accepted" | "observed" | "failed" | "unknown">;
  result?: JsonValue;
  error?: { code: string; message?: string; details?: HostError };
}

export interface DesktopPluginError {
  type: "desktop_plugin_error";
  requestId?: string;
  code:
    | "authentication_failed"
    | "protocol_version_unsupported"
    | "release_version_unsupported"
    | "invalid_frame"
    | "deadline_exceeded"
    | "capability_mismatch"
    | "target_mismatch"
    | "disconnected";
  message: string;
}

export type DesktopPluginServerFrame =
  | DesktopPeerDelivery
  | DesktopPeerResult
  | DesktopPluginChallenge
  | DesktopPluginReady
  | DesktopPluginReceipt
  | DesktopPluginResult
  | DesktopPlanResponse
  | DesktopPlanRefineAction
  | DesktopPluginError;

export type DesktopPluginFrame = DesktopPluginClientFrame | DesktopPluginServerFrame;

export function isDesktopPluginClientFrame(value: unknown): value is DesktopPluginClientFrame {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "desktop_peer_list":
    case "desktop_peer_send":
    case "desktop_peer_access_list":
    case "desktop_peer_access_grant":
    case "desktop_peer_access_revoke": return isDesktopPeerRequest(value);
    case "desktop_peer_ack": return isDesktopPeerAck(value);
    case "desktop_plugin_hello":
      return value.protocolVersion === DESKTOP_PLUGIN_PROTOCOL_VERSION
        && stringFields(value, "endpointId", "sessionId", "normalizedCwd", "processGeneration", "clientNonce", "secret")
        && (value.sessionFile === undefined || stringFields(value, "sessionFile"))
        && stringArray(value.capabilities)
        && (value.features === undefined || stringArray(value.features) && value.features.every(isDesktopPluginFeature))
        && (value.releaseVersion === undefined || stringFields(value, "releaseVersion"));
    case "desktop_plugin_request":
      return stringFields(value, "requestId", "commandId")
        && finiteNumber(value.deadlineAt)
        && isDesktopPluginTarget(value.target)
        && isDesktopPluginOperation(value.operation);
    case "desktop_plugin_event":
      return (value.event === "model_select" && isDesktopPluginModel(value.model))
        || (value.event === "thinking_level_select" && typeof value.level === "string" && value.level.length > 0)
        || (value.event === "runtime_status" && (value.runtimeStatus === "running" || value.runtimeStatus === "idle"))
        || (value.event === "session_summary" && isDesktopPluginSessionSummary(value.summary))
        || (value.event === "execution_summary" && isDesktopPluginExecutionSummary(value.summary));
    case "desktop_ask_request":
      return stringFields(value, "requestId", "toolCallId") && Array.isArray(value.questions);
    case "desktop_ask_response":
      return stringFields(value, "requestId", "toolCallId") && isExtensionUiResponse(value.response);
    case "desktop_ask_result":
      return isDesktopAskResult(value);
    case "desktop_plan_request":
      return isDesktopPlanRequest(value);
    case "desktop_plan_cancel":
      return isDesktopPlanCancel(value);
    case "desktop_plan_result":
      return isDesktopPlanResult(value);
    case "desktop_plan_refine_snapshot":
      return isDesktopPlanRefineSnapshot(value);
    case "desktop_plan_refine_update":
      return isDesktopPlanRefineUpdate(value);
    case "desktop_plan_refine_action":
      return isDesktopPlanRefineAction(value);
    case "desktop_plugin_goodbye":
      return value.reason === undefined || value.reason === "shutdown" || value.reason === "session_closed";
    default:
      return false;
  }
}

function isDesktopPlanExecutionChoice(value: unknown): boolean {
  if (!isRecord(value) || (value.backend !== "standalone" && value.backend !== "workflow") || (value.context !== "current" && value.context !== "compact")) return false;
  if (value.sourceDocument !== undefined && typeof value.sourceDocument !== "string") return false;
  return value.backend === "standalone"
    ? value.workflowTarget === undefined
    : value.workflowTarget === "current" || value.workflowTarget === "new";
}

function isDesktopPlanWorkflowOptions(value: unknown): boolean {
  if (!isRecord(value) || typeof value.allowNew !== "boolean") return false;
  if (value.current === undefined) return true;
  return isRecord(value.current) && stringFields(value.current, "sessionId", "intent")
    && typeof value.current.available === "boolean"
    && (value.current.reason === undefined || typeof value.current.reason === "string");
}

function isDesktopPlanDraft(value: unknown): boolean {
  return isRecord(value) && nonNegativeInteger(value.revision) && stringFields(value, "archivedAt", "checksum");
}

function isDesktopPlanDecision(value: unknown): boolean {
  return isRecord(value) && stringFields(value, "action")
    && (value.discussion === undefined || typeof value.discussion === "string")
    && (value.execution === undefined || isDesktopPlanExecutionChoice(value.execution));
}

export function isDesktopPlanRefineRole(value: unknown): value is DesktopPlanRefineRole {
  return value === "reviewer" || value === "decomposer" || value === "optimizer" || value === "brainstormer";
}

function isDesktopPlanRefineTurn(value: unknown): value is DesktopPlanRefineTurn {
  return isRecord(value) && stringFields(value, "turnId") && isDesktopPlanRefineRole(value.role)
    && boundedText(value.model, 512)
    && (value.userInput === undefined || (typeof value.userInput === "string" && value.userInput.length <= DESKTOP_PLAN_REFINE_MAX_ACTION_TEXT_LENGTH))
    && (value.output === undefined || boundedText(value.output, DESKTOP_PLAN_REFINE_MAX_OUTPUT_LENGTH))
    && (value.error === undefined || boundedText(value.error, DESKTOP_PLAN_REFINE_MAX_OUTPUT_LENGTH))
    && (value.status === "running" || value.status === "succeeded" || value.status === "failed" || value.status === "cancelled")
    && (value.appliesAs === "feedback" || value.appliesAs === "draft") && finiteNumber(value.createdAt);
}

function isDesktopPlanRefineStatus(value: unknown): value is DesktopPlanRefineStatus {
  return value === "opening" || value === "ready" || value === "running" || value === "applied" || value === "discarded"
    || value === "cancelled" || value === "failed" || value === "revision_conflict" || value === "disconnected";
}

export function isDesktopPlanRefineSnapshot(value: unknown): value is DesktopPlanRefineSnapshot {
  return isRecord(value) && value.type === "desktop_plan_refine_snapshot"
    && isDesktopPluginTarget(value.target) && stringFields(value, "refineSessionId", "planRequestId")
    && nonNegativeInteger(value.operationId) && nonNegativeInteger(value.revision) && nonNegativeInteger(value.sequence)
    && isDesktopPlanRefineStatus(value.status) && boundedText(value.markdown, DESKTOP_PLAN_REFINE_MAX_MARKDOWN_LENGTH)
    && Array.isArray(value.turns) && value.turns.length <= 128 && value.turns.every(isDesktopPlanRefineTurn)
    && isDesktopPlanRefineRole(value.currentRole) && typeof value.currentModel === "string" && value.currentModel.length <= 512
    && Array.isArray(value.modelOptions) && value.modelOptions.length <= 128
    && value.modelOptions.every((model) => isRecord(model) && boundedText(model.id, 512) && boundedText(model.name, 512))
    && Array.isArray(value.availableActions) && value.availableActions.every((action) =>
      action === "select_role" || action === "select_model" || action === "run" || action === "apply" || action === "discard" || action === "cancel");
}

export function isDesktopPlanRefineAction(value: unknown): value is DesktopPlanRefineAction {
  if (!isRecord(value) || value.type !== "desktop_plan_refine_action" || !isDesktopPluginTarget(value.target)
    || !stringFields(value, "refineSessionId", "planRequestId", "actionId")
    || nonNegativeInteger(value.operationId) === false || nonNegativeInteger(value.revision) === false
    || !isRecord(value.action) || typeof value.action.action !== "string") return false;
  switch (value.action.action) {
    case "select_role": return isDesktopPlanRefineRole(value.action.role);
    case "select_model": return boundedText(value.action.model, 512);
    case "run": return typeof value.action.userInput === "string" && value.action.userInput.length <= DESKTOP_PLAN_REFINE_MAX_ACTION_TEXT_LENGTH;
    case "apply": return stringFields(value.action, "turnId");
    case "discard": case "cancel": case "snapshot": return true;
    default: return false;
  }
}

function isDesktopPlanRefineActionResult(value: unknown): value is DesktopPlanRefineActionResult {
  return isRecord(value)
    && stringFields(value, "actionId")
    && (value.status === "accepted" || value.status === "succeeded" || value.status === "rejected" || value.status === "failed")
    && (value.turnId === undefined || boundedText(value.turnId, 512))
    && (value.error === undefined || (isRecord(value.error)
      && boundedText(value.error.code, 128)
      && (value.error.message === undefined || boundedText(value.error.message, DESKTOP_PLAN_REFINE_MAX_OUTPUT_LENGTH))));
}

export function isDesktopPlanRefineUpdate(value: unknown): value is DesktopPlanRefineUpdate {
  return isRecord(value) && value.type === "desktop_plan_refine_update" && isDesktopPluginTarget(value.target)
    && stringFields(value, "refineSessionId", "planRequestId") && nonNegativeInteger(value.operationId)
    && nonNegativeInteger(value.revision) && nonNegativeInteger(value.sequence) && isDesktopPlanRefineStatus(value.status)
    && (value.turn === undefined || isDesktopPlanRefineTurn(value.turn))
    && (value.actionResult === undefined || isDesktopPlanRefineActionResult(value.actionResult))
    && (value.error === undefined || (isRecord(value.error) && boundedText(value.error.code, 128)
      && (value.error.message === undefined || boundedText(value.error.message, DESKTOP_PLAN_REFINE_MAX_OUTPUT_LENGTH))));
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}
export function isDesktopPlanRequest(value: unknown): value is DesktopPlanRequest {
  return isRecord(value) && stringFields(value, "requestId", "kind", "sessionId", "cwd", "mode", "pathLabel")
    && (value.kind === "confirm" || value.kind === "review")
    && nonNegativeInteger(value.operationId)
    && (value.sessionFile === undefined || typeof value.sessionFile === "string")
    && typeof value.markdown === "string" && nonNegativeInteger(value.revision)
    && Array.isArray(value.availableActions) && value.availableActions.every((item) => typeof item === "string")
    && (value.defaultExecution === undefined || isDesktopPlanExecutionChoice(value.defaultExecution))
    && (value.workflow === undefined || isDesktopPlanWorkflowOptions(value.workflow))
    && (value.modelTransition === undefined || (isRecord(value.modelTransition) && stringFields(value.modelTransition, "current") && (value.modelTransition.act === undefined || typeof value.modelTransition.act === "string")))
    && Array.isArray(value.decisionDocuments) && value.decisionDocuments.every((item) => typeof item === "string")
    && Array.isArray(value.drafts) && value.drafts.every(isDesktopPlanDraft);
}

export function isDesktopPlanResponse(value: unknown): value is DesktopPlanResponse {
  if (!isRecord(value) || !stringFields(value, "requestId", "kind") || (value.kind !== "confirm" && value.kind !== "review")) return false;
  if (value.status === "cancelled") return true;
  if (value.status === "edited") return typeof value.markdown === "string" && nonNegativeInteger(value.expectedRevision);
  return value.status === "decision" && isDesktopPlanDecision(value.decision);
}

export function isDesktopPlanCancel(value: unknown): value is DesktopPlanCancel {
  return isRecord(value) && stringFields(value, "requestId", "kind") && (value.kind === "confirm" || value.kind === "review");
}

export function isDesktopPluginResult(value: unknown): value is DesktopPluginResult {
  return isRecord(value)
    && stringFields(value, "requestId", "operation")
    && (value.status === "accepted" || value.status === "observed" || value.status === "failed" || value.status === "unknown")
    && (value.result === undefined || isJsonValue(value.result))
    && (value.error === undefined || (isRecord(value.error) && typeof value.error.code === "string" && (value.error.message === undefined || typeof value.error.message === "string")
      && (value.error.details === undefined || isHostError(value.error.details))));
}

export function isDesktopPlanResult(value: unknown): value is DesktopPlanResult {
  return isRecord(value) && stringFields(value, "requestId", "kind")
    && (value.kind === "confirm" || value.kind === "review")
    && (value.status === "accepted" || value.status === "failed" || value.status === "unknown")
    && (value.error === undefined || (isRecord(value.error) && typeof value.error.code === "string"));
}

export function isDesktopAskResult(value: unknown): value is DesktopAskResult {
  return isRecord(value)
    && stringFields(value, "requestId", "toolCallId")
    && (value.status === "accepted" || value.status === "failed" || value.status === "unknown")
    && (value.error === undefined || (isRecord(value.error)
      && typeof value.error.code === "string"
      && value.error.code.length > 0
      && (value.error.message === undefined || typeof value.error.message === "string")));
}

export function isDesktopPluginServerFrame(value: unknown): value is DesktopPluginServerFrame {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "desktop_peer_delivery": return isDesktopPeerDelivery(value);
    case "desktop_peer_result": return isDesktopPeerResult(value);
    case "desktop_plugin_challenge":
      return value.protocolVersion === DESKTOP_PLUGIN_PROTOCOL_VERSION && stringFields(value, "nonce");
    case "desktop_plugin_ready":
      return value.protocolVersion === DESKTOP_PLUGIN_PROTOCOL_VERSION
        && stringFields(value, "endpointId")
        && stringArray(value.capabilities)
        && (value.supportedFeatures === undefined || stringArray(value.supportedFeatures) && value.supportedFeatures.every(isDesktopPluginFeature))
        && (value.releaseVersion === undefined || stringFields(value, "releaseVersion"))
        && (value.supportedEvents === undefined || desktopPluginEventArray(value.supportedEvents));
    case "desktop_plugin_receipt":
      return stringFields(value, "requestId", "operation")
        && (value.status === "requested" || value.status === "accepted" || value.status === "unknown");
    case "desktop_plugin_result":
      return stringFields(value, "requestId", "operation")
        && (value.status === "accepted" || value.status === "observed" || value.status === "failed" || value.status === "unknown");
    case "desktop_plan_response":
      return isDesktopPlanResponse(value);
    case "desktop_plan_refine_action":
      return isDesktopPlanRefineAction(value);
    case "desktop_plugin_error":
      return stringFields(value, "message") && (value.requestId === undefined || typeof value.requestId === "string");
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function stringFields(value: Record<string, unknown>, ...fields: string[]): boolean {
  return fields.every((field) => typeof value[field] === "string" && value[field].length > 0);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isDesktopPluginFeature(value: unknown): boolean {
  return value === DESKTOP_PEER_FEATURE || value === DESKTOP_PLAN_REFINE_FEATURE;
}
function desktopPluginEventArray(value: unknown): value is DesktopPluginEvent["event"][] {
  return Array.isArray(value)
    && value.every((item) => item === "model_select" || item === "thinking_level_select" || item === "runtime_status" || item === "session_summary" || item === "execution_summary");
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isDesktopPluginTarget(value: unknown): value is DesktopPluginTarget {
  return isRecord(value) && stringFields(value, "sessionId", "endpointId", "normalizedCwd", "processGeneration");
}

function isDesktopPluginOperation(value: unknown): value is DesktopPluginOperation {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "abort") return true;
  if (value.type === "set_model") {
    return typeof value.modelId === "string" && value.modelId.length > 0
      && (value.provider === undefined || (typeof value.provider === "string" && value.provider.length > 0));
  }
  if (value.type === "set_thinking") return typeof value.level === "string" && value.level.length > 0;
  if (value.type === "list_models" || value.type === "list_skills") return true;
  return (value.type === "prompt" || value.type === "steer" || value.type === "follow_up")
    && typeof value.message === "string";
}

export function isDesktopPluginModel(value: unknown): value is DesktopPluginModel {
  return isRecord(value)
    && stringFields(value, "provider", "id", "name")
    && typeof value.reasoning === "boolean"
    && typeof value.vision === "boolean";
}

export function isDesktopPluginExecutionSummary(value: unknown): value is DesktopPluginExecutionSummary {
  if (!isRecord(value) || !nonNegativeInteger(value.revision)
    || !Array.isArray(value.todos) || value.todos.length > DESKTOP_PLUGIN_MAX_EXECUTION_TODOS
    || !value.todos.every(isBoundedExecutionTodo)
    || !isRecord(value.teammate)
    || !nonNegativeInteger(value.teammate.running)
    || !nonNegativeInteger(value.teammate.total)
    || value.teammate.running > value.teammate.total
    || !Array.isArray(value.teammate.agents) || value.teammate.agents.length > DESKTOP_PLUGIN_MAX_EXECUTION_AGENTS
    || value.teammate.total !== value.teammate.agents.length
    || !value.teammate.agents.every(isBoundedExecutionAgent)
    || !Array.isArray(value.backgroundJobs) || value.backgroundJobs.length > DESKTOP_PLUGIN_MAX_EXECUTION_BACKGROUND_JOBS
    || !value.backgroundJobs.every(isBoundedExecutionBackgroundJob)) return false;
  if (value.workspace !== undefined && (!isRecord(value.workspace)
    || ![value.workspace.label, value.workspace.workspaceId, value.workspace.ownerId].every((item) => item === undefined || isBoundedText(item))
    || ![value.workspace.label, value.workspace.workspaceId, value.workspace.ownerId].some((item) => typeof item === "string"))) return false;
  return true;
}

function isBoundedExecutionTodo(value: unknown): boolean {
  return isRecord(value) && isBoundedText(value.id) && isBoundedText(value.subject) && isBoundedText(value.status)
    && finiteNumber(value.updatedAt) && (value.assigneeLabel === undefined || isBoundedText(value.assigneeLabel));
}

function isBoundedExecutionAgent(value: unknown): boolean {
  return isRecord(value)
    && [value.correlationId, value.name, value.agent].some(isBoundedText)
    && isBoundedText(value.status)
    && [value.correlationId, value.name, value.agent, value.phase].every((item) => item === undefined || isBoundedText(item))
    && (value.outputTail === undefined || (Array.isArray(value.outputTail) && value.outputTail.length <= 8 && value.outputTail.every(isBoundedText)))
    && (value.pendingInteractions === undefined || nonNegativeInteger(value.pendingInteractions));
}

function isBoundedExecutionBackgroundJob(value: unknown): boolean {
  return isBackgroundJobSummary(value)
    && isBoundedText(value.id)
    && [value.label, value.startedAt, value.finishedAt].every((item) => item === undefined || isBoundedText(item));
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= DESKTOP_PLUGIN_MAX_EXECUTION_TEXT_LENGTH;
}

export function isDesktopPluginSessionSummary(value: unknown): value is DesktopPluginSessionSummary {
  return isSessionSummaryPatch(value)
    && (value.runtimeStatus === "running" || value.runtimeStatus === "idle");
}

export function isExtensionUiResponse(value: unknown): value is ExtensionUiResponse {
  if (!isRecord(value)) return false;
  if (value.cancelled === true) return true;
  if (value.cancelled !== undefined && value.cancelled !== false) return false;
  return (typeof value.value === "string" && value.confirmed === undefined && value.selected === undefined)
    || (typeof value.confirmed === "boolean" && value.value === undefined && value.selected === undefined)
    || (Array.isArray(value.selected) && value.selected.every((item) => typeof item === "string")
      && value.value === undefined && value.confirmed === undefined);
}
