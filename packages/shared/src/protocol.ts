/**
 * Maestro Mobile 共享协议类型
 *
 * 数据契约核心：
 * - HostEvent — host 推送给客户端的统一事件流
 * - ClientCommand — 客户端发给 host 的命令
 * - MaestroState — teammate/flow-schedule 调度状态投影
 * - MonitorWindow — monitor 窗口状态
 * - ExtensionUiRequest/Response — ask 弹窗协议（解决 maestro ask 在 remote 环境失效问题）
 */

// ─────────────────────────────────────────────────────────────────────────────
// 基础类型
// ─────────────────────────────────────────────────────────────────────────────

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface TimelineItem {
  id: string;
  kind: "user" | "assistant" | "thinking" | "tool" | "system";
  text: string;
  createdAt: string;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: JsonValue;
  toolResult?: JsonValue;
  isError?: boolean;
}

export interface SessionState {
  id: string;
  cwd: string;
  title: string;
  runState: "idle" | "streaming" | "compacting" | "aborting" | "error";
  messageCount: number;
  pendingMessageCount: number;
  updatedAt: string;
  sessionFile?: string;
  model?: JsonValue;
  thinkingLevel?: string;
}

export interface SessionSnapshot {
  session: SessionState;
  timeline: TimelineItem[];
  nextSeq: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Maestro 状态投影（flow-schedule store 的只读投影）
// ─────────────────────────────────────────────────────────────────────────────

export type MaestroScheduleState =
  | "draft"
  | "active"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type MaestroDispatchState =
  | "prepared"
  | "published"
  | "accepted"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled";

export interface MaestroStepSummary {
  stepId: string;
  title: string;
  state: string;
  dispatches: MaestroDispatchSummary[];
}

export interface MaestroDispatchSummary {
  dispatchId: string;
  state: MaestroDispatchState;
  agent?: string;
  task?: string;
  startedAt?: string;
  completedAt?: string;
  resultSummary?: string;
  error?: string;
  attempt: number;
}

export interface MaestroScheduleSummary {
  scheduleId: string;
  title: string;
  state: MaestroScheduleState;
  progress: { completed: number; total: number };
  steps: MaestroStepSummary[];
  createdAt: string;
  updatedAt: string;
  targetIdentity?: {
    workspaceId: string;
    ownerId: string;
    endpointId: string;
  };
}

export interface MaestroState {
  schedules: MaestroScheduleSummary[];
  observedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Monitor 窗口状态
// ─────────────────────────────────────────────────────────────────────────────

export interface MonitorWindowSummary {
  identity: {
    workspaceId: string;
    ownerId: string;
    ownerNonce: string;
    endpointId: string;
  };
  name?: string;
  objective?: string;
  status: string;
  lifecycle: string;
  workStatus: string;
  todos: MonitorTodoSummary[];
  attention: MonitorAttentionSummary[];
  facets: JsonValue[];
}

export interface MonitorTodoSummary {
  id: string;
  subject: string;
  status: string;
  assigneeLabel?: string;
  updatedAt: number;
}

export interface MonitorAttentionSummary {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface MonitorState {
  windows: MonitorWindowSummary[];
  observedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension UI（ask 弹窗协议）
// ─────────────────────────────────────────────────────────────────────────────

export type ExtensionUiMethod =
  | "select"
  | "confirm"
  | "input"
  | "editor"
  | "notify"
  | "setStatus"
  | "setWidget"
  | "setTitle"
  | "set_editor_text";

export interface ExtensionUiRequest {
  id: string;
  sessionId: string;
  method: ExtensionUiMethod;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: string;
  statusKey?: string;
  statusText?: string;
  notifyType?: string;
  text?: string;
}

export type ExtensionUiResponse =
  | { id: string; cancelled: true }
  | { id: string; cancelled?: false; value: string }
  | { id: string; cancelled?: false; confirmed: boolean }
  | { id: string; cancelled?: false; selected: string[] };

// ─────────────────────────────────────────────────────────────────────────────
// HostEvent — host 推送给客户端的统一事件流
// ─────────────────────────────────────────────────────────────────────────────

export type HostEvent =
  | { type: "host_status"; status: string; seq: number }
  | { type: "session_updated"; session: SessionState; seq: number }
  | { type: "timeline_item"; sessionId: string; item: TimelineItem; seq: number }
  | { type: "timeline_delta"; sessionId: string; itemId: string; delta: string; seq: number }
  | { type: "raw_event"; sessionId: string; event: JsonValue; seq: number }
  | { type: "command_error"; sessionId: string; command: string; message: string; seq: number }
  | { type: "extension_ui_request"; sessionId: string; request: ExtensionUiRequest; seq: number }
  | { type: "extension_ui_cleared"; sessionId: string; requestId: string; seq: number }
  | { type: "maestro_state"; state: MaestroState; seq: number }
  | { type: "monitor_state"; state: MonitorState; seq: number }
  | { type: "teammate_event"; scheduleId: string; dispatchId?: string; status: string; seq: number }
  | { type: "error"; code: string; message: string; seq: number };

// ─────────────────────────────────────────────────────────────────────────────
// ClientCommand — 客户端发给 host 的命令
// ─────────────────────────────────────────────────────────────────────────────

export type ClientCommand =
  | { type: "open_session"; cwd: string; mode?: "create" | "continue"; sessionFile?: string }
  | { type: "close_session"; sessionId: string }
  | { type: "list_sessions"; cwd?: string }
  | { type: "list_directories"; path: string }
  | { type: "prompt"; sessionId: string; message: string; images?: { data: string; mime: string }[] }
  | { type: "steer"; sessionId: string; message: string }
  | { type: "follow_up"; sessionId: string; message: string }
  | { type: "abort"; sessionId: string }
  | { type: "extension_ui_response"; sessionId: string; requestId: string; response: ExtensionUiResponse }
  | { type: "get_snapshot"; sessionId: string }
  | { type: "get_maestro_state" }
  | { type: "get_monitor_state" }
  | { type: "set_model"; sessionId: string; model: string }
  | { type: "set_thinking"; sessionId: string; level: string }
  | { type: "compact"; sessionId: string };

// ─────────────────────────────────────────────────────────────────────────────
// 宿主状态
// ─────────────────────────────────────────────────────────────────────────────

export interface HostStatus {
  ok: boolean;
  version: string;
  maestroDetected: boolean;
  maestroVersion?: string;
  sessions: number;
  uptimeMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 错误类型
// ─────────────────────────────────────────────────────────────────────────────

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function isHostEvent(value: unknown): value is HostEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.type === "string" && typeof v.seq === "number";
}

export function isClientCommand(value: unknown): value is ClientCommand {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.type === "string";
}
