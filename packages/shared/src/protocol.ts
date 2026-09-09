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
  /** Host-cache absolute image paths; raw image bytes never travel in timeline events. */
  images?: string[];
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
  /** 是否还有更早的历史可懒加载 */
  hasMoreHistory?: boolean;
}

/** Host 端 Pi 已存在会话的摘要（移动端只读列表用，不携带大字段） */
export interface HostSessionSummary {
  id: string;
  cwd: string;
  cwdName: string;
  path: string;
  title: string;
  /** 用户自定义会话名（session_info） */
  name?: string;
  /** 最近使用的模型（provider/modelId） */
  model?: string;
  messageCount: number;
  updatedAt: string;
  createdAt?: string;
}

export interface HostSessionList {
  sessions: HostSessionSummary[];
  observedAt: string;
  /** 稳定 keyset cursor；仅分页请求返回。 */
  nextCursor?: string;
  /** 是否还有下一页；仅分页请求返回。 */
  hasMore?: boolean;
  /** cwd/query 过滤后的会话总数；仅分页请求返回。 */
  total?: number;
  /** 定向摘要请求的能力确认；旧 Host 忽略请求字段时不会返回。 */
  targeted?: boolean;
}

/** 活跃会话（vibe coding 中）摘要 */
export interface LiveSessionInfo {
  sessionId: string;
  cwdName: string;
  path: string;
  firstMessage: string;
  entryCount: number;
  messageCount: number;
  updatedAt: number;
  live: boolean;
  liveAgeMs: number;
}

export interface LiveSessionList {
  sessions: LiveSessionInfo[];
  observedAt: string;
  liveCount: number;
}

/** Teammate/Monitor 合同：workspace owner 运行时状态（pi-maestro-teammate 持久化） */
export interface WorkspaceOwnerState {
  workspaceId: string;
  normalizedCwd: string;
  ownerId: string;
  pid: number;
  sessionId: string;
  publishedAt: number;
  contextPressure: JsonValue;
  agents: JsonValue[];
  settled: JsonValue[];
  backgroundJobs: JsonValue[];
  alive: boolean;
  ageMs: number;
}

export interface WorkspaceTelemetryState {
  owners: WorkspaceOwnerState[];
  observedAt: string;
  aliveCount: number;
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
/** Teammate dispatch 运行状态（pi-maestro-teammate owner.agents 条目，有界投影） */
export interface TeammateAgentState {
  correlationId?: string;
  name?: string;
  agent?: string;
  status?: string;
  phase?: string;
  /** 最近输出行（host 端截断至有界条数） */
  outputTail?: string[];
  pendingInteractions?: number;
}

/** Monitor 窗口 facet：teammate agents 详情（host 投影合同） */
export interface TeammateAgentsFacet {
  kind: "teammate-agents";
  target: {
    identity: {
      workspaceId: string;
      ownerId: string;
      ownerNonce: string;
      endpointId: string;
    };
  };
  revision: string;
  data: {
    agents: TeammateAgentState[];
    backgroundJobs: JsonValue[];
    contextPressure?: JsonValue;
  };
}

export type MonitorFacet = TeammateAgentsFacet;

/** Monitor 窗口状态 */
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
  /** 窗口 cwd（telemetry normalizedCwd；steer_window 接管路径需要） */
  cwd?: string;
  status: string;
  lifecycle: string;
  workStatus: string;
  todos: MonitorTodoSummary[];
  attention: MonitorAttentionSummary[];
  facets: MonitorFacet[];
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

/** 不含 id 的 ExtensionUiResponse 联合类型（分布式 Omit） */
export type DistributiveOmitUiResponse = 
  | { cancelled: true }
  | { cancelled?: false; value: string }
  | { cancelled?: false; confirmed: boolean }
  | { cancelled?: false; selected: string[] };

// ─────────────────────────────────────────────────────────────────────────────
// HostEvent — host 推送给客户端的统一事件流
// ─────────────────────────────────────────────────────────────────────────────

export type HostEvent =
  | { type: "host_status"; status: string; seq: number }
  | { type: "host_info"; info: HostStatus; seq: number }
  | { type: "session_updated"; session: SessionState; seq: number }
  /**
   * 消息终态投影：host 在 message_end 时按稳定 id 发出。
   * 客户端契约：若 timeline 中已存在相同 id 的条目则替换，否则追加。
   */
  | { type: "timeline_item"; sessionId: string; item: TimelineItem; seq: number }
  /**
   * 流式增量：message_update 期间按同一稳定 itemId 发出（可节流）。
   * 客户端契约：已存在该 id 的条目则追加文本；尚不存在时可忽略（终态由 timeline_item 补齐）。
   */
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
  | { type: "list_host_sessions"; cwd?: string; limit?: number; cursor?: string; query?: string; sessionIds?: string[]; latestForCwds?: string[] }
  | { type: "list_live_sessions" }
  | { type: "load_more_history"; sessionId: string; count?: number }
  | { type: "search_history"; sessionId: string; keyword: string; maxResults?: number; previewLength?: number }
  | { type: "list_models"; sessionId: string }
  | { type: "list_skills"; sessionId: string }
  | { type: "get_maestro_settings" }
  | { type: "update_maestro_settings"; key: string; patch: Record<string, unknown> }
  | { type: "set_model"; sessionId: string; modelId: string }
  | { type: "set_thinking"; sessionId: string; level: string }
  | { type: "compact"; sessionId: string; customInstructions?: string }
  | { type: "rename_session"; sessionId: string; name: string }
  | { type: "close_session"; sessionId: string }
  | { type: "list_sessions"; cwd?: string }
  | { type: "list_directories"; path: string }
  | { type: "prompt"; sessionId: string; message: string; images?: { data: string; mime: string }[] }
  | { type: "steer"; sessionId: string; message: string }
  | { type: "steer_window"; endpointId: string; cwd: string; message: string }
  | { type: "follow_up"; sessionId: string; message: string }
  | { type: "abort"; sessionId: string }
  | { type: "extension_ui_response"; sessionId: string; requestId: string; response: ExtensionUiResponse }
  | { type: "get_snapshot"; sessionId: string }
  | { type: "get_session_usage"; sessionId: string }
  | { type: "get_maestro_state" }
  | { type: "get_monitor_state" };

/** steer_window 结果（tookOver=true 表示窗口原先未打开，Host 已接管为受控会话） */
export interface SteerWindowResult {
  ok: boolean;
  sessionId: string;
  tookOver: boolean;
  error?: string;
}

/** 会话 token 用量（JSONL 聚合；entries=0 表示无 usage 数据） */
export interface SessionUsageSummary {
  sessionId: string;
  entries: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** input+output+cacheRead+cacheWrite+reasoning 之和（参考值，非独立增量） */
  totalTokens: number;
  /** 累计成本（美元；免费模型为 0） */
  cost: number;
  /** SDK 实时上下文用量（未流式响应或刚 compact 后可能为 null） */
  context: { tokens: number | null; contextWindow: number; percent: number | null } | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 宿主状态
// ─────────────────────────────────────────────────────────────────────────────

export interface HostStatus {
  ok: boolean;
  version: string;
  maestroDetected: boolean;
  maestroVersion?: string;
  /** Pi coding agent 版本（探测失败时不返回，UI 显示「待接入」） */
  piVersion?: string;
  /** pi-maestro-flow 扩展版本 */
  flowVersion?: string;
  /** Maestro CLI 版本 */
  maestroCliVersion?: string;
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
