import type {
  ExtensionUiResponse,
  JsonValue,
  OperationStatus,
} from "./protocol.js";

export const DESKTOP_PLUGIN_PROTOCOL_VERSION = 1 as const;
export type DesktopPluginProtocolVersion = typeof DESKTOP_PLUGIN_PROTOCOL_VERSION;

export type DesktopPluginCapability =
  | "prompt"
  | "steer"
  | "follow_up"
  | "abort"
  | "ask-user-question";

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
  | { type: "abort" };

export interface DesktopPluginHello {
  type: "desktop_plugin_hello";
  protocolVersion: DesktopPluginProtocolVersion;
  endpointId: string;
  sessionId: string;
  normalizedCwd: string;
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

export interface DesktopPluginGoodbye {
  type: "desktop_plugin_goodbye";
  reason?: "shutdown" | "session_closed";
}

export type DesktopPluginClientFrame =
  | DesktopPluginHello
  | DesktopPluginRequest
  | DesktopAskRequest
  | DesktopAskResponse
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
  status: Extract<OperationStatus, "observed" | "failed" | "unknown">;
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
        && stringArray(value.capabilities)
        && (value.releaseVersion === undefined || stringFields(value, "releaseVersion"));
    case "desktop_plugin_request":
      return stringFields(value, "requestId", "commandId")
        && finiteNumber(value.deadlineAt)
        && isDesktopPluginTarget(value.target)
        && isDesktopPluginOperation(value.operation);
    case "desktop_ask_request":
      return stringFields(value, "requestId", "toolCallId")
        && finiteNumber(value.deadlineAt)
        && Array.isArray(value.questions);
    case "desktop_ask_response":
      return stringFields(value, "requestId", "toolCallId") && isExtensionUiResponse(value.response);
    case "desktop_plugin_goodbye":
      return value.reason === undefined || value.reason === "shutdown" || value.reason === "session_closed";
    default:
      return false;
  }
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
        && (value.releaseVersion === undefined || stringFields(value, "releaseVersion"));
    case "desktop_plugin_receipt":
      return stringFields(value, "requestId", "operation")
        && (value.status === "requested" || value.status === "accepted" || value.status === "unknown");
    case "desktop_plugin_result":
      return stringFields(value, "requestId", "operation")
        && (value.status === "observed" || value.status === "failed" || value.status === "unknown");
    case "desktop_plugin_error":
      return stringFields(value, "message") && (value.requestId === undefined || typeof value.requestId === "string");
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringFields(value: Record<string, unknown>, ...fields: string[]): boolean {
  return fields.every((field) => typeof value[field] === "string" && value[field].length > 0);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isDesktopPluginTarget(value: unknown): value is DesktopPluginTarget {
  return isRecord(value) && stringFields(value, "sessionId", "endpointId", "normalizedCwd", "processGeneration");
}

function isDesktopPluginOperation(value: unknown): value is DesktopPluginOperation {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "abort") return true;
  return (value.type === "prompt" || value.type === "steer" || value.type === "follow_up")
    && typeof value.message === "string";
}

function isExtensionUiResponse(value: unknown): value is ExtensionUiResponse {
  if (!isRecord(value)) return false;
  if (value.cancelled === true) return true;
  if (value.cancelled !== undefined && value.cancelled !== false) return false;
  return (typeof value.value === "string" && value.confirmed === undefined && value.selected === undefined)
    || (typeof value.confirmed === "boolean" && value.value === undefined && value.selected === undefined)
    || (Array.isArray(value.selected) && value.selected.every((item) => typeof item === "string")
      && value.value === undefined && value.confirmed === undefined);
}
