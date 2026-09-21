import type {
  ExtensionUiResponse,
  JsonValue,
  OperationStatus,
  SessionRuntimeStatus,
  SessionSummaryPatch,
} from "./protocol.js";
import { isSessionSummaryPatch } from "./protocol.js";

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
  | "ask-user-question";

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
    };

export interface DesktopAskRequest {
  type: "desktop_ask_request";
  requestId: string;
  toolCallId: string;
  questions: JsonValue[];
  deadlineAt: number;
}

export interface DesktopAskResponse {
  type: "desktop_ask_response";
  requestId: string;
  toolCallId: string;
  response: ExtensionUiResponse;
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
  | DesktopPluginHello
  | DesktopPluginRequest
  | DesktopPluginEvent
  | DesktopAskRequest
  | DesktopAskResponse
  | DesktopAskResult
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
  error?: { code: string; message?: string };
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
  | DesktopPluginChallenge
  | DesktopPluginReady
  | DesktopPluginReceipt
  | DesktopPluginResult
  | DesktopPluginError;

export type DesktopPluginFrame = DesktopPluginClientFrame | DesktopPluginServerFrame;

export function isDesktopPluginClientFrame(value: unknown): value is DesktopPluginClientFrame {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "desktop_plugin_hello":
      return value.protocolVersion === DESKTOP_PLUGIN_PROTOCOL_VERSION
        && stringFields(value, "endpointId", "sessionId", "normalizedCwd", "processGeneration", "clientNonce", "secret")
        && (value.sessionFile === undefined || stringFields(value, "sessionFile"))
        && stringArray(value.capabilities)
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
        || (value.event === "session_summary" && isDesktopPluginSessionSummary(value.summary));
    case "desktop_ask_request":
      return stringFields(value, "requestId", "toolCallId")
        && finiteNumber(value.deadlineAt)
        && Array.isArray(value.questions);
    case "desktop_ask_response":
      return stringFields(value, "requestId", "toolCallId") && isExtensionUiResponse(value.response);
    case "desktop_ask_result":
      return isDesktopAskResult(value);
    case "desktop_plugin_goodbye":
      return value.reason === undefined || value.reason === "shutdown" || value.reason === "session_closed";
    default:
      return false;
  }
}

export function isDesktopPluginResult(value: unknown): value is DesktopPluginResult {
  return isRecord(value)
    && stringFields(value, "requestId", "operation")
    && (value.status === "accepted" || value.status === "observed" || value.status === "failed" || value.status === "unknown")
    && (value.result === undefined || isJsonValue(value.result))
    && (value.error === undefined || (isRecord(value.error) && typeof value.error.code === "string" && (value.error.message === undefined || typeof value.error.message === "string")));
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
    case "desktop_plugin_challenge":
      return value.protocolVersion === DESKTOP_PLUGIN_PROTOCOL_VERSION && stringFields(value, "nonce");
    case "desktop_plugin_ready":
      return value.protocolVersion === DESKTOP_PLUGIN_PROTOCOL_VERSION
        && stringFields(value, "endpointId")
        && stringArray(value.capabilities)
        && (value.releaseVersion === undefined || stringFields(value, "releaseVersion"))
        && (value.supportedEvents === undefined || desktopPluginEventArray(value.supportedEvents));
    case "desktop_plugin_receipt":
      return stringFields(value, "requestId", "operation")
        && (value.status === "requested" || value.status === "accepted" || value.status === "unknown");
    case "desktop_plugin_result":
      return stringFields(value, "requestId", "operation")
        && (value.status === "accepted" || value.status === "observed" || value.status === "failed" || value.status === "unknown");
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

function desktopPluginEventArray(value: unknown): value is DesktopPluginEvent["event"][] {
  return Array.isArray(value)
    && value.every((item) => item === "model_select" || item === "thinking_level_select" || item === "runtime_status" || item === "session_summary");
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
