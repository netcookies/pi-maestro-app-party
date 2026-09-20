import type {
  DesktopAskRequest,
  DesktopAskResponse,
  DesktopAskResult,
  DesktopPluginCapability,
  DesktopPluginEvent,
  DesktopPluginModel,
  DesktopPluginRequest,
  DesktopPluginResult,
  DesktopPluginRuntimeStatus,
  DesktopPluginSessionSummary,
  DesktopPluginTarget,
} from "./desktop-plugin-protocol.js";
import {
  DESKTOP_PLUGIN_PROTOCOL_VERSION,
  isDesktopPluginModel,
  isDesktopPluginResult,
  isDesktopPluginSessionSummary,
  isDesktopPluginTarget,
  isDesktopAskResult,
  isExtensionUiResponse,
} from "./desktop-plugin-protocol.js";
import type { JsonValue } from "./protocol.js";

/** Broker-to-Host protocol. This is intentionally separate from the Plugin wire protocol. */
export const DESKTOP_BROKER_PROTOCOL_VERSION = 1 as const;
export type DesktopBrokerProtocolVersion = typeof DESKTOP_BROKER_PROTOCOL_VERSION;
export const DESKTOP_BROKER_MAX_SNAPSHOT_RECORDS = 64 as const;

export interface DesktopBrokerHello {
  type: "desktop_broker_hello";
  protocolVersion: DesktopBrokerProtocolVersion;
  brokerInstanceId: string;
  clientNonce: string;
  secret: string;
  releaseVersion?: string;
}

export interface DesktopBrokerReady {
  type: "desktop_broker_ready";
  protocolVersion: DesktopBrokerProtocolVersion;
  hostInstanceId: string;
  releaseVersion?: string;
}

export interface DesktopBrokerTargetRecord {
  target: DesktopPluginTarget;
  /** Session JSONL metadata; exact target identity remains the four target fields. */
  sessionFile?: string;
  capabilities: DesktopPluginCapability[];
  model?: DesktopPluginModel;
  thinkingLevel?: string;
  runtimeStatus: DesktopPluginRuntimeStatus;
  summary?: DesktopPluginSessionSummary;
  connectedAt?: string;
  lastEventAt?: string;
}

export interface DesktopBrokerSnapshotBegin {
  type: "desktop_broker_snapshot_begin";
  brokerInstanceId: string;
  snapshotId: string;
  revision: number;
  targetCount: number;
}

export interface DesktopBrokerSnapshotChunk {
  type: "desktop_broker_snapshot_chunk";
  brokerInstanceId: string;
  snapshotId: string;
  revision: number;
  chunkIndex: number;
  records: DesktopBrokerTargetRecord[];
}

export interface DesktopBrokerSnapshotEnd {
  type: "desktop_broker_snapshot_end";
  brokerInstanceId: string;
  snapshotId: string;
  revision: number;
  chunkCount: number;
}

export type DesktopBrokerDeltaMutation =
  | { kind: "upsert"; record: DesktopBrokerTargetRecord }
  | { kind: "remove"; target: DesktopPluginTarget }
  | { kind: "model"; target: DesktopPluginTarget; model: DesktopPluginModel | null }
  | { kind: "thinking_level"; target: DesktopPluginTarget; level: string | null }
  | { kind: "runtime_status"; target: DesktopPluginTarget; runtimeStatus: DesktopPluginRuntimeStatus }
  | { kind: "session_summary"; target: DesktopPluginTarget; summary: DesktopPluginSessionSummary };

export interface DesktopBrokerDelta {
  type: "desktop_broker_delta";
  brokerInstanceId: string;
  baseRevision: number;
  revision: number;
  mutation: DesktopBrokerDeltaMutation;
}

export interface DesktopBrokerCommandResult {
  type: "desktop_broker_command_result";
  target: DesktopPluginTarget;
  result: DesktopPluginResult;
}

export interface DesktopBrokerAskRequest {
  type: "desktop_broker_ask_request";
  target: DesktopPluginTarget;
  request: DesktopAskRequest;
}

export interface DesktopBrokerAskResult {
  type: "desktop_broker_ask_result";
  target: DesktopPluginTarget;
  result: DesktopAskResult;
}

export interface DesktopBrokerPing {
  type: "desktop_broker_ping";
  nonce: string;
}

export interface DesktopBrokerPong {
  type: "desktop_broker_pong";
  nonce: string;
}

export type DesktopBrokerErrorCode =
  | "authentication_failed"
  | "protocol_version_unsupported"
  | "release_version_unsupported"
  | "invalid_frame"
  | "revision_gap"
  | "target_unavailable"
  | "deadline_exceeded"
  | "disconnected";

export interface DesktopBrokerError {
  type: "desktop_broker_error";
  code: DesktopBrokerErrorCode;
  message: string;
  requestId?: string;
}

export interface DesktopBrokerCommand {
  type: "desktop_broker_command";
  request: DesktopPluginRequest;
}

export interface DesktopBrokerAskResponse {
  type: "desktop_broker_ask_response";
  target: DesktopPluginTarget;
  response: DesktopAskResponse;
}

export type DesktopBrokerToHostFrame =
  | DesktopBrokerHello
  | DesktopBrokerSnapshotBegin
  | DesktopBrokerSnapshotChunk
  | DesktopBrokerSnapshotEnd
  | DesktopBrokerDelta
  | DesktopBrokerCommandResult
  | DesktopBrokerAskRequest
  | DesktopBrokerAskResult
  | DesktopBrokerPong
  | DesktopBrokerError;

export type DesktopHostToBrokerFrame =
  | DesktopBrokerReady
  | DesktopBrokerCommand
  | DesktopBrokerAskResponse
  | DesktopBrokerPing
  | DesktopBrokerError;

export type DesktopBrokerFrame = DesktopBrokerToHostFrame | DesktopHostToBrokerFrame;

export function isDesktopBrokerToHostFrame(value: unknown): value is DesktopBrokerToHostFrame {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "desktop_broker_hello":
      return value.protocolVersion === DESKTOP_BROKER_PROTOCOL_VERSION
        && stringFields(value, "brokerInstanceId", "clientNonce", "secret")
        && optionalString(value, "releaseVersion");
    case "desktop_broker_snapshot_begin":
      return stringFields(value, "brokerInstanceId", "snapshotId")
        && nonNegativeInteger(value.revision)
        && nonNegativeInteger(value.targetCount);
    case "desktop_broker_snapshot_chunk":
      return stringFields(value, "brokerInstanceId", "snapshotId")
        && nonNegativeInteger(value.revision)
        && nonNegativeInteger(value.chunkIndex)
        && Array.isArray(value.records)
        && value.records.length <= DESKTOP_BROKER_MAX_SNAPSHOT_RECORDS
        && value.records.every(isDesktopBrokerTargetRecord);
    case "desktop_broker_snapshot_end":
      return stringFields(value, "brokerInstanceId", "snapshotId")
        && nonNegativeInteger(value.revision)
        && nonNegativeInteger(value.chunkCount);
    case "desktop_broker_delta":
      return stringFields(value, "brokerInstanceId")
        && nonNegativeInteger(value.baseRevision)
        && nonNegativeInteger(value.revision)
        && value.revision === value.baseRevision + 1
        && isDesktopBrokerDeltaMutation(value.mutation);
    case "desktop_broker_command_result":
      return isDesktopPluginTarget(value.target) && isDesktopPluginResult(value.result);
    case "desktop_broker_ask_request":
      return isDesktopPluginTarget(value.target) && isDesktopAskRequest(value.request);
    case "desktop_broker_ask_result":
      return isDesktopPluginTarget(value.target) && isDesktopAskResult(value.result);
    case "desktop_broker_pong":
      return stringFields(value, "nonce");
    case "desktop_broker_error":
      return isDesktopBrokerError(value);
    default:
      return false;
  }
}

export function isDesktopHostToBrokerFrame(value: unknown): value is DesktopHostToBrokerFrame {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "desktop_broker_ready":
      return value.protocolVersion === DESKTOP_BROKER_PROTOCOL_VERSION
        && stringFields(value, "hostInstanceId")
        && optionalString(value, "releaseVersion");
    case "desktop_broker_command":
      return isDesktopPluginRequest(value.request);
    case "desktop_broker_ask_response":
      return isDesktopPluginTarget(value.target) && isDesktopAskResponse(value.response);
    case "desktop_broker_ping":
      return stringFields(value, "nonce");
    case "desktop_broker_error":
      return isDesktopBrokerError(value);
    default:
      return false;
  }
}

function isDesktopBrokerTargetRecord(value: unknown): value is DesktopBrokerTargetRecord {
  return isRecord(value)
    && isDesktopPluginTarget(value.target)
    && optionalString(value, "sessionFile")
    && isDesktopPluginCapabilityArray(value.capabilities)
    && (value.model === undefined || isDesktopPluginModel(value.model))
    && optionalString(value, "thinkingLevel")
    && (value.runtimeStatus === "running" || value.runtimeStatus === "idle")
    && (value.summary === undefined || isDesktopPluginSessionSummary(value.summary))
    && optionalString(value, "connectedAt")
    && optionalString(value, "lastEventAt");
}

function isDesktopBrokerDeltaMutation(value: unknown): value is DesktopBrokerDeltaMutation {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "upsert":
      return isDesktopBrokerTargetRecord(value.record);
    case "remove":
      return isDesktopPluginTarget(value.target);
    case "model":
      return isDesktopPluginTarget(value.target) && (value.model === null || isDesktopPluginModel(value.model));
    case "thinking_level":
      return isDesktopPluginTarget(value.target) && (value.level === null || (typeof value.level === "string" && value.level.length > 0));
    case "runtime_status":
      return isDesktopPluginTarget(value.target) && (value.runtimeStatus === "running" || value.runtimeStatus === "idle");
    case "session_summary":
      return isDesktopPluginTarget(value.target) && isDesktopPluginSessionSummary(value.summary);
    default:
      return false;
  }
}

function isDesktopPluginRequest(value: unknown): value is DesktopPluginRequest {
  return isRecord(value)
    && stringFields(value, "requestId", "commandId")
    && finiteNumber(value.deadlineAt)
    && isDesktopPluginTarget(value.target)
    && isDesktopPluginOperation(value.operation);
}

function isDesktopPluginOperation(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "abort") return true;
  if (value.type === "set_model") return typeof value.modelId === "string" && value.modelId.length > 0
    && (value.provider === undefined || (typeof value.provider === "string" && value.provider.length > 0));
  if (value.type === "set_thinking") return typeof value.level === "string" && value.level.length > 0;
  return (value.type === "prompt" || value.type === "steer" || value.type === "follow_up") && typeof value.message === "string";
}

function isDesktopAskRequest(value: unknown): value is DesktopAskRequest {
  return isRecord(value) && stringFields(value, "requestId", "toolCallId") && finiteNumber(value.deadlineAt) && Array.isArray(value.questions);
}

function isDesktopAskResponse(value: unknown): value is DesktopAskResponse {
  return isRecord(value) && stringFields(value, "requestId", "toolCallId") && isExtensionUiResponse(value.response);
}

function isDesktopBrokerError(value: unknown): value is DesktopBrokerError {
  return isRecord(value)
    && stringFields(value, "message")
    && (value.requestId === undefined || typeof value.requestId === "string")
    && (value.code === "authentication_failed"
      || value.code === "protocol_version_unsupported"
      || value.code === "release_version_unsupported"
      || value.code === "invalid_frame"
      || value.code === "revision_gap"
      || value.code === "target_unavailable"
      || value.code === "deadline_exceeded"
      || value.code === "disconnected");
}

function isDesktopPluginCapabilityArray(value: unknown): value is DesktopPluginCapability[] {
  return Array.isArray(value) && value.every((item) => item === "prompt" || item === "steer" || item === "follow_up" || item === "abort" || item === "set_model" || item === "set_thinking" || item === "ask-user-question");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringFields(value: Record<string, unknown>, ...fields: string[]): boolean {
  return fields.every((field) => typeof value[field] === "string" && value[field].length > 0);
}

function optionalString(value: Record<string, unknown>, field: string): boolean {
  return value[field] === undefined || (typeof value[field] === "string" && value[field].length > 0);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export type DesktopBrokerEventName = Extract<DesktopPluginEvent["event"], "model_select" | "thinking_level_select" | "runtime_status" | "session_summary">;
export type DesktopBrokerJson = JsonValue;
