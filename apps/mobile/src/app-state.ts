/**
 * AppState — 移动端全局状态 reducer
 *
 * 将 HostEvent 流投影为屏幕需要的状态：
 * - sessions: 会话列表
 * - maestroState: 调度仪表盘数据
 * - monitorState: 窗口监控数据
 * - dialogs: 待处理的 ask 弹窗（ExtensionUiQueue 管理）
 */
import type {
  HostEvent,
  MaestroState,
  MonitorState,
  SessionState,
  SessionPresentation,
  SessionSummaryPatch,
  SessionTargetIdentity,
  TimelineItem,
  ExtensionUiRequest,
  ExtensionUiResponse,
} from "@maestro-mobile/shared";
import { ExtensionUiQueue, type DialogEntry } from "./extension-ui-queue";
import { parseHostStatusMeta, type HostStatusMeta } from "./host-status";
import { sessionTargetKey } from "@maestro-mobile/shared";

export const MAX_SESSION_SUMMARY_PATCHES = 256;

export interface AppState {
  connectionStatus: string;
  /** host_status 对象载荷解析出的版本/maestro 检测元数据（设置页「版本与诊断」用；null = 待 Host 接入） */
  hostStatusMeta: HostStatusMeta | null;
  sessions: Map<string, SessionState>;
  /** Exact target currently loaded for each session screen. */
  activeSessionTargets: Map<string, string>;
  /** Targeted session projections retained separately so sibling endpoints cannot overwrite each other. */
  targetedSessions: Map<string, SessionState>;
  /** Latest exact-target card patches; retained so a later list load can apply them. */
  sessionSummaryPatches: Map<string, { target: SessionTargetIdentity; patch: SessionSummaryPatch; revision: number }>;
  timelines: Map<string, TimelineItem[]>;
  targetedTimelines: Map<string, TimelineItem[]>;
  maestro: MaestroState | null;
  monitor: MonitorState | null;
  dialogs: DialogEntry[];
  lastError: string | null;
  /** Latest Host-global wire sequence observed for each exact target. */
  targetEventSeq: Map<string, number>;
  /** Latest target wire event represented by SessionSnapshot session/timeline data. */
  targetProjectionEventSeq: Map<string, number>;
  /** Latest untargeted projection wire event for each session. */
  sessionProjectionEventSeq: Map<string, number>;
  /** Runner-local exclusive nextSeq retained only against snapshots from the same exact target/session. */
  snapshotNextSeq: Map<string, number>;
  /** Host-global exclusive watermark for the latest accepted snapshot of each target/session. */
  snapshotWireSeq: Map<string, number>;
  /** Latest Host-global wire sequence observed for untargeted events. */
  eventSeq: number;
  revision: number;
}

export function createInitialState(): AppState {
  return {
    connectionStatus: "disconnected",
    hostStatusMeta: null,
    sessions: new Map(),
    activeSessionTargets: new Map(),
    targetedSessions: new Map(),
    sessionSummaryPatches: new Map(),
    timelines: new Map(),
    targetedTimelines: new Map(),
    maestro: null,
    monitor: null,
    dialogs: [],
    lastError: null,
    targetEventSeq: new Map(),
    targetProjectionEventSeq: new Map(),
    sessionProjectionEventSeq: new Map(),
    snapshotNextSeq: new Map(),
    snapshotWireSeq: new Map(),
    eventSeq: 0,
    revision: 0,
  };
}

export interface AppStateDeps {
  dialogQueue?: ExtensionUiQueue;
}

/** 内部事件：批量替换 timeline（App 打开会话后拉取 snapshot 触发） */
export interface InternalEvent {
  type: "__history_load";
  sessionId: string;
  items: TimelineItem[];
  seq: number;
  target?: SessionTargetIdentity;
}

/** Atomic session snapshot from Host; nextSeq is exclusive (the next event number). */
export interface SnapshotLoadEvent {
  type: "__snapshot_load";
  session: SessionState;
  items: TimelineItem[];
  /** Runner-local exclusive nextSeq. */
  seq: number;
  /** Host-global exclusive event sequence sampled before the snapshot query. */
  wireSeq?: number;
  target?: SessionTargetIdentity;
}

/** 内部事件：向前追加更早的历史（懒加载翻页） */
export interface HistoryPrependEvent {
  type: "__history_prepend";
  sessionId: string;
  items: TimelineItem[];
  seq: number;
  target?: SessionTargetIdentity;
}

/** 内部事件：H4 微批 — 同一帧内的多个 HostEvent 顺序折叠为一次状态更新 */
export interface EventBatchEvent {
  type: "__event_batch";
  events: HostEvent[];
}

/**
 * 内部事件：弹窗应答发送失败（断连/连接丢失）。
 *
 * 为什么单独开一个本地类型而不复用 host 的 `error`（ISS-20260910 review F-002）：
 * `error` 是 HostEvent，`seq` 必填且属于 host 事件流序列；本地合成帧只能填 seq:0，
 * 一旦引入 seq 去重/回放过滤就会不一致。本类型不进入 HostEvent 域，语义上也不声称是 host 推的。
 *
 * 为什么需要它（F-001）：弹窗只在 extension_ui_request / extension_ui_cleared 时重投影，
 * 而 host 的 cleared 依赖它收到我们的响应 ⇒ 断连时响应永不会送达，弹窗既不消失
 * 也无错误提示（原 responder 的 .catch(() => undefined) 静默吞掉）。本事件同时负责
 * 把弹窗重新入队（保留用户已选答案）与提示错误。
 */
export interface DialogSendFailedEvent {
  type: "__dialog_send_failed";
  request: ExtensionUiRequest;
  message: string;
}

/**
 * 内部事件：客户端本地产生的错误提示（如断连导致命令被 settle）。
 *
 * 为什么不复用 host 的 `error`（ISS-20260910 review F-002）：`error` 属于 HostEvent 结合类型，
 * `seq` 为必填且语义上是 host 事件流序号；本地合成帧只能填占位 0，一旦引入 seq 去重/
 * 增量回放过滤就会与真 host 帧歧义。展示行为与 `error` 一致（写 lastError），但域分离。
 */
export interface LocalErrorEvent {
  type: "__local_error";
  message: string;
}

export interface RevisionEvent {
  type: "__revision";
  revision: number;
}

export interface ConnectionResetEvent {
  type: "__connection_reset";
}

/** reducer 可接受的全部 action：host 事件流 + 本地内部事件 */
export type AppAction =
  | HostEvent
  | InternalEvent
  | SnapshotLoadEvent
  | HistoryPrependEvent
  | EventBatchEvent
  | DialogSendFailedEvent
  | LocalErrorEvent
  | RevisionEvent
  | ConnectionResetEvent;

function revisionOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isSessionPresentation(value: unknown): value is SessionPresentation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const control = p.control;
  if (!control || typeof control !== "object" || Array.isArray(control)) return false;
  const c = control as Record<string, unknown>;
  return (p.role === "session" || p.role === "monitor")
    && (p.visibility === "session_list" || p.visibility === "monitor_tab" || p.visibility === "hidden")
    && revisionOf(p.revision) !== undefined
    && (c.mode === "host" || c.mode === "desktop_plugin" || c.mode === "readonly")
    && typeof c.canPrompt === "boolean" && typeof c.canSteer === "boolean"
    && typeof c.canFollowUp === "boolean" && typeof c.canAbort === "boolean"
    && typeof c.canAnswerAsk === "boolean";
}

function withRevision(state: AppState, revision: number | undefined): AppState {
  return revision !== undefined && revision > state.revision ? { ...state, revision } : state;
}

/** 纯 reducer：处理一个 HostEvent，返回新状态（不可变更新）
 * 额外支持内部事件 __history_load（批量替换 timeline）/ __event_batch（H4 微批）/ __dialog_send_failed */
export function reduceEvent(state: AppState, event: AppAction, deps: AppStateDeps = {}): AppState {
  if (event && (event as EventBatchEvent).type === "__event_batch") {
    let s = state;
    for (const e of (event as EventBatchEvent).events) {
      s = reduceEvent(s, e, deps);
    }
    return s;
  }
  if (event.type === "__snapshot_load") {
    // Snapshot nextSeq belongs to the selected runner. It must never be compared with
    // Host-global wire event seq, even when both values happen to be numeric.
    const targetKey = event.target ? sessionTargetKey(event.target) : undefined;
    const snapshotKey = targetKey ? `target:${targetKey}` : `session:${event.session.id}`;
    const previousSnapshotNextSeq = state.snapshotNextSeq.get(snapshotKey) ?? 0;
    const previousSnapshotWireSeq = state.snapshotWireSeq.get(snapshotKey) ?? 0;
    if (event.seq > 0 && event.seq < previousSnapshotNextSeq) return state;
    if (event.seq > 0 && event.seq === previousSnapshotNextSeq
      && (event.wireSeq === undefined || event.wireSeq <= previousSnapshotWireSeq)) return state;
    if (event.seq === 0 && event.wireSeq !== undefined && event.wireSeq <= previousSnapshotWireSeq) return state;
    const seenWireSeq = targetKey
      ? (state.targetProjectionEventSeq.get(targetKey) ?? 0)
      : (state.sessionProjectionEventSeq.get(event.session.id) ?? 0);
    if (event.wireSeq !== undefined && event.wireSeq > 0 && event.wireSeq <= seenWireSeq) return state;
    // A legacy readerless snapshot has no runner or wire ordering authority. Once a live
    // projection exists, keep it instead of replacing it with an unordered readonly view.
    if (event.seq === 0 && event.wireSeq === undefined
      && (targetKey ? state.targetEventSeq.has(targetKey) : state.sessions.has(event.session.id))) return state;
    const sessions = new Map(state.sessions);
    sessions.set(event.session.id, event.session);
    const targetedSessions = new Map(state.targetedSessions);
    const activeSessionTargets = new Map(state.activeSessionTargets);
    const timelines = new Map(state.timelines);
    const targetedTimelines = new Map(state.targetedTimelines);
    const targetEventSeq = new Map(state.targetEventSeq);
    const snapshotNextSeq = new Map(state.snapshotNextSeq);
    const snapshotWireSeq = new Map(state.snapshotWireSeq);
    const items = event.items.length > 0 ? event.items : [];
    if (targetKey) {
      targetedSessions.set(targetKey, event.session);
      activeSessionTargets.set(event.session.id, targetKey);
      targetedTimelines.set(targetKey, items);
    } else {
      timelines.set(event.session.id, items);
    }
    if (event.seq > 0) snapshotNextSeq.set(snapshotKey, event.seq);
    if (event.wireSeq !== undefined) snapshotWireSeq.set(snapshotKey, event.wireSeq);
    return {
      ...state,
      sessions,
      activeSessionTargets,
      targetedSessions,
      timelines,
      targetedTimelines,
      targetEventSeq,
      snapshotNextSeq,
      snapshotWireSeq,
    };
  }
  const eventSeq = "seq" in event && typeof event.seq === "number" ? event.seq : undefined;
  const targetKey = "target" in event && event.target ? sessionTargetKey(event.target) : undefined;
  const projectionSessionId = event.type === "session_updated"
    ? event.session.id
    : event.type === "timeline_item" || event.type === "timeline_snapshot" || event.type === "timeline_delta"
      ? event.sessionId
      : undefined;
  const previousTargetSeq = targetKey ? (state.targetEventSeq.get(targetKey) ?? 0) : state.eventSeq;
  if (eventSeq !== undefined && eventSeq > 0 && eventSeq <= previousTargetSeq) return state;
  if (targetKey && eventSeq !== undefined && eventSeq > previousTargetSeq) {
    const targetEventSeq = new Map(state.targetEventSeq);
    targetEventSeq.set(targetKey, eventSeq);
    if (projectionSessionId) {
      const targetProjectionEventSeq = new Map(state.targetProjectionEventSeq);
      targetProjectionEventSeq.set(targetKey, eventSeq);
      state = { ...state, targetEventSeq, targetProjectionEventSeq };
    } else {
      state = { ...state, targetEventSeq };
    }
  } else if (!targetKey && eventSeq !== undefined && eventSeq > state.eventSeq) {
    if (projectionSessionId) {
      const sessionProjectionEventSeq = new Map(state.sessionProjectionEventSeq);
      sessionProjectionEventSeq.set(projectionSessionId, eventSeq);
      state = { ...state, eventSeq, sessionProjectionEventSeq };
    } else {
      state = { ...state, eventSeq };
    }
  }
  const queue = deps.dialogQueue;
  if (event.type === "__connection_reset") {
    queue?.clearAll();
    const fresh = createInitialState();
    return { ...fresh, connectionStatus: state.connectionStatus };
  }
  if (event.type === "__revision") {
    return withRevision(state, revisionOf(event.revision));
  }
  if (event.type === "__dialog_send_failed") {
    // 恢复弹窗使用户已选答案不丢，同时写 lastError（否则从用户视角看是「点了没反应」）。
    // reopen 而非 enqueue：保留原 receivedAt，且已过期/已被修剪时不恢复（S_CONFIRM 回归修正）。
    const reopened = queue ? queue.reopen(event.request) : false;
    const dialogs = queue ? queue.pendingDialogs : state.dialogs;
    const suffix = reopened ? "" : "（该 ask 已超时或已清理，无需重试）";
    return { ...state, dialogs, lastError: `${event.message}${suffix}` };
  }
  if (event.type === "__history_load") {
    if (event.target) {
      const key = sessionTargetKey(event.target);
      const targetedTimelines = new Map(state.targetedTimelines);
      targetedTimelines.set(key, event.items.length > 0 ? event.items : []);
      return { ...state, targetedTimelines };
    }
    const timelines = new Map(state.timelines);
    timelines.set(event.sessionId, event.items.length > 0 ? event.items : []);
    return { ...state, timelines };
  }
  if (event.type === "__history_prepend") {
    const key = event.target ? sessionTargetKey(event.target) : undefined;
    const source = key ? state.targetedTimelines : state.timelines;
    const existing = (key ? source.get(key) : source.get(event.sessionId)) ?? [];
    const existingIds = new Set(existing.map((t) => t.id));
    const fresh = event.items.filter((t) => !existingIds.has(t.id));
    if (key) {
      const targetedTimelines = new Map(state.targetedTimelines);
      targetedTimelines.set(key, [...fresh, ...existing]);
      return { ...state, targetedTimelines };
    }
    const timelines = new Map(state.timelines);
    timelines.set(event.sessionId, [...fresh, ...existing]);
    return { ...state, timelines };
  }
  switch (event.type) {
    case "host_status": {
      const meta = parseHostStatusMeta(event.status);
      return {
        ...state,
        connectionStatus: typeof event.status === "string" ? event.status : state.connectionStatus,
        // 对象载荷（Host 首次连接推送 getStatus()）→ 提取版本元数据；字符串载荷不改元数据
        ...(meta ? { hostStatusMeta: meta } : null),
      };
    }

    case "host_info": {
      // Host 连接后独立推送 getStatus() 元数据；与 host_status 的对象载荷同一解析路径
      const meta = parseHostStatusMeta(event.info);
      return meta ? { ...state, hostStatusMeta: meta } : state;
    }

    case "session_summary_updated": {
      const key = sessionTargetKey(event.target);
      const currentSummary = state.sessionSummaryPatches.get(key);
      if (currentSummary && currentSummary.revision >= event.revision) return state;
      const sessionSummaryPatches = new Map(state.sessionSummaryPatches);
      // A reset starts a new projection epoch. Do not carry usage/context/messageCount
      // from the previous runtime into the terminal/reset patch; subsequent patches may
      // add fresh values back to this same target.
      const patch = event.patch.reset
        ? event.patch
        : currentSummary
          ? { ...currentSummary.patch, ...event.patch }
          : event.patch;
      sessionSummaryPatches.set(key, {
        target: event.target,
        patch,
        revision: event.revision,
      });
      while (sessionSummaryPatches.size > MAX_SESSION_SUMMARY_PATCHES) {
        const oldest = sessionSummaryPatches.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        sessionSummaryPatches.delete(oldest);
      }
      let nextState = withRevision({ ...state, sessionSummaryPatches }, event.revision);
      const activeTarget = nextState.activeSessionTargets.get(event.target.sessionId);
      const currentSession = nextState.targetedSessions.get(key)
        ?? (activeTarget === key ? nextState.sessions.get(event.target.sessionId) : undefined);
      if (!currentSession) return nextState;

      const session: SessionState = { ...currentSession };
      if (patch.runtimeStatus !== undefined) {
        session.runState = patch.runtimeStatus === "running" ? "streaming" : "idle";
      }
      if ((!event.patch.reset || event.patch.messageCount !== undefined) && patch.messageCount !== undefined) {
        session.messageCount = patch.messageCount;
      }
      if (patch.lastActivityAt !== undefined) session.updatedAt = patch.lastActivityAt;

      const targetedSessions = new Map(nextState.targetedSessions);
      targetedSessions.set(key, session);
      const sessions = new Map(nextState.sessions);
      if (nextState.activeSessionTargets.get(event.target.sessionId) === key || !sessions.has(event.target.sessionId)) {
        sessions.set(event.target.sessionId, session);
      }
      nextState = { ...nextState, sessions, targetedSessions };
      return nextState;
    }

    case "session_updated": {
      const targetKey = event.target ? sessionTargetKey(event.target) : undefined;
      const targeted = targetKey !== undefined;
      const current = targeted
        ? state.targetedSessions.get(targetKey)
        : state.sessions.get(event.session.id);
      const incomingPresentation = isSessionPresentation(event.session.presentation)
        ? event.session.presentation
        : undefined;
      const currentRevision = revisionOf(current?.presentation?.revision);
      const incomingRevision = revisionOf(incomingPresentation?.revision);
      // A delayed update must not replace a newer server projection for this session.
      if (current && currentRevision !== undefined && incomingRevision !== undefined && incomingRevision < currentRevision) {
        return withRevision(state, incomingRevision);
      }
      const session = incomingPresentation
        ? { ...event.session, presentation: incomingPresentation }
        : current?.presentation
          ? { ...event.session, presentation: current.presentation }
          : (() => {
              const { presentation: _ignored, ...withoutPresentation } = event.session;
              return withoutPresentation as SessionState;
            })();
      if (targeted && state.activeSessionTargets.get(event.session.id) !== targetKey) {
        const targetedSessions = new Map(state.targetedSessions);
        targetedSessions.set(targetKey, session);
        return withRevision({ ...state, targetedSessions }, incomingRevision);
      }
      const sessions = new Map(state.sessions);
      sessions.set(event.session.id, session);
      if (targetKey) {
        const targetedSessions = new Map(state.targetedSessions);
        targetedSessions.set(targetKey, session);
        return withRevision({ ...state, sessions, targetedSessions }, incomingRevision);
      }
      return withRevision({ ...state, sessions }, incomingRevision);
    }

    case "timeline_item": {
      const key = event.target ? sessionTargetKey(event.target) : undefined;
      const timelines = key ? new Map(state.targetedTimelines) : new Map(state.timelines);
      const items = (key ? timelines.get(key) : timelines.get(event.sessionId)) ?? [];
      const idx = items.findIndex((t) => t.id === event.item.id);
      const next = idx >= 0
        ? items.map((t, i) => (i === idx ? event.item : t))
        : (() => {
            const last = items[items.length - 1];
            if (last && last.kind === event.item.kind && last.text === event.item.text && event.item.kind === "user") {
              return [...items.slice(0, -1), event.item];
            }
            return [...items, event.item];
          })();
      timelines.set(key ?? event.sessionId, next);
      return key ? { ...state, targetedTimelines: timelines } : { ...state, timelines };
    }

    case "timeline_snapshot": {
      const key = event.target ? sessionTargetKey(event.target) : undefined;
      if (key) {
        const targetedTimelines = new Map(state.targetedTimelines);
        targetedTimelines.set(key, event.items);
        return { ...state, targetedTimelines };
      }
      const timelines = new Map(state.timelines);
      timelines.set(event.sessionId, event.items);
      return { ...state, timelines };
    }

    case "timeline_delta": {
      const key = event.target ? sessionTargetKey(event.target) : undefined;
      const timelines = key ? new Map(state.targetedTimelines) : new Map(state.timelines);
      const items = (key ? timelines.get(key) : timelines.get(event.sessionId)) ?? [];
      const idx = items.findIndex((item) => item.id === event.itemId);
      if (idx < 0) return state;
      const updated = items.slice();
      updated[idx] = { ...updated[idx], text: updated[idx].text + event.delta };
      timelines.set(key ?? event.sessionId, updated);
      return key ? { ...state, targetedTimelines: timelines } : { ...state, timelines };
    }

    case "maestro_state":
      return { ...state, maestro: event.state };

    case "monitor_state": {
      const revision = revisionOf(event.state.revision);
      const monitor = revision !== undefined && state.monitor?.revision !== undefined && revision < state.monitor.revision
        ? state.monitor
        : { ...event.state, windows: event.state.windows.filter((window) => window.presentation?.visibility === "monitor_tab") };
      return withRevision({ ...state, monitor }, revision);
    }

    case "extension_ui_request": {
      if (!queue) return state;
      queue.enqueue(event.request, event.target);
      const overflowed = queue.takeOverflowed();
      return {
        ...state,
        dialogs: queue.pendingDialogs,
        ...(overflowed.length > 0 ? { lastError: `Too many pending extension UI requests; expired ${overflowed.length} oldest request(s)` } : {}),
      };
    }

    case "extension_ui_cleared": {
      if (!queue) return state;
      // 必须真正出队（而非只过滤投影数组）：host 已应答/超时/取消的 ask 如果仍留在队列里，
      // 后续一次失败的 resend 就能把它 reopen 回来（S_CONFIRM RV-001）。
      queue.drop(event.requestId, event.target);
      return { ...state, dialogs: queue.pendingDialogs };
    }

    case "command_error":
    case "error":
      return { ...state, lastError: event.message };

    case "__local_error":
      return { ...state, lastError: event.message };

    default:
      return state;
  }
}

export interface AppActions {
  answerDialog(requestId: string, value: string | string[]): void;
  cancelDialog(requestId: string): void;
}

export function createAppActions(
  queue: ExtensionUiQueue,
  responder: (
    sessionId: string,
    requestId: string,
    /** buildDialogResponse 的产物必为 ExtensionUiResponse（protocol.ts:298-302）。
     *  之前声明为 unknown 使调用点不得不 `as never` 强转（S_CONFIRM 指出属未完成的类型清理）。 */
    response: ExtensionUiResponse,
    /** 原 request：发送失败时由调用方交给 reducer 重新入队（ISS-20260910 review F-001） */
    request: ExtensionUiRequest,
    target?: SessionTargetIdentity,
  ) => void,
): AppActions {
  return {
    answerDialog(requestId, value) {
      const entry = queue.get(requestId);
      if (!entry) return;
      const response = buildDialogResponse(queue, requestId, value);
      if (response) {
        responder(entry.request.sessionId, requestId, response, entry.request, entry.target);
      }
    },
    cancelDialog(requestId) {
      const entry = queue.get(requestId);
      if (!entry) return;
      const response = queue.cancel(requestId);
      if (response) {
        responder(entry.request.sessionId, requestId, response, entry.request, entry.target);
      }
    },
  };
}

/**
 * 按请求方法构造响应（P1-2）：
 * - confirm：sendConfirmation 约定 "confirmed:true"/"confirmed:false"，
 *   转 { confirmed: bool }（host 端 mobile-ui-context.ts 只认 confirmed 字段；
 *   发 { value: "yes" } 会被解析成 false —— 语义反转缺陷）
 * - 其他：数组 → selected，字符串 → value（与 select/input//editor 的 host 解析器一致）
 */
export const CONFIRM_TRUE = "confirmed:true";
export const CONFIRM_FALSE = "confirmed:false";

function buildDialogResponse(
  queue: ExtensionUiQueue,
  requestId: string,
  value: string | string[],
): ExtensionUiResponse | undefined {
  const entry = queue.get(requestId);
  if (!entry) return undefined;
  if (entry.request.method === "confirm" && typeof value === "string") {
    if (value === CONFIRM_TRUE || value === CONFIRM_FALSE) {
      return queue.answer(requestId, { confirmed: value === CONFIRM_TRUE });
    }
    return queue.answer(requestId, { confirmed: value === "yes" });
  }
  if (Array.isArray(value)) {
    return queue.answer(requestId, { selected: value as string[] });
  }
  return queue.answer(requestId, { value: value as string });
}